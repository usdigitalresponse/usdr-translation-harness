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

const SCHEMA_DIR = __dirname;
const SCHEMA_PATHS = {
  [PROVIDER_ANTHROPIC]: path.join(SCHEMA_DIR, "translation-schema-claude.json"),
  [PROVIDER_GOOGLE]: path.join(SCHEMA_DIR, "translation-schema-gemini.json"),
};

const DEFAULT_MAX_TOKENS = 65536;
const LLM_TIMEOUT_MS = 600_000;

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

function makeClaudeClient(backend) {
  if (backend === BACKEND_VERTEX) {
    const { project, location } = vertexSettings();
    return new AnthropicVertex({ projectId: project, region: location, timeout: LLM_TIMEOUT_MS });
  }
  return new Anthropic({ timeout: LLM_TIMEOUT_MS });
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

async function callGemini(client, prompt, { model, outputSchema } = {}) {
  const kwargs = {
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
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

async function callLlm(provider, model, prompt, { effort } = {}) {
  const outputSchema = loadTranslationSchema(provider);
  const start = Date.now();

  const providerCalls = {
    [PROVIDER_ANTHROPIC]: [makeClaudeClient, (client) => callClaude(client, prompt, { model, outputSchema, effort })],
    [PROVIDER_GOOGLE]: [makeGeminiClient, (client) => callGemini(client, prompt, { model, outputSchema })],
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


module.exports = {
  callClaude,
  callGemini,
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
