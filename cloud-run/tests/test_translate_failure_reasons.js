// Plain-language failure reasons for the Chat notice (translate/failure-reasons.js),
// using real error objects from the libraries Translate uses.

const { GaxiosError } = jest.requireActual("../translate/node_modules/googleapis/node_modules/gaxios");
const Anthropic = jest.requireActual("../translate/node_modules/@anthropic-ai/sdk");

const { REASONS, inputFailureReason, modelFailureReason } = require("../translate/failure-reasons.js");
const {
  ModelConfigError, MissingSettingError, InvalidOutputError, IncompleteTranslationError, AlreadyBilledError,
} = require("../translate/errors.js");

const googleApiError = (status) =>
  new GaxiosError(`HTTP ${status}`, {}, { status, statusText: "", headers: {}, data: {}, config: {} });
const claudeStatusError = (status) => Anthropic.APIError.generate(status, { type: "error" }, "error", new Headers());

describe("modelFailureReason", () => {
  test.each([
    ["Claude model not found (404)", () => claudeStatusError(404), REASONS.modelNotFound],
    ["Claude bad API key (401)", () => claudeStatusError(401), REASONS.modelAccess],
    ["Claude no permission (403)", () => claudeStatusError(403), REASONS.modelAccess],
    ["Claude timeout", () => new Anthropic.APIConnectionTimeoutError(), REASONS.timeout],
    ["Gemini timeout (aborted fetch)", () => new DOMException("This operation was aborted", "AbortError"), REASONS.timeout],
    ["Claude rate limit", () => claudeStatusError(429), REASONS.providerBusy],
    ["Claude connection error", () => new Anthropic.APIConnectionError({ message: "Connection error." }), REASONS.providerBusy],
    ["incomplete translation", () => new IncompleteTranslationError("missing b3"), REASONS.incomplete],
    ["invalid JSON", () => new InvalidOutputError("LLM returned invalid JSON"), REASONS.invalidOutput],
    ["saving failed after translating", () => new AlreadyBilledError("Saving x failed", { cause: googleApiError(503), savingFailed: true }), REASONS.savingFailed],
    ["a chunk timed out after others finished", () => new AlreadyBilledError("timed out (1 of 2 chunks failed)", { cause: new Anthropic.APIConnectionTimeoutError() }), REASONS.timeout],
    ["Claude bad request (400)", () => claudeStatusError(400), REASONS.unexpected],
    ["a plain error", () => new Error("boom"), REASONS.unexpected],
  ])("%s", (_label, makeErr, reason) => {
    expect(modelFailureReason(makeErr())).toBe(reason);
  });
});

describe("inputFailureReason", () => {
  test.each([
    ["Drive file not found", () => googleApiError(404), REASONS.inputNotFound],
    ["Drive file not shared", () => googleApiError(403), REASONS.inputNotFound],
    ["Model Config problem", () => new ModelConfigError("Model Config problem: no rows"), REASONS.modelConfig],
    ["env var unset", () => new MissingSettingError("TRANSLATION_PROMPT_DOC_ID"), REASONS.missingSetting],
    ["anything else", () => new Error("boom"), REASONS.unexpected],
  ])("%s", (_label, makeErr, reason) => {
    expect(inputFailureReason(makeErr())).toBe(reason);
  });
});
