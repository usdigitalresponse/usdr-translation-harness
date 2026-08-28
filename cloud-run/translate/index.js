const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { buildTranslationPrompt } = require("./prompt-assembly");
const { callLlm } = require("./llm");
const { loadConfig, loadStatuteUrls, writeOutput, logTranslationResult, stripExtension } = require("./loaders");
const { createTranslationDoc } = require("./doc-writer");
const { withRetry } = require("./retry");
const { notifyDocCreated, notifyDocFailed } = require("./notifier");

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

  const { extractionFileId, sourceFileId, sourceFileName, model, provider,
    contentType = "public_flyer", includeStatutes = true,
    submittedByEmail = "" } = input;

  let prompt, promptMetrics;
  try {
    ({ prompt, promptMetrics } = await buildTranslationPrompt(extractionFileId, contentType, { includeStatutes }));
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

  const baseName = stripExtension(sourceFileName);
  const statuteUrls = includeStatutes ? loadStatuteUrls() : {};

  const results = await Promise.allSettled(
    activeModels.map(async ({ provider, model, effort }) => {
      console.log(`Calling ${provider} (${model})...`);
      const { text: translationJson, usage, stop_reason } = await callLlm(provider, model, prompt, { effort: effort || undefined });
      console.log(`${provider} (${model}) complete (%d in / %d out tokens, stop_reason=%s), writing output...`,
        usage.input_tokens, usage.output_tokens, stop_reason);
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
        contentType,
        provider,
        model,
        ...(submittedByEmail && { submittedByEmail }),
        ...(Object.keys(statuteUrls).length && { statute_urls: statuteUrls }),
      };
      const fileId = await writeOutput(outputFileName, outputData);
      return { provider, model, outputFileId: fileId, outputFileName, translationJson: outputData, usage };
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
    const extra = t.error
      ? { error: t.error }
      : {
          driveFileId: t.outputFileId,
          ...(t.usage && { input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, duration_ms: t.usage.duration_ms }),
          ...promptMetrics,
        };
    logStructured(t.status, t.provider, t.model, sourceFileId, sourceFileName, extra);
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
      translations: translations.map(({ translationJson, ...rest }) => rest),
    });
    return;
  }

  const stagingFolderId = process.env.DRIVE_TRANSLATION_DOC_STAGING_FOLDER_ID;
  const outputFolderId = process.env.DRIVE_TRANSLATION_DOC_FOLDER_ID;
  for (const t of succeeded) {
    try {
      const docId = await withRetry(() =>
        createTranslationDoc({
          translationJson: t.translationJson,
          translationFileId: t.outputFileId,
          sourceFileName,
          provider: t.provider,
          model: t.model,
          stagingFolderId,
          outputFolderId,
        })
      );
      t.docId = docId;
      console.log(`Created translation doc ${docId} for ${t.provider}/${t.model}`);
      await notifyDocCreated({ sourceFileName, provider: t.provider, model: t.model, docId, submittedByEmail });
    } catch (err) {
      console.error(`Failed to create doc for ${t.provider}/${t.model}:`, err.message);
      t.docError = err.message;
      await notifyDocFailed({ sourceFileName, provider: t.provider, model: t.model, error: err.message, submittedByEmail });
    }
  }

  const overallStatus = succeeded.length === translations.length ? "ok" : "partial";
  res.json({
    status: overallStatus,
    extractionFileId,
    sourceFileId,
    sourceFileName,
    promptLength: prompt.length,
    translations: translations.map(({ translationJson, ...rest }) => rest),
  });
}

functions.http("translate", translate);
module.exports = { translate, parseInput };
