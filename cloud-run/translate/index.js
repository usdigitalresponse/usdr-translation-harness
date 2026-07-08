const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { buildTranslationPrompt } = require("./prompt-assembly");
const { callLlm } = require("./llm");
const { loadConfig, writeOutput, logTranslationResult } = require("./loaders");

const REQUIRED_FIELDS = ["extractionFileId", "sourceFileName"];
const TRANSLATE_ROLE = "translate";
const STATUS_TRANSLATED = "translated";
const STATUS_FAILED = "failed";

function logStructured(status, provider, model, sourceFileId, sourceFileName, extra = {}) {
  const entry = {
    severity: status === STATUS_FAILED ? "ERROR" : "INFO",
    message: `translation ${status} for ${provider}/${model}`,
    pipeline_stage: "translate",
    status,
    provider,
    model,
    sourceFileId,
    sourceFileName,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

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

  const baseName = sourceFileName.replace(/\.pdf$/i, "");

  const results = await Promise.allSettled(
    activeModels.map(async ({ provider, model }) => {
      console.log(`Calling ${provider} (${model})...`);
      const translationJson = await callLlm(provider, model, prompt);
      console.log(`${provider} (${model}) complete, writing output...`);
      const outputFileName = `${baseName}_${provider}_${model}.json`;
      let parsed;
      try {
        parsed = typeof translationJson === "string"
          ? JSON.parse(translationJson)
          : translationJson;
      } catch {
        console.error(`Failed to parse JSON from ${provider}/${model}, saving raw output`);
        await writeOutput(outputFileName, translationJson);
        throw new Error("LLM returned invalid JSON");
      }
      const outputData = {
        ...parsed,
        sourceFileId,
        extractionFileId,
        provider,
        model,
      };
      const fileId = await writeOutput(outputFileName, outputData);
      return { provider, model, outputFileId: fileId, outputFileName };
    })
  );

  const translations = results.map((r, i) => {
    const { provider, model } = activeModels[i];
    if (r.status === "fulfilled") {
      return { ...r.value, status: STATUS_TRANSLATED };
    }
    return {
      provider,
      model,
      status: STATUS_FAILED,
      error: r.reason?.message || String(r.reason),
    };
  });

  for (const t of translations) {
    logStructured(t.status, t.provider, t.model, sourceFileId, sourceFileName,
      t.error ? { error: t.error } : { driveFileId: t.outputFileId });
    try {
      await logTranslationResult(sourceFileId, sourceFileName, t);
    } catch (err) {
      console.error(`Failed to log translation result for ${t.provider}/${t.model}:`, err.message);
    }
  }

  const succeeded = translations.filter((t) => t.status === STATUS_TRANSLATED);

  if (!succeeded.length) {
    console.error("All translation models failed", { extractionFileId, sourceFileName, translations });
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

  const overallStatus = succeeded.length === translations.length ? "ok" : "partial";
  res.json({
    status: overallStatus,
    extractionFileId,
    sourceFileId,
    sourceFileName,
    promptLength: prompt.length,
    translations,
  });
}

functions.http("translate", translate);
module.exports = { translate, parseInput };
