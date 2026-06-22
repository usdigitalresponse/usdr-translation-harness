const functions = require("@google-cloud/functions-framework");

async function extract(req, res) {
  const { fileId, fileName } = req.body;

  if (!fileId) {
    res.status(400).json({ error: "Provide fileId" });
    return;
  }

  // Return 202 immediately — processing will happen in the background.
  res.status(202).json({
    status: "accepted",
    fileId,
    fileName,
  });

  // TODO: Fetch PDF from Drive using fileId (service account needs read access to input folder)
  // TODO: Read model config via loadConfig()
  // TODO: Load extraction prompt via loadDoc("EXTRACTION_PROMPT_DOC_ID")
  // TODO: Send PDF to LLM with extraction prompt
  // TODO: Store extraction JSON in DRIVE_EXTRACTION_JSON_FOLDER_ID
  // TODO: Publish completion message to PUBSUB_TOPIC_EXTRACTION_COMPLETE
}

functions.http("extract", extract);
module.exports = { extract };
