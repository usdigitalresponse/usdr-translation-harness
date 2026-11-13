const { StatusCodes } = require("http-status-codes");

const { isModelTimeout, modelRetryReason } = require("./llm");
const {
  ModelConfigError, MissingSettingError, InvalidOutputError, IncompleteTranslationError, AlreadyBilledError,
} = require("./errors");

// Plain-language reasons for the translators' Chat space. The technical error
// (provider response, request ID) stays in the Processing Log and Cloud Run logs.
const REASONS = {
  modelNotFound: "The translation model in Model Config wasn't found. Check the model name.",
  modelAccess: "The pipeline couldn't access the translation model (an API key or permission problem).",
  timeout: "The document took too long to translate. It may be too long or complex; try splitting it into shorter files.",
  incomplete: "The model skipped part of the document.",
  invalidOutput: "The translation came back in an unexpected format.",
  providerBusy: "The model provider was busy or unreachable (rate limit, overload or network problem).",
  savingFailed: "The translation finished, but saving it failed.",
  inputNotFound: "A file the pipeline needs (the extraction, prompt doc or Model Config sheet) couldn't be found or isn't shared with the pipeline.",
  modelConfig: "There's a problem with the Model Config sheet.",
  noActiveModels: "Model Config has no active translate model.",
  missingSetting: "The pipeline is missing a setting (an environment variable on the Translate service).",
  unexpected: "Something unexpected went wrong.",
};

function httpStatus(err) {
  return Number(err?.status ?? err?.response?.status);
}

/**
 * Plain-language reason a prompt-assembly or Model Config load failed.
 *
 * @param {Error} err
 * @returns {string}
 */
function inputFailureReason(err) {
  if (err instanceof MissingSettingError) return REASONS.missingSetting;
  if (err instanceof ModelConfigError) return REASONS.modelConfig;
  const status = httpStatus(err);
  if (status === StatusCodes.NOT_FOUND || status === StatusCodes.FORBIDDEN) return REASONS.inputNotFound;
  return REASONS.unexpected;
}

/**
 * Plain-language reason one model's translation failed.
 *
 * @param {Error} err - The model run's error (model call, output checks or saving)
 * @returns {string}
 */
function modelFailureReason(err) {
  if (err instanceof AlreadyBilledError) {
    return err.savingFailed ? REASONS.savingFailed : modelFailureReason(err.cause);
  }
  if (isModelTimeout(err)) return REASONS.timeout;
  if (err instanceof IncompleteTranslationError) return REASONS.incomplete;
  if (err instanceof InvalidOutputError) return REASONS.invalidOutput;
  if (modelRetryReason(err)) return REASONS.providerBusy;
  const status = httpStatus(err);
  if (status === StatusCodes.NOT_FOUND) return REASONS.modelNotFound;
  if (status === StatusCodes.UNAUTHORIZED || status === StatusCodes.FORBIDDEN) return REASONS.modelAccess;
  return REASONS.unexpected;
}

module.exports = {
  REASONS,
  inputFailureReason,
  modelFailureReason,
};
