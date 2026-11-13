const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { buildTranslationPrompt } = require("./prompt-assembly");
const { callLlm, modelRetryReason } = require("./llm");
const { loadConfig, loadStatuteUrls, writeOutput, logTranslationResult, stripExtension } = require("./loaders");
const { createTranslationDoc } = require("./doc-writer");
const { withRetry } = require("./retry");
const { CHUNK_SIZE, planChunks, mergeChunkTranslations } = require("./chunking");
const { notifyDocCreated, notifyDocFailed, notifyTranslationFailed, DOC_BASE_URL } = require("./notifier");
const { AlreadyBilledError, InvalidOutputError, IncompleteTranslationError } = require("./errors");
const { REASONS, inputFailureReason, modelFailureReason } = require("./failure-reasons");

const REQUIRED_FIELDS = ["extractionFileId", "sourceFileName"];
const TRANSLATE_ROLE = "translate";
const STATUS_TRANSLATED = "translated";
const STATUS_FAILED = "failed";
const STATUS_DOC_CREATED = "doc-created";
const STATUS_DOC_FAILED = "doc-failed";
// Separate stage so doc builds can be charted without changing the
// pipeline_stage="translate" counts
const DOC_PIPELINE_STAGE = "translate_doc";

// Model calls must finish (or give up) this long after the request starts.
// Cloud Run cuts requests off at 600 s, and a cut-off request can't record its
// failure, so Pub/Sub redelivers it. The ~60 s left is for saving the JSON,
// building the doc and logging.
const MODEL_TIME_BUDGET_MS = 540_000;

// Google API errors (Drive, Sheets, Docs) worth a Pub/Sub retry: the service
// was temporarily unavailable, or the network failed
const TEMPORARY_GOOGLE_API_STATUSES = new Set([
  StatusCodes.TOO_MANY_REQUESTS, StatusCodes.INTERNAL_SERVER_ERROR, StatusCodes.BAD_GATEWAY,
  StatusCodes.SERVICE_UNAVAILABLE, StatusCodes.GATEWAY_TIMEOUT,
]);
const TEMPORARY_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Whether a Google API failure (loading the extraction, prompt doc, glossary
 * or Model Config) is temporary and worth a Pub/Sub retry. Anything else (not
 * found, no access, a malformed sheet) will fail the same way every time.
 */
function isTemporaryGoogleError(err) {
  const status = Number(err?.status ?? err?.response?.status);
  if (TEMPORARY_GOOGLE_API_STATUSES.has(status)) return true;
  const code = err?.code ?? err?.cause?.code;
  return TEMPORARY_NETWORK_CODES.has(code);
}

/**
 * Whether a model's failed run is worth a Pub/Sub retry: only a temporary
 * problem before any model work (rate limit, overload, network) that was still
 * failing after the in-request retries. Timeouts, bad or incomplete output,
 * configuration problems and failures after a successful call are not.
 */
function isRetryableModelFailure(err) {
  if (err instanceof AlreadyBilledError) return false;
  return Boolean(modelRetryReason(err));
}

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
 * Record the output doc step for one model: a structured log line and an
 * appended Processing Log row (`doc-created` with the doc's URL in outputDocUrl and its ID in
 * outputDocId, or `doc-failed`
 * with the error). Never throws: logging must not fail the translation.
 *
 * @param {Object} t - The translation result (provider, model, outputFileId)
 * @param {{docId?: string, error?: string, durationMs: number}} doc
 * @param {{sourceFileId: string, sourceFileName: string, submittedByEmail: string}} source
 */
