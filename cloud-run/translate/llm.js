const fs = require("fs");
const path = require("path");

const Anthropic = require("@anthropic-ai/sdk");
const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");
const { GoogleGenAI } = require("@google/genai");
const { StatusCodes } = require("http-status-codes");
const { Agent, setGlobalDispatcher } = require("undici");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const PROVIDER_ANTHROPIC = "anthropic";
const PROVIDER_GOOGLE = "google";

// Backends: Vertex AI (service account auth, no API keys) or the direct
// provider APIs (API keys from Secret Manager). LLM_BACKEND picks the order;
// vertex-first falls back to direct while the Vertex migration is verified.
const BACKEND_VERTEX = "vertex";
const BACKEND_DIRECT = "direct";
const BACKEND_ORDER = {
  "vertex-first": [BACKEND_VERTEX, BACKEND_DIRECT],
  "vertex-only": [BACKEND_VERTEX],
  "direct-only": [BACKEND_DIRECT],
};
const DEFAULT_BACKEND_MODE = "vertex-first";
const DEFAULT_VERTEX_LOCATION = "us";

// Fall back only on errors raised before any generation work (auth, model not
// enabled/available, quota). Timeouts, 5xx, and bad output are not retried on
// the other backend: they can come after minutes of work and would double
// cost and latency while hiding the real failure.
const FALLBACK_STATUS_CODES = new Set([
  StatusCodes.UNAUTHORIZED,
  StatusCodes.FORBIDDEN,
  StatusCodes.NOT_FOUND,
  StatusCodes.TOO_MANY_REQUESTS,
]);
// google-auth-library throws plain Errors when no credentials can be found
const MISSING_CREDENTIALS_PATTERN = /default credentials/i;

class VertexNotConfiguredError extends Error {}

// ── Retrying model calls ──────────────────────────────────────────────────
// The SDKs' own retries are off (Claude's default is 2, including timeouts;
// Gemini's JS SDK doesn't retry unless configured). Instead, one rule for every
// model call: retry only temporary errors that fail fast (rate limit, overload,
// connection refused), when the model hasn't generated anything yet. Never retry
// a timeout or anything slow: that call has already been billed and would just
// run out of time again.
const MODEL_RETRIES = 2;
const MODEL_RETRY_BASE_DELAY_MS = 5_000;   // 5 s, then 15 s
const MODEL_RETRY_BACKOFF = 3;
// A failure slower than this may have happened mid-generation (billed), so it isn't retried
const MODEL_RETRY_FAST_FAILURE_MS = 30_000;
// Don't start (or retry) a model call with less time than this left before the
// caller's deadline: a translation needs minutes, so it would only time out.
const MIN_MODEL_ATTEMPT_MS = 60_000;

/** Raised instead of starting a model call when the caller's deadline is too close. Never retried. */
class ModelDeadlineError extends Error {
  constructor(remainingMs) {
    super(`Out of time: ${Math.max(0, Math.round(remainingMs / 1000))} s left before the deadline; ` +
      `a model call needs at least ${MIN_MODEL_ATTEMPT_MS / 1000} s`);
    this.name = "ModelDeadlineError";
  }
}
const MODEL_RETRY_STATUS_CODES = new Set([
  StatusCodes.TOO_MANY_REQUESTS,       // 429 rate limit
  StatusCodes.BAD_GATEWAY,             // 502
  StatusCodes.SERVICE_UNAVAILABLE,     // 503
  529,                                 // Anthropic: overloaded (no StatusCodes name)
]);
// The Claude SDK's errors don't set err.name (it's just "Error"), so they're
// recognized by class: the timeout class extends the connection class, so
// timeouts are checked first.
const CLAUDE_TIMEOUT_CLASS = "APIConnectionTimeoutError";
const CLAUDE_CONNECTION_CLASS = "APIConnectionError";
// Timeouts from the Gemini SDK and Node's fetch (an aborted request, before or
// during the response body)
const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
const TIMEOUT_ERROR_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
// Network failures under Node fetch's "fetch failed" / "terminated" errors
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

