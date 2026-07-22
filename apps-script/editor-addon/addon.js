// Editor Add-on: adds "Translation Review" menu to translation output docs.
//
// The Translate Cloud Run function sets the "usdr_translation_review" property
// on the Drive file via the Drive API v3 `properties` field. This add-on reads
// it using the Advanced Drive Service (Drive API v3), NOT PropertiesService
// (which is a separate, Apps Script-only storage layer).

var HTTP_OK = 200;
var DOC_PROPERTY_KEY = "usdr_translation_review";
var SIDEBAR_CHECKS_KEY = "SIDEBAR_CHECKS";
var SIDEBAR_OPENED_AT_KEY = "SIDEBAR_OPENED_AT";
var HIGHLIGHT_COLOR = "#FFD700";

// ── Drive property access ────────────────────────────────────────────────

/**
 * Look up the translation JSON file ID from the active document's Drive
 * file properties. The Translate function sets this when creating the doc.
 * Uses the Drive API v3 Advanced Service (not PropertiesService).
 * @returns {string|null} Drive file ID of the translation JSON, or null
 */
function getTranslationFileId_() {
  var docId = DocumentApp.getActiveDocument().getId();
  try {
    var file = Drive.Files.get(docId, { fields: "properties", supportsAllDrives: true });
    return (file.properties && file.properties[DOC_PROPERTY_KEY]) || null;
  } catch (e) {
    Logger.log("Could not read Drive file properties: " + e.message);
    return null;
  }
}

// ── Translation JSON from Drive ──────────────────────────────────────────

/**
 * Fetch and parse the translation JSON from Drive.
 * @returns {Object|null} Parsed translation JSON with blocks, metadata, etc.
 */
function getTranslationJson_() {
  var fileId = getTranslationFileId_();
  if (!fileId) return null;
  try {
    var content = Drive.Files.get(fileId, {
      alt: "media",
      supportsAllDrives: true,
    });
    return typeof content === "string" ? JSON.parse(content) : content;
  } catch (e) {
    Logger.log("Could not fetch translation JSON: " + e.message);
    return null;
  }
}

// ── Sidebar data ─────────────────────────────────────────────────────────

/**
 * Build the data payload for the sidebar UI. Flattens per-block metadata
 * items (alt_translations, terms_flagged, etc.) into flat arrays with a
 * sequential index per section. Each item gets a block_id and block_index
 * appended so the sidebar can map back to the document table.
 *
 * The flattening order must match buildSidebarKeyToBlockMap() in the
 * Capture Feedback function — both produce "section::flatIndex" keys.
 *
 * @returns {{ data: Object|null, checks: Object }} Sidebar payload and
 *   persisted review state ({ status, flagged })
 */
function getSidebarData() {
  var json = getTranslationJson_();
  if (!json) return { data: null, checks: {} };

  var blocks = json.blocks || [];
  var sections = {
    alt_translations: [],
    terms_flagged_for_clarification: [],
    back_translation_of_key_phrases: [],
    glossary_cross_check: [],
  };

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var blockId = block.id || "b" + (i + 1);

    var sectionKeys = [
      "alt_translations",
      "terms_flagged_for_clarification",
      "back_translation_of_key_phrases",
      "glossary_cross_check",
    ];

    for (var s = 0; s < sectionKeys.length; s++) {
      var key = sectionKeys[s];
      var items = block[key] || [];
      for (var j = 0; j < items.length; j++) {
        var item = {};
        var keys = Object.keys(items[j]);
        for (var k = 0; k < keys.length; k++) {
          item[keys[k]] = items[j][keys[k]];
        }
        item.block_id = blockId;
        item.block_index = i;
        sections[key].push(item);
      }
    }
  }

  var rawChecks = PropertiesService.getDocumentProperties().getProperty(SIDEBAR_CHECKS_KEY);

  return {
    data: {
      alt_translations: sections.alt_translations,
      terms_flagged_for_clarification: sections.terms_flagged_for_clarification,
      back_translation_of_key_phrases: sections.back_translation_of_key_phrases,
      glossary_cross_check: sections.glossary_cross_check,
      metadata: json.metadata || null,
    },
    checks: rawChecks ? JSON.parse(rawChecks) : {},
  };
}

