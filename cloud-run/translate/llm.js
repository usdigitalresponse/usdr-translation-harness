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

const DEFAULT_MAX_TOKENS = 16384;
const LLM_TIMEOUT_MS = 240_000;

function loadTranslationSchema(provider) {
  const schemaPath = SCHEMA_PATHS[provider];
  if (!schemaPath) {
    throw new Error(`No translation schema for provider: ${provider}`);
  }
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
}

async function callClaude(prompt, { model, maxTokens = DEFAULT_MAX_TOKENS, outputSchema } = {}) {
  const client = new Anthropic({ timeout: LLM_TIMEOUT_MS });
  const kwargs = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
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
  return response.content[0].text;
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
  return response.text;
}

async function callLlm(provider, model, prompt) {
  const outputSchema = loadTranslationSchema(provider);

  if (provider === PROVIDER_ANTHROPIC) {
    return callClaude(prompt, { model, outputSchema });
  }
  if (provider === PROVIDER_GOOGLE) {
    return callGemini(prompt, { model, outputSchema });
  }
  throw new Error(`Unknown provider: ${provider}`);
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