/** Constructor names along the error's prototype chain, e.g. APIConnectionTimeoutError, APIConnectionError, … */
function errorClassNames(err) {
  const names = new Set();
  for (let proto = err && Object.getPrototypeOf(err); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    if (proto.constructor?.name) names.add(proto.constructor.name);
  }
  return names;
}

function errorCode(err) {
  return err?.code ?? err?.cause?.code;
}

function isModelTimeout(err) {
  return err instanceof ModelDeadlineError || errorClassNames(err).has(CLAUDE_TIMEOUT_CLASS)
    || TIMEOUT_ERROR_NAMES.has(err?.name) || TIMEOUT_ERROR_CODES.has(errorCode(err));
}

/**
 * Time to give one model attempt: the SDK limit, or less if the caller's
 * deadline is closer. Throws ModelDeadlineError if there isn't enough time left.
 *
 * @param {number|undefined} deadline - Date.now()-style timestamp, or undefined for no deadline
 * @param {number} [now]
 * @returns {number} timeout in ms
 */
function attemptTimeoutMs(deadline, now = Date.now()) {
  if (!deadline) return LLM_TIMEOUT_MS;
  const remaining = deadline - now;
  if (remaining < MIN_MODEL_ATTEMPT_MS) throw new ModelDeadlineError(remaining);
  return Math.min(LLM_TIMEOUT_MS, remaining);
}

/**
 * Why a failed model call is worth retrying, or null if it isn't.
 * Timeouts are checked first: the Claude SDK's timeout error is a subclass of
 * its connection error.
 *
 * @param {Error} err - The error from the model call
 * @returns {string|null}
 */