/**
 * Persist the sidebar's review state to document properties.
 * Called by the sidebar on a debounced timer after each status change.
 * @param {Object} checks - { status: { key: status }, flagged: { key: true } }
 */
function saveSidebarChecks(checks) {
  PropertiesService.getDocumentProperties()
    .setProperty(SIDEBAR_CHECKS_KEY, JSON.stringify(checks || {}));
  return true;
}

// ── Highlighting ─────────────────────────────────────────────────────────

/**
 * Find the first table element in the document body.
 * Translation output docs have a single two-column table (English | Spanish).
 * @param {GoogleAppsScript.Document.Body} [body] - Document body, defaults to active doc
 * @returns {GoogleAppsScript.Document.Table|null}
 */
function getFirstTable_(body) {
  body = body || DocumentApp.getActiveDocument().getBody();
  for (var i = 0; i < body.getNumChildren(); i++) {
    if (body.getChild(i).getType() === DocumentApp.ElementType.TABLE) {
      return body.getChild(i).asTable();
    }
  }
  return null;
}

function escapeRegex_(str) {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function escapeReplacement_(str) {
  return str.replace(/\$/g, '$$$$');
}

/**
 * Set background color on all occurrences of needle within a table cell.
 * Pass null for color to clear highlighting.
 * @param {GoogleAppsScript.Document.TableCell} cell
 * @param {string} needle - Text to find and highlight
 * @param {string|null} color - Hex color or null to clear
 * @returns {boolean} Whether any occurrence was found
 */
function paintInCell_(cell, needle, color) {
  var found = false;
  for (var p = 0; p < cell.getNumChildren(); p++) {
    var child = cell.getChild(p);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var textEl = child.asText();
      var content = textEl.getText();
      var idx = content.indexOf(needle);
      while (idx !== -1) {
        textEl.setBackgroundColor(idx, idx + needle.length - 1, color);
        found = true;
        idx = content.indexOf(needle, idx + 1);
      }
    }
  }
  return found;
}

function findInCell_(cell, needle) {
  for (var p = 0; p < cell.getNumChildren(); p++) {
    var child = cell.getChild(p);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var content = child.asText().getText();
      var idx = content.indexOf(needle);
      if (idx !== -1) {
        return { textEl: child.asText(), start: idx, end: idx + needle.length - 1 };
      }
    }
  }
  return null;
}

/**
 * Highlight an original phrase and its translation in the document table.
 * Called by the sidebar when the reviewer clicks a review card or reference row.
 * Searches all content rows (skipping the header) and sets the cursor to
 * the first match in the English column.
 * @param {string} originalText - English phrase to highlight
 * @param {string} translationText - Spanish phrase to highlight
 * @returns {{ original: string, translation: string }} "found" or "not_found" per column
 */
function paintHighlight(originalText, translationText) {
  var table = getFirstTable_();
  var result = { original: "not_found", translation: "not_found" };
  if (!table || table.getNumRows() < 2) return result;

  var origTrimmed = (originalText || "").trim();
  var transTrimmed = (translationText || "").trim();

  // Search all content rows (skip header at row 0)
  for (var row = 1; row < table.getNumRows(); row++) {
    var engCell = table.getRow(row).getCell(0);
    var spaCell = table.getRow(row).getCell(1);

    if (origTrimmed && result.original === "not_found") {
      if (paintInCell_(engCell, origTrimmed, HIGHLIGHT_COLOR)) {
        result.original = "found";
        var hit = findInCell_(engCell, origTrimmed);
        if (hit) {
          try {
            var doc = DocumentApp.getActiveDocument();
            doc.setSelection(doc.newRange().addElement(hit.textEl, hit.start, hit.end).build());
          } catch (e) { /* non-fatal */ }
        }
      }
    }

    if (transTrimmed && result.translation === "not_found") {
      if (paintInCell_(spaCell, transTrimmed, HIGHLIGHT_COLOR)) {
        result.translation = "found";
      }
    }
  }

  return result;
}

