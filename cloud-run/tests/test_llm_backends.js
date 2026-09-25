// Vertex-first / direct-fallback behavior of the JS LLM wrappers (translate and
// plain-language-eval share the same backend logic). The provider SDKs are
// mocked; each function resolves them from its own node_modules, so each path
// is mocked separately.

const mockClaudeDirect = jest.fn();
const mockClaudeVertex = jest.fn();
const mockGemini = jest.fn();

function mockAnthropicModule(actualPath) {
  const actual = jest.requireActual(actualPath);
  function Anthropic() {
    return { messages: { create: mockClaudeDirect } };
  }
  Object.assign(Anthropic, actual);
  return Anthropic;
}

function mockVertexModule() {
  return {
    AnthropicVertex: jest.fn().mockImplementation(() => ({ messages: { create: mockClaudeVertex } })),
  };
}

// Not requireActual: under Jest, @google/genai resolves to its ESM build, which
// Jest can't load. Only GoogleGenAI is used by the code under test.
function mockGenAIModule() {
  return {
    GoogleGenAI: jest.fn().mockImplementation((opts) => ({
      models: { generateContent: (req) => mockGemini(opts.vertexai ? "vertex" : "direct", req) },
    })),
  };
}

jest.mock("../translate/node_modules/@anthropic-ai/sdk", () => mockAnthropicModule("../translate/node_modules/@anthropic-ai/sdk"));
jest.mock("../translate/node_modules/@anthropic-ai/vertex-sdk", () => mockVertexModule());
// Mock the file the code actually loads: require("@google/genai") resolves via
// the package "exports" map (index.cjs), not the "main" field a directory path hits.
jest.mock(require.resolve("@google/genai", { paths: [require("path").join(__dirname, "../translate")] }), () => mockGenAIModule());
jest.mock("../plain-language-eval/node_modules/@anthropic-ai/sdk", () => mockAnthropicModule("../plain-language-eval/node_modules/@anthropic-ai/sdk"));
jest.mock("../plain-language-eval/node_modules/@anthropic-ai/vertex-sdk", () => mockVertexModule());
jest.mock(require.resolve("@google/genai", { paths: [require("path").join(__dirname, "../plain-language-eval")] }), () => mockGenAIModule());

const Anthropic = jest.requireActual("../translate/node_modules/@anthropic-ai/sdk");

const VERTEX_ENV = { VERTEX_PROJECT_ID: "proj", VERTEX_LOCATION: "us" };
const BACKEND_ENV_KEYS = ["VERTEX_PROJECT_ID", "VERTEX_LOCATION", "LLM_BACKEND"];

function claudeResponse() {
  return {
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "text", text: "{}" }],
    stop_reason: "end_turn",
  };
}

function geminiResponse() {
  return {
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 75 },
    text: "{}",
    candidates: [{ finishReason: "STOP" }],
  };
}

// Shape of @google/genai's ApiError: an Error with a numeric HTTP status
function geminiStatusError(status) {
  return Object.assign(new Error("gemini error"), { name: "ApiError", status });
}

function anthropicStatusError(status) {
  return Anthropic.APIError.generate(status, { type: "error" }, "error", new Headers());
}

const FUNCTIONS = [
  {
    name: "translate",
    dir: "translate",
    llm: () => require("../translate/llm.js"),
    call: (llm, provider, model) => llm.callLlm(provider, model, "prompt", { effort: "high" }),
  },
  {
    name: "plain-language-eval",
    dir: "plain-language-eval",
    llm: () => require("../plain-language-eval/llm.js"),
    call: (llm, provider, model) => llm.callLlm(provider, model, "prompt", "pdfbase64"),
  },
];

