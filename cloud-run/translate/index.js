const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { buildTranslationPrompt } = require("./prompt-assembly");

const REQUIRED_FIELDS = ["extractionFileId", "sourceFileName"];

/**
 * Normalize input from either a direct HTTP call or a Pub/Sub push envelope.
 *
 * Direct call: POST body is used as-is.
 * Pub/Sub push (via Eventarc): the actual payload is base64-encoded inside
 * body.message.data — this unwraps it.
 */
function parseInput(body) {
  if (!body.message?.data) {
    return body;
  }

  const decoded = Buffer.from(body.message.data, "base64").toString();
  return JSON.parse(decoded);
}

/**
 * Translate function entry point.
 *
 * Accepts the extraction-complete payload published by the Extract function,
 * either directly or via Pub/Sub. Expected fields:
 *   - extractionFileId (required) — Drive file ID of the extraction JSON
 *   - sourceFileName (required) — original PDF filename
 *   - sourceFileId — Drive file ID of the original PDF
 *   - model — model used for extraction
 *   - provider — LLM provider used for extraction
 */
async function translate(req, res) {
  let input;
  try {
    input = parseInput(req.body || {});
  } catch (err) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: "Invalid Pub/Sub message: " + err.message });
    return;
  }

  const missing = REQUIRED_FIELDS.filter((f) => !input[f]);
  if (missing.length) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: `Missing required fields: ${missing.join(", ")}` });
    return;
  }

  const { extractionFileId, sourceFileId, sourceFileName, model, provider } =
    input;

  let prompt;
  try {
    prompt = await buildTranslationPrompt(extractionFileId);
  } catch (err) {
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "Prompt assembly failed: " + err.message });
    return;
  }

  // TODO: Call LLM with prompt
  // TODO: Store translation JSON to Drive
  // TODO: Create output Google Doc(s)
  // TODO: Set usdr_translation_review document property

  res.json({
    status: "ok",
    message: "Translate function — prompt assembled",
    extractionFileId,
    sourceFileId,
    sourceFileName,
    model,
    provider,
    promptLength: prompt.length,
    outputDocs: [],
  });
}

functions.http("translate", translate);
module.exports = { translate, parseInput };