/**
 * Remove highlighting for a specific phrase pair across all table rows.
 * @param {string} originalText - English phrase to un-highlight
 * @param {string} translationText - Spanish phrase to un-highlight
 */
function clearHighlight(originalText, translationText) {
  var table = getFirstTable_();
  if (!table || table.getNumRows() < 2) return;

  var origTrimmed = (originalText || "").trim();
  var transTrimmed = (translationText || "").trim();

  for (var row = 1; row < table.getNumRows(); row++) {
    if (origTrimmed) paintInCell_(table.getRow(row).getCell(0), origTrimmed, null);
    if (transTrimmed) paintInCell_(table.getRow(row).getCell(1), transTrimmed, null);
  }
}

/**
 * Remove all gold highlighting from every cell in the translation table.
 * Called when the sidebar opens and when it closes.
 */
function clearAllHighlights() {
  var table = getFirstTable_();
  if (!table) return;
  for (var row = 1; row < table.getNumRows(); row++) {
    for (var col = 0; col < 2; col++) {
      var cell = table.getRow(row).getCell(col);
      for (var p = 0; p < cell.getNumChildren(); p++) {
        var child = cell.getChild(p);
        if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
          var text = child.asText();
          var len = text.getText().length;
          if (len > 0) text.setBackgroundColor(0, len - 1, null);
        }
      }
    }
  }
}

// ── Orphan / highlight availability checks ───────────────────────────────

/**
 * Extract all text from the translation table, separated by column.
 * Used by the sidebar to check which items can be highlighted, and by
 * checkItemsExist() to detect orphans.
 * @returns {{ english: string, spanish: string }}
 */
function getDocTextForHighlightCheck() {
  var table = getFirstTable_();
  if (!table || table.getNumRows() < 2) return { english: "", spanish: "" };

  var english = [];
  var spanish = [];
  for (var row = 1; row < table.getNumRows(); row++) {
    english.push(table.getRow(row).getCell(0).getText());
    spanish.push(table.getRow(row).getCell(1).getText());
  }
  return { english: english.join("\n"), spanish: spanish.join("\n") };
}

/**
 * Generate a lightweight hash of the document text to detect edits.
 * Returns "hash:length" so the sidebar can tell if the doc changed.
 * @returns {string}
 */
function getDocEditToken() {
  var text = DocumentApp.getActiveDocument().getBody().getText();
  var hash = 0;
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash + ":" + text.length;
}

/**
 * Check which reviewable items are "orphans" — their original or translated
 * text no longer appears in the document, meaning the reviewer edited it.
 * Orphan status is sent to Capture Feedback and used to distinguish signals
 * like "accepted_then_changed" vs. "accepted".
 * @returns {Object} Map of "section::index" -> true for orphaned items
 */
function checkItemsExist() {
  var res = getSidebarData();
  if (!res || !res.data) return {};

  var docText = getDocTextForHighlightCheck();
  var english = (docText.english || "").normalize("NFC");
  var spanish = (docText.spanish || "").normalize("NFC");
  var orphans = {};

  var sectionKeys = [
    "alt_translations",
    "terms_flagged_for_clarification",
    "back_translation_of_key_phrases",
  ];

  for (var s = 0; s < sectionKeys.length; s++) {
    var key = sectionKeys[s];
    var items = res.data[key] || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var origPhrase = (item.original_phrase || item.original_text || "").trim();
      var transPhrase = (item.primary_translation || item.translation || "").trim();

      var origMissing = origPhrase && english.indexOf(origPhrase.normalize("NFC")) === -1;
      var transMissing = transPhrase && spanish.indexOf(transPhrase.normalize("NFC")) === -1;

      if (origMissing || transMissing) {
        orphans[key + "::" + i] = true;
      }
    }
  }

  return orphans;
}

// ── Prompt URL persistence ──────────────────────────────────────────────

var PROMPT_URL_KEY = "PROMPT_URL";
var RUBRIC_URL_KEY = "RUBRIC_URL";

function setPromptUrl(url) {
  PropertiesService.getDocumentProperties().setProperty(PROMPT_URL_KEY, url);
}

function getPromptUrl() {
  return PropertiesService.getDocumentProperties().getProperty(PROMPT_URL_KEY) || "";
}

