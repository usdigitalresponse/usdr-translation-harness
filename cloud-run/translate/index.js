const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { buildTranslationPrompt } = require("./prompt-assembly");
const { callLlm } = require("./llm");
const { loadConfig, writeOutput } = require("./loaders");

const REQUIRED_FIELDS = ["extractionFileId", "sourceFileName"];
const TRANSLATE_ROLE = "translate";

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
    console.error("Unprocessable Pub/Sub message, acking to prevent retries:", err.message);
    res.status(StatusCodes.NO_CONTENT).json({ acked: true });
    return;
  }

  const missing = REQUIRED_FIELDS.filter((f) => !input[f]);
  if (missing.length) {
    console.error(`Missing required fields (${missing.join(", ")}), acking to prevent retries`);
    res.status(StatusCodes.NO_CONTENT).json({ acked: true });
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

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to load model config: " + err.message });
    return;
  }

  const activeModels = config.models.filter(
    (m) => m.role === TRANSLATE_ROLE && m.active
  );

  if (!activeModels.length) {
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ error: "No active translate models in config" });
    return;
  }

  const results = await Promise.allSettled(
    activeModels.map(async (m) => {
      console.log(`Calling ${m.provider} (${m.model})...`);
      const translationJson = await callLlm(m.provider, m.model, prompt);
      console.log(`${m.provider} (${m.model}) complete, writing output...`);
      const baseName = sourceFileName.replace(/\.pdf$/i, "");
      const outputFileName = `${baseName}_${m.provider}_${m.model}.json`;
      const fileId = await writeOutput(outputFileName, translationJson);
      return {
        provider: m.provider,
        model: m.model,
        outputFileId: fileId,
        outputFileName,
      };
    })
  );

  const translations = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      provider: activeModels[i].provider,
      model: activeModels[i].model,
      error: r.reason?.message || String(r.reason),
    };
  });

  const succeeded = translations.filter((t) => !t.error);
  const failed = translations.filter((t) => t.error);

  if (!succeeded.length) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "All translation models failed",
      extractionFileId,
      sourceFileName,
      translations,
    });
    return;
  }

  // TODO: Create output Google Doc(s)
  // TODO: Set usdr_translation_review document property

  const status = failed.length ? "partial" : "ok";
  res.json({
    status,
    extractionFileId,
    sourceFileId,
    sourceFileName,
    promptLength: prompt.length,
    translations,
  });
}

functions.http("translate", translate);
module.exports = { translate, parseInput };
