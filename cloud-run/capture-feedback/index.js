const functions = require("@google-cloud/functions-framework");

async function captureFeedback(req, res) {
  const { documentId } = req.body;

  if (!documentId) {
    res.status(400).json({ error: "Provide documentId" });
    return;
  }

  // TODO: Read final Google Doc text from documentId
  // TODO: Load stored translation JSON from DRIVE_TRANSLATION_JSON_FOLDER_ID
  // TODO: Write terminology decisions via writeLocalCsv() (local) or Sheets API (deployed)
  // TODO: Diff reviewer edits against AI output
  // TODO: Write terminology decisions to GLOSSARY_SHEET_ID (deployed)

  res.json({
    status: "ok",
    message: "Capture Feedback function placeholder",
    decisions: [],
  });
}

functions.http("captureFeedback", captureFeedback);
module.exports = { captureFeedback };
