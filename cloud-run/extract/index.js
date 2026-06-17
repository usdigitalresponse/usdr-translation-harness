const functions = require("@google-cloud/functions-framework");

async function extract(req, res) {
  const { pdfUrl, pdfBase64 } = req.body;

  if (!pdfUrl && !pdfBase64) {
    res.status(400).json({ error: "Provide pdfUrl or pdfBase64" });
    return;
  }

  // TODO: Read model config via loadConfig()
  // TODO: Load extraction prompt via loadDoc("EXTRACTION_PROMPT_DOC_ID")
  // TODO: Send PDF to LLM with extraction prompt
  // TODO: Store extraction JSON in DRIVE_EXTRACTION_JSON_FOLDER_ID
  // TODO: Publish completion message to PUBSUB_TOPIC_EXTRACTION_COMPLETE

  res.json({
    status: "ok",
    message: "Extract function placeholder",
    pages: [],
  });
}

functions.http("extract", extract);
module.exports = { extract };
