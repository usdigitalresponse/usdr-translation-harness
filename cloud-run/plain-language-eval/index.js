const functions = require("@google-cloud/functions-framework");
const { StatusCodes } = require("http-status-codes");

const { callLlm } = require("./llm");
const {
  loadDoc,
  loadConfig,
  fetchDocumentContent,
  writeOutput,
  logEvalResult,
  stripExtension,
  MIME_PDF,
} = require("./loaders");
const { logInputProblem, INPUT_PROMPT_DOC } = require("./input-problems");

const EVAL_ROLE = "plain-language-eval";
const STATUS_COMPLETE = "pl-eval-complete";
const STATUS_FAILED = "pl-eval-failed";
const PROMPT_ENV_VAR = "PLAIN_LANGUAGE_EVAL_PROMPT_DOC_ID";
// Drive property the editor add-on queries to find a source doc's eval. A
// property (not folder + filename) so lookup survives the archive sweep.
// Must match PL_EVAL_SOURCE_PROPERTY_KEY in apps-script/editor-addon/addon.js.
const SOURCE_FILE_ID_PROPERTY = "plainLanguageEvalSourceFileId";

const NO_ACTIVE_MODELS = "No active plain-language-eval models in config";

function logStructured(status, provider, model, sourceFileId, sourceFileName, extra = {}) {
  // A run that fails before any model is called has no provider/model
  const target = provider ? `for ${provider}/${model}` : "before any model ran";
  const entry = {
    severity: status === STATUS_FAILED ? "ERROR" : "INFO",
    message: `plain-language-eval ${status} ${target}`,
    pipeline_stage: "plain-language-eval",
    status,
    provider,
    model,
    sourceFileId,
    sourceFileName,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

function buildOutputFilename(baseName, model) {
  const safeModel = model.replace(/\//g, "_");
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  return `${baseName}_${safeModel}_${timestamp}_plain-language-eval.json`;
}

/**
 * Load the prompt doc, logging an input problem (for alerting and the daily
 * health check) if it can't be read or is empty.
 *
 * @throws if the doc can't be loaded or has no text
 */
async function loadEvalPrompt() {
  let evalPrompt;
  try {
    evalPrompt = await loadDoc(PROMPT_ENV_VAR);
  } catch (err) {
    logInputProblem(INPUT_PROMPT_DOC, `Can't load the prompt doc (${PROMPT_ENV_VAR}): ${err.message}`,
      { env_var: PROMPT_ENV_VAR });
    throw err;
  }
  if (!evalPrompt.trim()) {
    const detail = `The prompt doc (${PROMPT_ENV_VAR}) has no text`;
    logInputProblem(INPUT_PROMPT_DOC, detail, { env_var: PROMPT_ENV_VAR });
    throw new Error(detail);
  }
  return evalPrompt;
}

/**
 * Everything before the model calls: active models, the source document and
 * the prompt.
 *
 * @throws if any of them can't be loaded, or no model is active
 */
async function prepareRun(fileId, mimeType) {
  const config = await loadConfig();
  const activeModels = config.models.filter(
    (m) => m.role === EVAL_ROLE && m.active
  );
  if (!activeModels.length) throw new Error(NO_ACTIVE_MODELS);

  const { text, pdfBase64 } = await fetchDocumentContent(fileId, mimeType);
  const evalPrompt = await loadEvalPrompt();

  const prompt = pdfBase64
    ? evalPrompt
    : `${evalPrompt}\n\n---\n\nThe document to evaluate follows between the <document> tags.\n\n<document>\n${text}\n</document>`;
  return { activeModels, prompt, pdfBase64 };
}

/**
 * Record a run that failed before any model was called. It already returned
 * 202 to the Orchestrator (which logged pl-eval-triggered), so without this
 * row the failure would never reach the Processing Log.
 */
async function recordRunFailure(fileId, fileName, submittedByEmail, error) {
  logStructured(STATUS_FAILED, "", "", fileId, fileName, {
    ...(submittedByEmail && { submittedByEmail }),
    error,
  });
  try {
    await logEvalResult(fileId, fileName, {
      status: STATUS_FAILED,
      error,
      provider: "",
      model: "",
      submittedByEmail,
    });
  } catch (err) {
    console.error("Failed to log eval failure:", err.message);
  }
}

/**
 * Run the plain-language eval for one source file with every active model.
 * Writes one Processing Log row per model, or a single pl-eval-failed row if
 * the run fails before any model is called. Never throws.
 */
async function runEval(fileId, fileName, mimeType, submittedByEmail = "") {
  let activeModels, prompt, pdfBase64;
  try {
    ({ activeModels, prompt, pdfBase64 } = await prepareRun(fileId, mimeType));
  } catch (err) {
    await recordRunFailure(fileId, fileName, submittedByEmail, err.message);
    return;
  }

  const baseName = stripExtension(fileName);

  const results = await Promise.allSettled(
    activeModels.map(async ({ provider, model }) => {
      console.log(`Calling ${provider} (${model})...`);
      const { text: evalJson, usage, stop_reason } = await callLlm(
        provider,
        model,
        prompt,
        pdfBase64
      );
      console.log(
        `${provider} (${model}) complete (%d in / %d out tokens, stop_reason=%s), writing output...`,
        usage.input_tokens,
        usage.output_tokens,
        stop_reason
      );

      const outputFileName = buildOutputFilename(baseName, model);
      let parsed;
      try {
        parsed =
          typeof evalJson === "string" ? JSON.parse(evalJson) : evalJson;
      } catch {
        console.error(
          `Failed to parse JSON from ${provider}/${model}, saving raw output`
        );
        await writeOutput(outputFileName, evalJson);
        throw new Error("LLM returned invalid JSON");
      }

      const outputData = {
        ...parsed,
        sourceFileId: fileId,
        sourceFileName: fileName,
        provider,
        model,
      };
      // Only parsed output is tagged — the raw fallback above stays untagged
      // so the add-on never picks up an unparseable file as the latest eval.
      const outputFileId = await writeOutput(outputFileName, outputData, {
        [SOURCE_FILE_ID_PROPERTY]: fileId,
      });
      return { provider, model, outputFileId, outputFileName, usage };
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { provider, model } = activeModels[i];

    if (r.status === "fulfilled") {
      const { outputFileId, usage } = r.value;
      logStructured(STATUS_COMPLETE, provider, model, fileId, fileName, {
        // Who dropped the file in the input folder (Drive lastModifyingUser, from the Orchestrator)
        ...(submittedByEmail && { submittedByEmail }),
        driveFileId: outputFileId,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        duration_ms: usage.duration_ms,
        // Which backend served the call (vertex/direct), and why Vertex was skipped if it fell back
        ...(usage.llm_backend && { llm_backend: usage.llm_backend }),
        ...(usage.llm_fallback_reason && { llm_fallback_reason: usage.llm_fallback_reason }),
        ...(usage.model_retries && { model_retries: usage.model_retries }),
      });
      try {
        await logEvalResult(fileId, fileName, {
          status: STATUS_COMPLETE,
          outputFileId: r.value.outputFileId,
          durationMs: usage.duration_ms,
          provider,
          model,
          submittedByEmail,
        });
      } catch (err) {
        console.error(
          `Failed to log eval result for ${provider}/${model}:`,
          err.message
        );
      }
    } else {
      const error = r.reason?.message || String(r.reason);
      logStructured(STATUS_FAILED, provider, model, fileId, fileName, {
        ...(submittedByEmail && { submittedByEmail }),
        error,
      });
      try {
        await logEvalResult(fileId, fileName, {
          status: STATUS_FAILED,
          error,
          provider,
          model,
          submittedByEmail,
        });
      } catch (err) {
        console.error(
          `Failed to log eval failure for ${provider}/${model}:`,
          err.message
        );
      }
    }
  }
}

async function plainLanguageEval(req, res) {
  const body = req.body || {};
  const { fileId, fileName, mimeType = MIME_PDF, submittedByEmail = "" } = body;

  console.log(
    "Received request: fileId=%s, fileName=%s, mimeType=%s",
    fileId,
    fileName,
    mimeType
  );

  if (!fileId) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: "Provide fileId" });
    return;
  }

  res
    .status(StatusCodes.ACCEPTED)
    .json({ status: "accepted", fileId, fileName });

  runEval(fileId, fileName, mimeType, submittedByEmail).catch((err) => {
    console.error("Plain language eval failed:", err);
  });
}

functions.http("plainLanguageEval", plainLanguageEval);
module.exports = { plainLanguageEval, runEval, buildOutputFilename, SOURCE_FILE_ID_PROPERTY };