function setRubricUrl(url) {
  PropertiesService.getDocumentProperties().setProperty(RUBRIC_URL_KEY, url);
}

function getRubricUrl() {
  return PropertiesService.getDocumentProperties().getProperty(RUBRIC_URL_KEY) || "";
}

// ── Sidebar actions ─────────────────────────────────────────────────────

/**
 * Replace text in a single table cell using Apps Script's replaceText().
 * Only calls replaceText if the cell actually contains currentText
 * (avoids silent no-ops from regex mismatches).
 * @param {GoogleAppsScript.Document.TableCell} cell
 * @param {string} currentText - Literal text to look for
 * @param {string} pattern - Regex-escaped version of currentText
 * @param {string} replacement - Replacement string (with $ escaped)
 * @returns {number} Number of occurrences found
 */
function replaceInCell_(cell, currentText, pattern, replacement) {
  var cellText = cell.getText();
  var count = cellText.split(currentText).length - 1;
  if (count > 0) {
    cell.replaceText(pattern, replacement);
  }
  return count;
}

/**
 * Replace a translation phrase in the document with an alternative.
 * Called by the sidebar's "Use alternative" button.
 *
 * Strategy: tries the exact table row first (blockIndex + 1, since row 0
 * is the header), then falls back to searching all rows. Falls back to a
 * full-body search if no table is found.
 *
 * @param {string} currentText - The current translation text to replace
 * @param {string} altText - The alternative translation to insert
 * @param {number} blockIndex - Zero-based block index from getSidebarData()
 * @returns {{ replaced: boolean, count: number }}
 */
function replaceTranslationInDoc(currentText, altText, blockIndex) {
  var result = { replaced: false, count: 0 };

  currentText = (currentText || '').trim();
  altText     = (altText || '').trim();
  if (!currentText || !altText || currentText === altText) return result;

  var doc   = DocumentApp.getActiveDocument();
  var body  = doc.getBody();
  var table = getFirstTable_(body);

  var pattern     = escapeRegex_(currentText);
  var replacement = escapeReplacement_(altText);

  if (table && table.getNumRows() >= 2) {
    var targetRow = (typeof blockIndex === 'number') ? blockIndex + 1 : -1;
    if (targetRow >= 1 && targetRow < table.getNumRows()) {
      var count = replaceInCell_(table.getRow(targetRow).getCell(1), currentText, pattern, replacement);
      if (count > 0) {
        result.replaced = true;
        result.count = count;
      }
    }

    if (!result.replaced) {
      for (var row = 1; row < table.getNumRows(); row++) {
        var count = replaceInCell_(table.getRow(row).getCell(1), currentText, pattern, replacement);
        if (count > 0) {
          result.replaced = true;
          result.count += count;
        }
      }
    }
  } else {
    var bodyText = body.getText();
    var count = bodyText.split(currentText).length - 1;
    if (count > 0) {
      body.replaceText(pattern, replacement);
      result.replaced = true;
      result.count = count;
    }
  }

  if (result.replaced) {
    try { clearHighlight('', currentText); } catch (e) { /* non-fatal */ }
  }

  return result;
}

function regenerateSuggestions() {
  return { problem: "not_implemented", message: "Regeneration is not yet available." };
}

function generateReviewDocx() {
  return null;
}

function getEvalData() {
  return null;
}

function evaluateTranslationFromSidebar() {
  return { problem: "not_implemented", message: "Evaluation is not yet available." };
}

// ── Menu and sidebar ─────────────────────────────────────────────────────

/**
 * Simple trigger — runs in AuthMode.NONE for published add-ons,
 * so it can only build menus (no Drive/Docs API calls).
 */
function onOpen(e) {
  DocumentApp.getUi()
    .createAddonMenu()
    .addItem("Show AI Suggestions", "showReviewPanel")
    .addItem("Submit Review", "submitReview")
    .addToUi();
}

/**
 * Open the AI Suggestions sidebar. Records the first-open timestamp
 * for time-to-approve tracking (only set once per document — persists
 * across reopens to measure total engagement time).
 */
