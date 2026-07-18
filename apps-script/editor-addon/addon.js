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

function saveSidebarChecks(checks) {
  PropertiesService.getDocumentProperties()
    .setProperty(SIDEBAR_CHECKS_KEY, JSON.stringify(checks || {}));
  return true;
}

// ── Highlighting ─────────────────────────────────────────────────────────

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

function getDocEditToken() {
  var text = DocumentApp.getActiveDocument().getBody().getText();
  var hash = 0;
  for (var i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash + ":" + text.length;
}

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

// ── Sidebar actions (stubs) ─────────────────────────────────────────────

function replaceInCell_(cell, currentText, pattern, replacement) {
  var cellText = cell.getText();
  var count = cellText.split(currentText).length - 1;
  if (count > 0) {
    cell.replaceText(pattern, replacement);
  }
  return count;
}

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

function onOpen(e) {
  DocumentApp.getUi()
    .createAddonMenu()
    .addItem("Show AI Suggestions", "showReviewPanel")
    .addItem("Submit Review", "submitReview")
    .addToUi();
}

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
