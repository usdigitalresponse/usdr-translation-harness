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

const EVAL_ROLE = "plain-language-eval";
const STATUS_COMPLETE = "pl-eval-complete";
const STATUS_FAILED = "pl-eval-failed";
const PROMPT_ENV_VAR = "PLAIN_LANGUAGE_EVAL_PROMPT_DOC_ID";

function logStructured(status, provider, model, sourceFileId, sourceFileName, extra = {}) {
  const entry = {
    severity: status === STATUS_FAILED ? "ERROR" : "INFO",
    message: `plain-language-eval ${status} for ${provider}/${model}`,
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

async function runEval(fileId, fileName, mimeType) {
  const config = await loadConfig();
  const activeModels = config.models.filter(
    (m) => m.role === EVAL_ROLE && m.active
  );

  if (!activeModels.length) {
    console.error("No active plain-language-eval models in config");
    return;
  }

  const { text, pdfBase64 } = await fetchDocumentContent(fileId, mimeType);
  const evalPrompt = await loadDoc(PROMPT_ENV_VAR);

  const prompt = pdfBase64
    ? evalPrompt
    : `${evalPrompt}\n\n---\n\nThe document to evaluate follows between the <document> tags.\n\n<document>\n${text}\n</document>`;

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
      const outputFileId = await writeOutput(outputFileName, outputData);
      return { provider, model, outputFileId, outputFileName, usage };
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { provider, model } = activeModels[i];

    if (r.status === "fulfilled") {
      const { outputFileId, usage } = r.value;
      logStructured(STATUS_COMPLETE, provider, model, fileId, fileName, {
        driveFileId: outputFileId,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        duration_ms: usage.duration_ms,
      });
      try {
        await logEvalResult(fileId, fileName, {
          status: STATUS_COMPLETE,
          outputFileId: r.value.outputFileId,
          durationMs: usage.duration_ms,
          provider,
          model,
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
        error,
      });
      try {
        await logEvalResult(fileId, fileName, {
          status: STATUS_FAILED,
          error,
          provider,
          model,
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
  const { fileId, fileName, mimeType = MIME_PDF } = body;

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

  runEval(fileId, fileName, mimeType).catch((err) => {
    console.error("Plain language eval failed:", err);
  });
}

functions.http("plainLanguageEval", plainLanguageEval);
module.exports = { plainLanguageEval, runEval, buildOutputFilename };