async function logDocResult(t, doc, { sourceFileId, sourceFileName, submittedByEmail }) {
  const status = doc.docId ? STATUS_DOC_CREATED : STATUS_DOC_FAILED;
  console.log(JSON.stringify({
    severity: doc.docId ? "INFO" : "ERROR",
    message: `translation doc ${doc.docId ? "created" : "failed"} for ${t.provider}/${t.model}`,
    pipeline_stage: DOC_PIPELINE_STAGE,
    status,
    provider: t.provider,
    model: t.model,
    sourceFileId,
    sourceFileName,
    translationFileId: t.outputFileId,
    duration_ms: doc.durationMs,
    ...(doc.docId && { docId: doc.docId }),
    ...(doc.error && { error: doc.error }),
    ...(submittedByEmail && { submittedByEmail }),
  }));
  try {
    await logTranslationResult(sourceFileId, sourceFileName, {
      status,
      provider: t.provider,
      model: t.model,
      outputFileId: t.outputFileId,
      outputDocUrl: doc.docId ? DOC_BASE_URL + doc.docId : "",
      outputDocId: doc.docId || "",
      error: doc.error,
      durationMs: doc.durationMs,
      submittedByEmail,
    });
  } catch (err) {
    console.error(`Failed to log doc result for ${t.provider}/${t.model}:`, err.message);
  }
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
 * Translate the document with one model: a single call, or (for documents
 * with more than chunkSize translatable blocks) parallel calls over contiguous
 * block ranges, merged into one translation.
 *
 * @returns {Promise<{text: string|Object, usage: Object, stop_reason: string}>}
 *   text is the raw model output (single call) or the merged object (chunked)
 */
async function translateDocument({ provider, model, effort, deadline, chunkSize, prompt, extractionBlocks, promptForBlocks, saveRawChunk }) {
  const chunks = planChunks(extractionBlocks, chunkSize);
  if (chunks.length === 1) {
    return callLlm(provider, model, prompt, { effort, deadline });
  }

  console.log(`Translating in ${chunks.length} chunks (${chunks.map((c) => c.expectedBlockIds.length).join("/")} blocks) with ${provider} (${model})`);
  const start = Date.now();
  // allSettled, not all: the other chunks keep running (and billing) after one fails,
  // so wait for them to tell whether a retry would redo paid work
  const settled = await Promise.allSettled(chunks.map(async (chunk, i) => {
    const label = `chunk ${i + 1}/${chunks.length}`;
    const result = await callLlm(provider, model, promptForBlocks(chunk.blocks), { effort, deadline });
    console.log(`${provider} (${model}) ${label} complete (%d in / %d out tokens, stop_reason=%s)`,
      result.usage.input_tokens, result.usage.output_tokens, result.stop_reason);
    try {
      return { ...result, parsed: typeof result.text === "string" ? JSON.parse(result.text) : result.text };
    } catch {
      await saveRawChunk(i + 1, result.text);
      throw new InvalidOutputError(`LLM returned invalid JSON (${label}, stop_reason=${result.stop_reason})`);
    }
  }));
  const failures = settled.filter((s) => s.status === "rejected").map((s) => s.reason);
  if (failures.length) {
    // Retryable only if every chunk failed before doing any work
    if (failures.length === chunks.length && failures.every(isRetryableModelFailure)) throw failures[0];
    const err = failures.find((e) => !isRetryableModelFailure(e)) ?? failures[0];
    throw new AlreadyBilledError(`${err.message} (${failures.length} of ${chunks.length} chunks failed)`, { cause: err });
  }
  const results = settled.map((s) => s.value);

  const stopReasons = [...new Set(results.map((r) => r.stop_reason))];
  return {
    text: mergeChunkTranslations(results.map((r) => r.parsed)),
    stop_reason: stopReasons.join(","),
    usage: {
      input_tokens: results.reduce((n, r) => n + (r.usage.input_tokens || 0), 0),
      output_tokens: results.reduce((n, r) => n + (r.usage.output_tokens || 0), 0),
      thinking_tokens: results.reduce((n, r) => n + (r.usage.thinking_tokens || 0), 0),
      model_retries: results.reduce((n, r) => n + (r.usage.model_retries || 0), 0),
      duration_ms: Date.now() - start,
      llm_backend: results[0].usage.llm_backend,
      chunks: chunks.length,
    },
  };
}

const MISSING_IDS_SHOWN = 5;

/**
 * IDs of the blocks the model was asked to translate but didn't return.
 *
 * @param {{blocks?: Array<{id: string}>}} parsed - The model's translation JSON
 * @param {string[]} expectedBlockIds - IDs of the extraction's translatable blocks
 * @returns {string[]}
 */
function findMissingBlockIds(parsed, expectedBlockIds = []) {
  const returned = new Set((Array.isArray(parsed?.blocks) ? parsed.blocks : []).map((b) => b?.id));
  return expectedBlockIds.filter((id) => !returned.has(id));
}

function incompleteTranslationMessage(missingBlockIds, expectedCount, stopReason) {
  const shown = missingBlockIds.slice(0, MISSING_IDS_SHOWN).join(", ");
  const more = missingBlockIds.length > MISSING_IDS_SHOWN ? `, +${missingBlockIds.length - MISSING_IDS_SHOWN} more` : "";
  return `Incomplete translation: ${expectedCount - missingBlockIds.length} of ${expectedCount} blocks returned ` +
    `(missing ${shown}${more}; stop_reason=${stopReason})`;
}

/**
 * Record a failure Translate won't retry, and acknowledge the message (2xx) so
 * Pub/Sub doesn't redeliver it: a structured log entry, a failed Processing Log
 * row (when no model rows were written for it) and a Chat notice.
 *
 * @param {Object} res - HTTP response
 * @param {{error: string, reasons: string[], sourceFileId: string, sourceFileName: string,
 *   submittedByEmail: string, submittedByName: string, logRow?: boolean, body?: Object}} failure
 *   error: the technical error (logs, Processing Log, response); reasons: plain-language
 *   lines for Chat (see failure-reasons.js)
 */
async function stopWithoutRetry(res, { error, reasons, sourceFileId, sourceFileName, submittedByEmail,
  submittedByName, logRow = true, body = {} }) {
  console.error(`Translation failed, not retrying: ${error}`);
  if (logRow) {
    logStructured(STATUS_FAILED, "", "", sourceFileId, sourceFileName, {
      error, retryable: false, ...(submittedByEmail && { submittedByEmail }),
    });
    try {
      await logTranslationResult(sourceFileId, sourceFileName,
        { status: STATUS_FAILED, error, provider: "", model: "", submittedByEmail });
    } catch (err) {
      console.error("Failed to log translation failure:", err.message);
    }
  }
  await notifyTranslationFailed({ sourceFileName, reasons, submittedByEmail, submittedByName });
  res.status(StatusCodes.OK).json({ status: STATUS_FAILED, retry: false, error, sourceFileName, ...body });
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
 *   - contentType — selects the translation prompt (default public_flyer)
 *   - submittedByEmail, submittedByName — who dropped the file in the input
 *     folder (from the Orchestrator, via Extract); shown in the Chat notification
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
    submittedByEmail = "", submittedByName = "" } = input;
  // Model calls have to finish by this, so a slow one fails here (and is
  // recorded) instead of being cut off by Cloud Run (and redelivered)
  const deadline = Date.now() + MODEL_TIME_BUDGET_MS;
  const source = { sourceFileId, sourceFileName, submittedByEmail, submittedByName };

  let prompt, promptMetrics, expectedBlockIds, extractionBlocks, promptForBlocks;
  try {
    ({ prompt, promptMetrics, expectedBlockIds, extractionBlocks, promptForBlocks } =
      await buildTranslationPrompt(extractionFileId, contentType, { includeStatutes }));
  } catch (err) {
    const error = "Prompt assembly failed: " + err.message;
    if (isTemporaryGoogleError(err)) {
      // e.g. Drive briefly unavailable: worth a Pub/Sub retry (capped by the dead-letter policy)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error, retry: true });
      return;
    }
    await stopWithoutRetry(res, { error, reasons: [inputFailureReason(err)], ...source });
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const error = "Failed to load model config: " + err.message;
    if (isTemporaryGoogleError(err)) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error, retry: true });
      return;
    }
    await stopWithoutRetry(res, { error, reasons: [inputFailureReason(err)], ...source });
    return;
  }

  const activeModels = config.models.filter(
    (m) => m.role === TRANSLATE_ROLE && m.active
  );

  if (!activeModels.length) {
    await stopWithoutRetry(res, { error: "No active translate models in Model Config",
      reasons: [REASONS.noActiveModels], ...source });
    return;
  }

  const baseName = stripExtension(sourceFileName);
  const statuteUrls = includeStatutes ? loadStatuteUrls() : {};

  const results = await Promise.allSettled(
    activeModels.map(async ({ provider, model, effort }) => {
      console.log(`Calling ${provider} (${model})...`);
      const outputFileName = `${baseName}_${provider}_${model}.json`;
      // Saving happens after the model call has been paid for, so a save failure
      // must never trigger a retry (which would translate, and bill, again)
      const save = async (name, data) => {
        try {
          return await writeOutput(name, data);
        } catch (err) {
          throw new AlreadyBilledError(`Saving ${name} failed after translating: ${err.message}`,
            { cause: err, savingFailed: true });
        }
      };
      const { text: translationJson, usage, stop_reason } = await translateDocument({
        provider, model, effort: effort || undefined, deadline, chunkSize: CHUNK_SIZE,
        prompt, extractionBlocks, promptForBlocks,
        saveRawChunk: (n, text) => save(`${baseName}_${provider}_${model}_chunk${n}.json`, text),
      });
      console.log(`${provider} (${model}) complete (%d in / %d out tokens, stop_reason=%s), writing output...`,
        usage.input_tokens, usage.output_tokens, stop_reason);
      let parsed;
      try {
        parsed = typeof translationJson === "string"
          ? JSON.parse(translationJson)
          : translationJson;
      } catch {
        console.error(`Failed to parse JSON from ${provider}/${model}, saving raw output`);
        await save(outputFileName, translationJson);
        throw new InvalidOutputError("LLM returned invalid JSON");
      }
      // Valid JSON can still be a partial translation (gemini-4-carbon has
      // returned 5 of 438 blocks with a normal stop reason). Don't build a doc from it.
      const missingBlockIds = findMissingBlockIds(parsed, expectedBlockIds);
      if (missingBlockIds.length) {
        console.error(`Incomplete translation from ${provider}/${model} (stop_reason=${stop_reason}), saving raw output`);
        await save(outputFileName, parsed);
        throw new IncompleteTranslationError(incompleteTranslationMessage(missingBlockIds, expectedBlockIds.length, stop_reason));
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
      const fileId = await save(outputFileName, outputData);
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
      retryable: isRetryableModelFailure(r.reason),
      reason: modelFailureReason(r.reason),
    };
  });

  for (const t of translations) {
    const extra = t.error
      ? { error: t.error, retryable: t.retryable }
      : {
          driveFileId: t.outputFileId,
          ...(t.usage && { input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, duration_ms: t.usage.duration_ms }),
          ...(t.usage?.thinking_tokens && { thinking_tokens: t.usage.thinking_tokens }),
          // Which backend served the call (vertex/direct), and why Vertex was skipped if it fell back
          ...(t.usage?.llm_backend && { llm_backend: t.usage.llm_backend }),
          ...(t.usage?.llm_fallback_reason && { llm_fallback_reason: t.usage.llm_fallback_reason }),
          ...(t.usage?.model_retries && { model_retries: t.usage.model_retries }),
          ...(t.usage?.chunks && { chunks: t.usage.chunks }),
          ...promptMetrics,
        };
    // Who dropped the file in the input folder (Drive lastModifyingUser, from the Orchestrator)
    logStructured(t.status, t.provider, t.model, sourceFileId, sourceFileName, {
      ...extra,
      ...(submittedByEmail && { submittedByEmail }),
    });
    try {
      await logTranslationResult(sourceFileId, sourceFileName, { ...t, submittedByEmail });
    } catch (err) {
      console.error(`Failed to log translation result for ${t.provider}/${t.model}:`, err.message);
    }
  }

  const succeeded = translations.filter((t) => t.status === STATUS_TRANSLATED);

  if (!succeeded.length) {
    console.error("All translation models failed", { extractionFileId, sourceFileName, translations });
    const summary = translations.map(({ translationJson, ...rest }) => rest);
    // Retry only if every model failed for a temporary reason. Otherwise a retry
    // would re-run (and re-bill) models that will fail the same way again.
    if (translations.every((t) => t.retryable)) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: "All translation models failed (temporary); Pub/Sub will retry",
        retry: true, extractionFileId, sourceFileName, translations: summary,
      });
      return;
    }
    // Each model's failure already has its own Processing Log row
    const error = translations.map((t) => `${t.provider}/${t.model}: ${t.error}`).join("; ");
    // One line if every model failed the same way; otherwise one per model
    const distinct = [...new Set(translations.map((t) => t.reason))];
    const reasons = distinct.length === 1 ? distinct : translations.map((t) => `${t.provider}/${t.model}: ${t.reason}`);
    await stopWithoutRetry(res, { error, reasons, ...source, logRow: false,
      body: { extractionFileId, translations: summary } });
    return;
  }

  const stagingFolderId = process.env.DRIVE_TRANSLATION_DOC_STAGING_FOLDER_ID;
  const outputFolderId = process.env.DRIVE_TRANSLATION_DOC_FOLDER_ID;
  for (const t of succeeded) {
    const docStart = Date.now();
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
      await logDocResult(t, { docId, durationMs: Date.now() - docStart },
        { sourceFileId, sourceFileName, submittedByEmail });
      await notifyDocCreated({ sourceFileName, provider: t.provider, model: t.model, docId,
        submittedByEmail, submittedByName });
    } catch (err) {
      console.error(`Failed to create doc for ${t.provider}/${t.model}:`, err.message);
      t.docError = err.message;
      await logDocResult(t, { error: err.message, durationMs: Date.now() - docStart },
        { sourceFileId, sourceFileName, submittedByEmail });
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
module.exports = {
  translate, parseInput, translateDocument, findMissingBlockIds, incompleteTranslationMessage,
  isTemporaryGoogleError, isRetryableModelFailure, AlreadyBilledError, MODEL_TIME_BUDGET_MS,
};