function modelRetryReason(err) {
  if (isModelTimeout(err)) return null;
  const status = err?.status;
  if (MODEL_RETRY_STATUS_CODES.has(status)) return `HTTP ${status}`;
  if (status === undefined) {
    const code = errorCode(err);
    if (errorClassNames(err).has(CLAUDE_CONNECTION_CLASS)) return "connection error";
    if (CONNECTION_ERROR_CODES.has(code)) return `connection error (${code})`;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a model call, retrying (up to MODEL_RETRIES times, with backoff) only
 * when it fails fast with a temporary error, and only if the retry would
 * still start at least MIN_MODEL_ATTEMPT_MS before the deadline. Anything else
 * is thrown as is.
 *
 * @param {() => Promise<*>} fn - One attempt at the model call
 * @param {{retries?: number, baseDelayMs?: number, wait?: Function, now?: Function, deadline?: number}} [options]
 *   deadline: Date.now()-style timestamp the whole call must finish by; the rest are for tests
 */
async function withModelRetry(fn, { retries = MODEL_RETRIES, baseDelayMs = MODEL_RETRY_BASE_DELAY_MS,
  wait = sleep, now = Date.now, deadline } = {}) {
  for (let attempt = 0; ; attempt++) {
    const started = now();
    try {
      return await fn();
    } catch (err) {
      const reason = modelRetryReason(err);
      const fast = now() - started < MODEL_RETRY_FAST_FAILURE_MS;
      if (!reason || !fast || attempt >= retries) throw err;
      const delayMs = baseDelayMs * MODEL_RETRY_BACKOFF ** attempt;
      // No retry that couldn't get a useful amount of time before the deadline
      if (deadline && deadline - now() - delayMs < MIN_MODEL_ATTEMPT_MS) throw err;
      console.warn(`Model call failed (${reason}); retry ${attempt + 1} of ${retries} in ${delayMs / 1000}s`);
      await wait(delayMs);
    }
  }
}

const SCHEMA_DIR = __dirname;
const SCHEMA_PATHS = {
  [PROVIDER_ANTHROPIC]: path.join(SCHEMA_DIR, "translation-schema-claude.json"),
  [PROVIDER_GOOGLE]: path.join(SCHEMA_DIR, "translation-schema-gemini.json"),
};

// Large documents (e.g. 438 blocks) need ~64k output tokens on Claude; 65536 truncated them
const DEFAULT_MAX_TOKENS = 128_000;
const LLM_TIMEOUT_MS = 600_000;

// Node's fetch aborts a request that sends no response headers within 300 s
// (UND_ERR_HEADERS_TIMEOUT, surfaced as "fetch failed"). Vertex sends headers
// only when the model starts its answer, and gemini-4-carbon can think for
// longer than that. Let the SDK timeouts above be the only limit.
setGlobalDispatcher(new Agent({ headersTimeout: LLM_TIMEOUT_MS, bodyTimeout: LLM_TIMEOUT_MS }));
// No SDK retries for Claude: a timed-out call has already been billed for the
// tokens it generated, and each retry repeats the full cost. withModelRetry
// (below) retries only fast, temporary errors; Pub/Sub redelivery (capped by
// the dead-letter policy) covers the rest.
const CLAUDE_MAX_RETRIES = 0;

function loadTranslationSchema(provider) {
  const schemaPath = SCHEMA_PATHS[provider];
  if (!schemaPath) {
    throw new Error(`No translation schema for provider: ${provider}`);
  }
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
}

function vertexSettings() {
  const project = process.env.VERTEX_PROJECT_ID;
  if (!project) {
    throw new VertexNotConfiguredError("VERTEX_PROJECT_ID is not set");
  }
  return { project, location: process.env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION };
}

function makeClaudeClient(backend, timeoutMs = LLM_TIMEOUT_MS) {
  if (backend === BACKEND_VERTEX) {
    const { project, location } = vertexSettings();
    return new AnthropicVertex({ projectId: project, region: location, timeout: timeoutMs, maxRetries: CLAUDE_MAX_RETRIES });
  }
  return new Anthropic({ timeout: timeoutMs, maxRetries: CLAUDE_MAX_RETRIES });
}

function makeGeminiClient(backend, timeoutMs = LLM_TIMEOUT_MS) {
  // Same limit as Claude so a stuck call fails before Cloud Run kills the request
  const httpOptions = { timeout: timeoutMs };
  if (backend === BACKEND_VERTEX) {
    const { project, location } = vertexSettings();
    return new GoogleGenAI({ vertexai: true, project, location, httpOptions });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions });
}

// Model Config "Effort" column -> Gemini thinking level. Gemini 3.8 Flash and
// gemini-4-carbon accept LOW/MEDIUM/HIGH (not MINIMAL). Long default thinking
// made gemini-4-carbon return 5 of 438 blocks; LOW returned all of them.
const GEMINI_THINKING_LEVELS = new Set(["LOW", "MEDIUM", "HIGH"]);

function geminiThinkingLevel(effort) {
  const level = String(effort).trim().toUpperCase();
  if (!GEMINI_THINKING_LEVELS.has(level)) {
    throw new Error(`Unsupported Gemini effort "${effort}" in Model Config (use low, medium or high)`);
  }
  return level;
}

/**
 * Why this error justifies retrying on the direct API, or null if it doesn't.
 * Both SDKs' API errors carry a numeric HTTP `status`.
 */
function fallbackReason(err) {
  if (err instanceof VertexNotConfiguredError) {
    return "vertex not configured";
  }
  if (typeof err?.status === "number" && FALLBACK_STATUS_CODES.has(err.status)) {
    return `HTTP ${err.status}: ${err.name || err.constructor.name}`;
  }
  if (MISSING_CREDENTIALS_PATTERN.test(err?.message || "")) {
    return "credentials: no default credentials";
  }
  return null;
}

function backendOrder() {
  const mode = process.env.LLM_BACKEND || DEFAULT_BACKEND_MODE;
  if (!BACKEND_ORDER[mode]) {
    throw new Error(`Unknown LLM_BACKEND: ${mode}`);
  }
  return BACKEND_ORDER[mode];
}

async function callClaude(client, prompt, { model, maxTokens = DEFAULT_MAX_TOKENS, outputSchema, effort } = {}) {
  const kwargs = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };

  if (outputSchema || effort) {
    kwargs.output_config = {};
    if (outputSchema) {
      kwargs.output_config.format = {
        type: "json_schema",
        schema: outputSchema,
      };
    }
    if (effort) {
      kwargs.output_config.effort = effort;
    }
  }

  const response = await client.messages.create(kwargs);
  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
  const textBlock = response.content.find((b) => b.type === "text");
  return { text: textBlock.text, usage, stop_reason: response.stop_reason };
}

