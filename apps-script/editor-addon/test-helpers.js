// Manual test functions — run these from the Apps Script Editor's Run button.
// They exist for sandbox setup and configuration checks, not for production use.

var SAMPLE_ROWS = [
  ["English", "Spanish"],
  [
    "Family and Medical Leave Insurance (FAMLI)",
    "Seguro de Licencia Familiar y Médica (FAMLI, sigla en inglés)",
  ],
  [
    "You may be eligible for paid leave if you earned at least $2,500 in wages over the past year.",
    "Usted podría ser elegible para la licencia pagada si ganó al menos $2,500 en salarios durante el año pasado.",
  ],
  [
    "To file a claim, visit our website or call the number listed below.",
    "Para presentar una reclamación, visite nuestro sitio web o llame al número que aparece abajo.",
  ],
  [
    "Do not send cash through the mail.",
    "No envíe dinero en efectivo por correo.",
  ],
];

/**
 * One-time sandbox setup: fills the doc with a two-column English/Spanish
 * table so extractDocBlocks_() has content to evaluate.
 *
 * Safe to re-run — it clears the body first.
 */
function setupSandboxDoc() {
  var body = DocumentApp.getActiveDocument().getBody();
  body.clear();
  body.appendParagraph("Translation Review — Sandbox Test Document");
  body.appendTable(SAMPLE_ROWS);
  Logger.log("Sandbox doc ready: %s rows (1 header + %s content)",
    SAMPLE_ROWS.length, SAMPLE_ROWS.length - 1);
}

function testAll() {
  Logger.log("=== 1/4: Config ===");
  testConfig();
  Logger.log("");

  Logger.log("=== 2/4: Translation JSON ===");
  testTranslationJson();
  Logger.log("");

  Logger.log("=== 3/4: Sidebar Data ===");
  testSidebarData();
  Logger.log("");

  Logger.log("=== 4/4: Doc Structure ===");
  testDocStructure();
  Logger.log("");

  Logger.log("=== All checks complete ===");
}

/** Verify the script properties the add-on needs are set. */
function testConfig() {
  var props = PropertiesService.getScriptProperties();
  var sandboxId = props.getProperty(SANDBOX_FILE_ID_KEY);
  Logger.log("%s: %s", SANDBOX_FILE_ID_KEY, sandboxId ? sandboxId : "NOT SET");

  var resolvedId = getTranslationFileId_();
  Logger.log("Resolved translation file ID: %s", resolvedId || "none");

  if (!sandboxId && !resolvedId) {
    Logger.log("ERROR: No translation file ID found. Set %s in Script Properties.", SANDBOX_FILE_ID_KEY);
    return;
  }

  var sandboxEvalId = props.getProperty(SANDBOX_EVAL_FILE_ID_KEY);
  Logger.log("%s: %s", SANDBOX_EVAL_FILE_ID_KEY, sandboxEvalId ? sandboxEvalId : "not set (optional — needed for quality eval sidebar)");

  var evalUrl = props.getProperty(EVAL_FUNCTION_URL_KEY);
  var captureUrl = props.getProperty("CAPTURE_FEEDBACK_FUNCTION_URL");
  Logger.log("%s: %s", EVAL_FUNCTION_URL_KEY, evalUrl ? evalUrl : "not set (expected for preview)");
  Logger.log("CAPTURE_FEEDBACK_FUNCTION_URL: %s", captureUrl ? captureUrl : "not set (expected for preview)");
}

/** Load the translation JSON from Drive and report its structure. */
function testTranslationJson() {
  var json = getTranslationJson_();
  if (!json) {
    Logger.log("ERROR: Could not load translation JSON. Check that the file ID is correct and you have access.");
    return;
  }

  var blocks = json.blocks || [];
  Logger.log("Translation JSON loaded successfully");
  Logger.log("  Blocks: %s", blocks.length);
  Logger.log("  Metadata: %s", json.metadata ? "present" : "missing");

  if (blocks.length > 0) {
    var first = blocks[0];
    Logger.log("  First block ID: %s", first.id || "(no id)");
    var sectionKeys = ["alt_translations", "terms_flagged_for_clarification",
      "back_translation_of_key_phrases", "glossary_cross_check"];
    for (var i = 0; i < sectionKeys.length; i++) {
      var items = first[sectionKeys[i]] || [];
      Logger.log("  First block %s: %s items", sectionKeys[i], items.length);
    }
  }
}

/** Call getSidebarData() and report what it returns. */
function testSidebarData() {
  var result = getSidebarData();
  if (!result.data) {
    Logger.log("ERROR: getSidebarData() returned no data. Check translation JSON setup.");
    return;
  }

  Logger.log("Sidebar data loaded successfully");
  Logger.log("  alt_translations: %s items", result.data.alt_translations.length);
  Logger.log("  terms_flagged_for_clarification: %s items", result.data.terms_flagged_for_clarification.length);
  Logger.log("  back_translation_of_key_phrases: %s items", result.data.back_translation_of_key_phrases.length);
  Logger.log("  glossary_cross_check: %s items", result.data.glossary_cross_check.length);
  Logger.log("  blocks: %s", result.data.blocks.length);
  Logger.log("  Saved review state: %s entries", Object.keys(result.checks).length);
}

/** Check the document has a table with the expected column layout. */
function testDocStructure() {
  var table = getFirstTable_();
  if (!table) {
    Logger.log("ERROR: No table found in document. Run setupSandboxDoc() first or check your sample doc.");
    return;
  }

  var numRows = table.getNumRows();
  var layout = getColumnLayout_(table);
  Logger.log("Table found: %s rows, %s columns", numRows, layout.total);

  if (layout.total >= TABLE_COLUMNS) {
    Logger.log("  Layout: Block ID (col %s) | Original (col %s) | Translated (col %s)",
      layout.blockId, layout.original, layout.translated);
  } else {
    Logger.log("  Layout: Original (col %s) | Translated (col %s) — two-column format, no block IDs",
      layout.original, layout.translated);
  }

  if (numRows > 1) {
    var headerRow = table.getRow(0);
    var headers = [];
    for (var i = 0; i < headerRow.getNumCells(); i++) {
      headers.push(headerRow.getCell(i).getText());
    }
    Logger.log("  Header row: %s", headers.join(" | "));

    var sampleRow = table.getRow(1);
    Logger.log("  Row 1 original: %s", sampleRow.getCell(layout.original).getText().substring(0, 60));
    Logger.log("  Row 1 translated: %s", sampleRow.getCell(layout.translated).getText().substring(0, 60));
  }
}

/** Show what extractDocBlocks_() would send to the eval function. */
function testExtractBlocks() {
  var blocks = extractDocBlocks_();
  Logger.log("Extracted %s blocks", blocks.length);
  for (var i = 0; i < blocks.length; i++) {
    Logger.log("  [%s] %s  ->  %s", blocks[i].id,
      blocks[i].original_text.substring(0, 50),
      blocks[i].translated_text.substring(0, 50));
  }
}

/** Run a full evaluation and log the outcome, without opening the sidebar. */
function testEvaluate() {
  var result = evaluateTranslationFromSidebar();
  Logger.log("Result: %s", JSON.stringify(result));
  if (result && result.ok) {
    Logger.log("Eval data: %s", JSON.stringify(getEvalData(), null, 2));
  }
}