function showReviewPanel() {
  var translationFileId = getTranslationFileId_();
  if (!translationFileId) {
    DocumentApp.getUi().alert(
      "Not a Translation Document",
      "This document does not have translation data associated with it.",
      DocumentApp.getUi().ButtonSet.OK
    );
    return;
  }

  var props = PropertiesService.getDocumentProperties();
  if (!props.getProperty(SIDEBAR_OPENED_AT_KEY)) {
    props.setProperty(SIDEBAR_OPENED_AT_KEY, new Date().toISOString());
  }

  clearAllHighlights();
  var html = HtmlService.createHtmlOutputFromFile("Sidebar")
    .setTitle("AI Suggestions")
    .setWidth(340);
  DocumentApp.getUi().showSidebar(html);
}

// Temporary — returns the submit payload as a string for sidebar debug button.
// Remove before release.
function debugGetSubmitPayload() {
  var doc = DocumentApp.getActiveDocument();
  var props = PropertiesService.getDocumentProperties();

  var rawChecks = props.getProperty(SIDEBAR_CHECKS_KEY);
  var sidebarChecks = rawChecks ? JSON.parse(rawChecks) : {};
  var sidebarOrphans = checkItemsExist();
  var sidebarOpenedAt = props.getProperty(SIDEBAR_OPENED_AT_KEY) || null;

  return JSON.stringify({
    documentId: doc.getId(),
    sidebarChecks: sidebarChecks,
    sidebarOrphans: sidebarOrphans,
    sidebarOpenedAt: sidebarOpenedAt,
  }, null, 2);
}

/**
 * Submit the reviewer's edits to the Capture Feedback Cloud Run function.
 * Gathers sidebar state (status, flagged, orphans) and the sidebar-open
 * timestamp, sends them along with the document ID, and displays the
 * result (number of terminology decisions captured).
 *
 * Authenticates with Cloud Run using an identity token from
 * ScriptApp.getIdentityToken().
 */
function submitReview() {
  var doc = DocumentApp.getActiveDocument();
  var ui = DocumentApp.getUi();

  var translationFileId = getTranslationFileId_();
  if (!translationFileId) {
    ui.alert(
      "Not a Translation Document",
      "This document does not have translation data associated with it.",
      ui.ButtonSet.OK
    );
    return;
  }

  var confirm = ui.alert(
    "Submit Review",
    "This will submit your edits as translation feedback. Continue?",
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) return;

  var props = PropertiesService.getDocumentProperties();
  var rawChecks = props.getProperty(SIDEBAR_CHECKS_KEY);
  var sidebarChecks = rawChecks ? JSON.parse(rawChecks) : {};
  var sidebarOrphans = checkItemsExist();
  var sidebarOpenedAt = props.getProperty(SIDEBAR_OPENED_AT_KEY) || null;

  var captureFeedbackUrl = PropertiesService.getScriptProperties().getProperty("CAPTURE_FEEDBACK_FUNCTION_URL");
  if (!captureFeedbackUrl) {
    ui.alert("Configuration Error", "Capture feedback URL is not configured.", ui.ButtonSet.OK);
    return;
  }

  var token = ScriptApp.getIdentityToken();
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      documentId: doc.getId(),
      sidebarChecks: sidebarChecks,
      sidebarOrphans: sidebarOrphans,
      sidebarOpenedAt: sidebarOpenedAt,
    }),
    muteHttpExceptions: true,
  };

  var response;
  try {
    response = UrlFetchApp.fetch(captureFeedbackUrl, options);
  } catch (e) {
    ui.alert("Network Error", "Could not reach the feedback service: " + e.message, ui.ButtonSet.OK);
    return;
  }

  var result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (e) {
    ui.alert("Error", "Unexpected response from feedback service:\n" + response.getContentText().substring(0, 500), ui.ButtonSet.OK);
    return;
  }

  if (response.getResponseCode() === HTTP_OK) {
    var msg = "Review submitted successfully. " + (result.decisions || []).length + " terminology decisions captured.";
    if (result.warnings && result.warnings.length) {
      msg += "\n\nWarnings:\n" + result.warnings.join("\n");
    }
    ui.alert(msg);
  } else {
    ui.alert("Error submitting review: " + response.getContentText());
  }
}