async function callGemini(client, prompt, { model, outputSchema, effort } = {}) {
  const kwargs = {
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {},
  };

  if (outputSchema) {
    kwargs.config.responseMimeType = "application/json";
    kwargs.config.responseSchema = outputSchema;
  }
  if (effort) {
    kwargs.config.thinkingConfig = { thinkingLevel: geminiThinkingLevel(effort) };
  }

  // Stream: a non-streaming call sends no headers until generation finishes,
  // and Node's fetch aborts after 300 s without headers ("fetch failed").
  // gemini-4-carbon needs ~550 s for a 438-block document.
  const stream = await client.models.generateContentStream(kwargs);
  let text = "";
  let meta, finishReason;
  for await (const chunk of stream) {
    text += chunk.text ?? "";
    meta = chunk.usageMetadata ?? meta;
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
  }
  const usage = {
    input_tokens: meta?.promptTokenCount,
    output_tokens: meta?.candidatesTokenCount,
    // Billed as output on top of output_tokens (unlike Claude, whose output_tokens include thinking)
    thinking_tokens: meta?.thoughtsTokenCount || 0,
  };
  return { text, usage, stop_reason: finishReason };
}

async function callLlmOnce(provider, model, prompt, { effort, deadline } = {}) {
  const outputSchema = loadTranslationSchema(provider);

  const providerCalls = {
    [PROVIDER_ANTHROPIC]: [makeClaudeClient, (client) => callClaude(client, prompt, { model, outputSchema, effort })],
    [PROVIDER_GOOGLE]: [makeGeminiClient, (client) => callGemini(client, prompt, { model, outputSchema, effort })],
  };
  if (!providerCalls[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const [makeClient, call] = providerCalls[provider];

  const backends = backendOrder();
  let reason = null;
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i];
    let result;
    try {
      result = await call(makeClient(backend, attemptTimeoutMs(deadline)));
    } catch (err) {
      reason = fallbackReason(err);
      const isLast = i === backends.length - 1;
      if (!reason || isLast) {
        throw err;
      }
      console.warn(`${provider} via ${backend} failed (${reason}); falling back to ${backends[i + 1]}`);
      continue;
    }
    result.usage.llm_backend = backend;
    if (reason) {
      result.usage.llm_fallback_reason = reason;
    }
    return result;
  }
}


/**
 * Call the model (Vertex first, falling back to the direct API per
 * LLM_BACKEND), retrying fast, temporary failures (see withModelRetry).
 *
 * @param {{effort?: string, deadline?: number}} [options] - deadline: Date.now()-style
 *   timestamp the call must finish by. Each attempt gets only the time left, and
 *   nothing starts with less than MIN_MODEL_ATTEMPT_MS to go (ModelDeadlineError).
 */
async function callLlm(provider, model, prompt, { effort, deadline } = {}) {
  const start = Date.now();
  let attempts = 0;
  const result = await withModelRetry(() => {
    attempts += 1;
    return callLlmOnce(provider, model, prompt, { effort, deadline });
  }, { deadline });
  // Whole call, as before retries were ours: fallback, retries and the waits between them
  result.usage.duration_ms = Date.now() - start;
  if (attempts > 1) {
    result.usage.model_retries = attempts - 1;
  }
  return result;
}

module.exports = {
  withModelRetry,
  attemptTimeoutMs,
  ModelDeadlineError,
  MIN_MODEL_ATTEMPT_MS,
  LLM_TIMEOUT_MS,
  isModelTimeout,
  modelRetryReason,
  MODEL_RETRIES,
  callClaude,
  callGemini,
  geminiThinkingLevel,
  callLlm,
  fallbackReason,
  makeClaudeClient,
  makeGeminiClient,
  BACKEND_VERTEX,
  BACKEND_DIRECT,
  loadTranslationSchema,
  PROVIDER_ANTHROPIC,
  PROVIDER_GOOGLE,
  DEFAULT_MAX_TOKENS,
};
