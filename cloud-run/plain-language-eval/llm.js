const fs = require("fs");
const path = require("path");

const Anthropic = require("@anthropic-ai/sdk");
const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");
const { GoogleGenAI } = require("@google/genai");
const { StatusCodes } = require("http-status-codes");

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
const MODEL_RETRY_STATUS_CODES = new Set([
  StatusCodes.TOO_MANY_REQUESTS,       // 429 rate limit
  StatusCodes.BAD_GATEWAY,             // 502
  StatusCodes.SERVICE_UNAVAILABLE,     // 503
  529,                                 // Anthropic: overloaded (no StatusCodes name)
]);
// Timeouts from the Claude SDK, the Gemini SDK (an aborted fetch) and Node's fetch
const TIMEOUT_ERROR_NAMES = new Set(["APIConnectionTimeoutError", "AbortError", "TimeoutError"]);
const TIMEOUT_ERROR_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
// Network failures (Claude SDK's connection error; Node fetch's "fetch failed" causes)
const CONNECTION_ERROR_NAMES = new Set(["APIConnectionError"]);
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

function isModelTimeout(err) {
  return TIMEOUT_ERROR_NAMES.has(err?.name) || TIMEOUT_ERROR_CODES.has(err?.cause?.code)
    || TIMEOUT_ERROR_CODES.has(err?.code);
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
    const code = err?.cause?.code || err?.code;
    if (CONNECTION_ERROR_NAMES.has(err?.name)) return "connection error";
    if (CONNECTION_ERROR_CODES.has(code)) return `connection error (${code})`;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a model call, retrying (up to MODEL_RETRIES times, with backoff) only
 * when it fails fast with a temporary error. Anything else is thrown as is.
 *
 * @param {() => Promise<*>} fn - One attempt at the model call
 * @param {{retries?: number, baseDelayMs?: number, wait?: Function, now?: Function}} [options] - for tests
 */
async function withModelRetry(fn, { retries = MODEL_RETRIES, baseDelayMs = MODEL_RETRY_BASE_DELAY_MS,
  wait = sleep, now = Date.now } = {}) {
  for (let attempt = 0; ; attempt++) {
    const started = now();
    try {
      return await fn();
    } catch (err) {
      const reason = modelRetryReason(err);
      const fast = now() - started < MODEL_RETRY_FAST_FAILURE_MS;
      if (!reason || !fast || attempt >= retries) throw err;
      const delayMs = baseDelayMs * MODEL_RETRY_BACKOFF ** attempt;
      console.warn(`Model call failed (${reason}); retry ${attempt + 1} of ${retries} in ${delayMs / 1000}s`);
      await wait(delayMs);
    }
  }
}

const SCHEMA_DIR = __dirname;
const SCHEMA_PATHS = {
  [PROVIDER_ANTHROPIC]: path.join(SCHEMA_DIR, "plain-language-schema-claude.json"),
  [PROVIDER_GOOGLE]: path.join(SCHEMA_DIR, "plain-language-schema-gemini.json"),
};

const DEFAULT_MAX_TOKENS = 65536;
const LLM_TIMEOUT_MS = 240_000;
// No Claude SDK retries: withModelRetry (below) decides what's worth retrying
const CLAUDE_MAX_RETRIES = 0;

function loadEvalSchema(provider) {
  const schemaPath = SCHEMA_PATHS[provider];
  if (!schemaPath) {
    throw new Error(`No plain language eval schema for provider: ${provider}`);
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

function makeClaudeClient(backend) {
  if (backend === BACKEND_VERTEX) {
    const { project, location } = vertexSettings();
    return new AnthropicVertex({ projectId: project, region: location, timeout: LLM_TIMEOUT_MS, maxRetries: CLAUDE_MAX_RETRIES });
  }
  return new Anthropic({ timeout: LLM_TIMEOUT_MS, maxRetries: CLAUDE_MAX_RETRIES });
}

function makeGeminiClient(backend) {
  if (backend === BACKEND_VERTEX) {
    const { project, location } = vertexSettings();
    return new GoogleGenAI({ vertexai: true, project, location });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

async function callClaude(client, prompt, { model, maxTokens = DEFAULT_MAX_TOKENS, outputSchema, pdfBase64 } = {}) {

  const content = [];
  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }
  content.push({ type: "text", text: prompt });

  const kwargs = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };

  if (outputSchema) {
    kwargs.output_config = {
      format: {
        type: "json_schema",
        schema: outputSchema,
      },
    };
  }

  const response = await client.messages.create(kwargs);
  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
  const textBlock = response.content.find((b) => b.type === "text");
  return { text: textBlock.text, usage, stop_reason: response.stop_reason };
}

async function callGemini(client, prompt, { model, outputSchema, pdfBase64 } = {}) {

  const parts = [];
  if (pdfBase64) {
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBase64,
      },
    });
  }
  parts.push({ text: prompt });

  const kwargs = {
    model,
    contents: [{ role: "user", parts }],
  };

  if (outputSchema) {
    kwargs.config = {
      responseMimeType: "application/json",
      responseSchema: outputSchema,
    };
  }

  const response = await client.models.generateContent(kwargs);
  const meta = response.usageMetadata;
  const usage = {
    input_tokens: meta.promptTokenCount,
    output_tokens: meta.candidatesTokenCount,
  };
  const finishReason = response.candidates?.[0]?.finishReason;
  return { text: response.text, usage, stop_reason: finishReason };
}

async function callLlmOnce(provider, model, prompt, pdfBase64 = null) {
  const outputSchema = loadEvalSchema(provider);
  const start = Date.now();

  const providerCalls = {
    [PROVIDER_ANTHROPIC]: [makeClaudeClient, (client) => callClaude(client, prompt, { model, outputSchema, pdfBase64 })],
    [PROVIDER_GOOGLE]: [makeGeminiClient, (client) => callGemini(client, prompt, { model, outputSchema, pdfBase64 })],
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
      result = await call(makeClient(backend));
    } catch (err) {
      reason = fallbackReason(err);
      const isLast = i === backends.length - 1;
      if (!reason || isLast) {
        throw err;
      }
      console.warn(`${provider} via ${backend} failed (${reason}); falling back to ${backends[i + 1]}`);
      continue;
    }
    result.usage.duration_ms = Date.now() - start;
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
 */
async function callLlm(provider, model, prompt, pdfBase64 = null) {
  return withModelRetry(() => callLlmOnce(provider, model, prompt, pdfBase64));
}

module.exports = {
  withModelRetry,
  modelRetryReason,
  MODEL_RETRIES,
  callClaude,
  callGemini,
  callLlm,
  fallbackReason,
  makeClaudeClient,
  makeGeminiClient,
  BACKEND_VERTEX,
  BACKEND_DIRECT,
  loadEvalSchema,
  PROVIDER_ANTHROPIC,
  PROVIDER_GOOGLE,
  DEFAULT_MAX_TOKENS,
};