describe.each(FUNCTIONS)("$name LLM backends", ({ dir, llm: loadLlm, call }) => {
  let llm;
  let savedEnv;

  beforeEach(() => {
    llm = loadLlm();
    savedEnv = Object.fromEntries(BACKEND_ENV_KEYS.map((k) => [k, process.env[k]]));
    BACKEND_ENV_KEYS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, VERTEX_ENV);
    mockClaudeDirect.mockReset();
    mockClaudeVertex.mockReset();
    mockGemini.mockReset();
    jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    BACKEND_ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    console.warn.mockRestore();
  });

  test("Claude uses Vertex first", async () => {
    mockClaudeVertex.mockResolvedValue(claudeResponse());

    const { usage } = await call(llm, "anthropic", "claude-sonnet-4-6");

    expect(mockClaudeVertex).toHaveBeenCalledTimes(1);
    expect(mockClaudeDirect).not.toHaveBeenCalled();
    expect(usage.llm_backend).toBe("vertex");
    expect(usage.llm_fallback_reason).toBeUndefined();
    expect(typeof usage.duration_ms).toBe("number");
  });

  test("Gemini uses Vertex first", async () => {
    mockGemini.mockResolvedValue(geminiResponse());

    const { usage } = await call(llm, "google", "gemini-3.5-flash");

    expect(mockGemini.mock.calls.map((c) => c[0])).toEqual(["vertex"]);
    expect(usage.llm_backend).toBe("vertex");
  });

  test.each([401, 403, 404, 429])("Claude falls back to direct on HTTP %i", async (status) => {
    mockClaudeVertex.mockRejectedValue(anthropicStatusError(status));
    mockClaudeDirect.mockResolvedValue(claudeResponse());

    const { usage } = await call(llm, "anthropic", "claude-sonnet-4-6");

    expect(mockClaudeDirect).toHaveBeenCalledTimes(1);
    expect(usage.llm_backend).toBe("direct");
    expect(usage.llm_fallback_reason).toContain(`HTTP ${status}`);
  });

  test("Gemini falls back to direct when the model isn't found on Vertex", async () => {
    mockGemini
      .mockRejectedValueOnce(geminiStatusError(404))
      .mockResolvedValueOnce(geminiResponse());

    const { usage } = await call(llm, "google", "gemini-3.5-flash");

    expect(mockGemini.mock.calls.map((c) => c[0])).toEqual(["vertex", "direct"]);
    expect(usage.llm_backend).toBe("direct");
    expect(usage.llm_fallback_reason).toContain("HTTP 404");
  });

  test("falls back when Vertex isn't configured", async () => {
    delete process.env.VERTEX_PROJECT_ID;
    mockClaudeDirect.mockResolvedValue(claudeResponse());

    const { usage } = await call(llm, "anthropic", "claude-sonnet-4-6");

    expect(mockClaudeVertex).not.toHaveBeenCalled();
    expect(usage.llm_backend).toBe("direct");
    expect(usage.llm_fallback_reason).toBe("vertex not configured");
  });

  test("falls back when no default credentials are found", async () => {
    mockClaudeVertex.mockRejectedValue(new Error("Could not load the default credentials."));
    mockClaudeDirect.mockResolvedValue(claudeResponse());

    const { usage } = await call(llm, "anthropic", "claude-sonnet-4-6");

    expect(usage.llm_fallback_reason).toBe("credentials: no default credentials");
  });

  test.each([
    ["HTTP 500", () => anthropicStatusError(500)],
    ["HTTP 400", () => anthropicStatusError(400)],
    ["timeout", () => new Error("Request timed out.")],
  ])("does not fall back on %s", async (_label, makeErr) => {
    const err = makeErr();
    mockClaudeVertex.mockRejectedValue(err);

    await expect(call(llm, "anthropic", "claude-sonnet-4-6")).rejects.toBe(err);
    expect(mockClaudeDirect).not.toHaveBeenCalled();
  });

  test("vertex-only raises instead of falling back", async () => {
    process.env.LLM_BACKEND = "vertex-only";
    const err = anthropicStatusError(404);
    mockClaudeVertex.mockRejectedValue(err);

    await expect(call(llm, "anthropic", "claude-sonnet-4-6")).rejects.toBe(err);
    expect(mockClaudeDirect).not.toHaveBeenCalled();
  });

  test("direct-only skips Vertex", async () => {
    process.env.LLM_BACKEND = "direct-only";
    mockClaudeDirect.mockResolvedValue(claudeResponse());

    const { usage } = await call(llm, "anthropic", "claude-sonnet-4-6");

    expect(mockClaudeVertex).not.toHaveBeenCalled();
    expect(usage.llm_backend).toBe("direct");
    expect(usage.llm_fallback_reason).toBeUndefined();
  });

  test("rejects an unknown LLM_BACKEND", async () => {
    process.env.LLM_BACKEND = "sideways";

    await expect(call(llm, "anthropic", "claude-sonnet-4-6")).rejects.toThrow("Unknown LLM_BACKEND");
  });

  test("Vertex clients use the configured project and location", () => {
    const { AnthropicVertex } = require(`../${dir}/node_modules/@anthropic-ai/vertex-sdk`);
    const { GoogleGenAI } = require(require.resolve("@google/genai", { paths: [require("path").join(__dirname, "..", dir)] }));
    llm.makeClaudeClient("vertex");
    llm.makeGeminiClient("vertex");
    expect(AnthropicVertex).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "proj", region: "us" }));
    expect(GoogleGenAI).toHaveBeenLastCalledWith({ vertexai: true, project: "proj", location: "us" });
  });

  test("Vertex location defaults to us", () => {
    delete process.env.VERTEX_LOCATION;
    const { GoogleGenAI } = require(require.resolve("@google/genai", { paths: [require("path").join(__dirname, "..", dir)] }));
    llm.makeGeminiClient("vertex");
    expect(GoogleGenAI).toHaveBeenLastCalledWith(expect.objectContaining({ location: "us" }));
  });
});
