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

/** Verify the script properties the add-on needs are set. */
function testConfig() {
  var props = PropertiesService.getScriptProperties();
  var keys = [
    EVAL_FUNCTION_URL_KEY,
    "CAPTURE_FEEDBACK_FUNCTION_URL",
    SANDBOX_FILE_ID_KEY,
  ];
  for (var i = 0; i < keys.length; i++) {
    var value = props.getProperty(keys[i]);
    Logger.log("%s: %s", keys[i], value ? value : "NOT SET");
  }
  Logger.log("Resolved translation file ID: %s", getTranslationFileId_() || "none");
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
    Logger.log("Cached eval data: %s", JSON.stringify(getEvalData(), null, 2));
  }
}

/** Clear the cached evaluation so the sidebar shows its empty state again. */
function clearCachedEval() {
  PropertiesService.getDocumentProperties().deleteProperty(EVAL_RESULT_KEY);
  Logger.log("Cached evaluation cleared.");
}
