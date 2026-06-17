require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenAI } = require("@google/genai");

function createClaudeClient() {
  return new Anthropic();
}

function createGeminiClient() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// Default maxTokens may need per-function tuning once we see real output sizes.
async function callClaude(prompt, { model = "claude-sonnet-4-6", maxTokens = 16384, system, pdfBase64 } = {}) {
  const client = createClaudeClient();
  const content = [];

  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }

  content.push({ type: "text", text: prompt });

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  if (system) params.system = system;

  const response = await client.messages.create(params);

  return response.content[0].text;
}

async function callGemini(prompt, { model = "gemini-3.5-flash", pdfBase64 } = {}) {
  const client = createGeminiClient();
  const parts = [];

  if (pdfBase64) {
    parts.push({
      inlineData: { mimeType: "application/pdf", data: pdfBase64 },
    });
  }

  parts.push({ text: prompt });

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
  });

  return response.text;
}

module.exports = { callClaude, callGemini, createClaudeClient, createGeminiClient };
