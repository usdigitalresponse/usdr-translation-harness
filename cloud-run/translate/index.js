const functions = require("@google-cloud/functions-framework");

async function translate(req, res) {
  const { extractionJsonUrl } = req.body;

  if (!extractionJsonUrl) {
    res.status(400).json({ error: "Provide extractionJsonUrl" });
    return;
  }

  // TODO: Read model config via loadConfig()
  // TODO: Load translation prompt via loadDoc("TRANSLATION_PROMPT_DOC_ID")
  // TODO: Load glossary via loadSheet("GLOSSARY_SHEET_ID")
  // TODO: Call LLM (parallel if multiple models active)
  // TODO: Store translation JSON in DRIVE_TRANSLATION_JSON_FOLDER_ID
  // TODO: Create output Google Doc(s) from OUTPUT_TEMPLATE_DOC_ID in DRIVE_OUTPUT_DOCS_FOLDER_ID
  // TODO: Set usdr_translation_review document property

  res.json({
    status: "ok",
    message: "Translate function placeholder",
    outputDocs: [],
  });
}

functions.http("translate", translate);
module.exports = { translate };
