const fs = require("fs");
const path = require("path");

const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenAI } = require("@google/genai");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const PROVIDER_ANTHROPIC = "anthropic";
const PROVIDER_GOOGLE = "google";

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

async function callClaude(prompt, { model, maxTokens = DEFAULT_MAX_TOKENS, outputSchema, effort } = {}) {
  const client = new Anthropic({ timeout: LLM_TIMEOUT_MS });
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

async function callGemini(prompt, { model, outputSchema } = {}) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

  const response = await ai.models.generateContent(kwargs);
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

  let result;
  if (provider === PROVIDER_ANTHROPIC) {
    result = await callClaude(prompt, { model, outputSchema, effort });
  } else if (provider === PROVIDER_GOOGLE) {
    result = await callGemini(prompt, { model, outputSchema });
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
  result.usage.duration_ms = Date.now() - start;
  return result;
}


module.exports = {
  callClaude,
  callGemini,
  callLlm,
  loadTranslationSchema,
  PROVIDER_ANTHROPIC,
  PROVIDER_GOOGLE,
  DEFAULT_MAX_TOKENS,
};
