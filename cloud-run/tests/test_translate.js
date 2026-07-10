const { StatusCodes } = require("../translate/node_modules/http-status-codes");

const { translate, parseInput } = require("../translate/index.js");
const {
  formatGlossaryEntry,
  formatGlossary,
  buildTranslationPrompt,
  GLOSSARY_COLUMNS,
} = require("../translate/prompt-assembly.js");
const {
  loadTranslationSchema,
  PROVIDER_ANTHROPIC,
  PROVIDER_GOOGLE,
} = require("../translate/llm.js");

// --- Mock loaders so tests don't hit Google APIs ---

jest.mock("../translate/loaders.js", () => ({
  loadDoc: jest.fn(),
  loadSheet: jest.fn(),
  loadExtractionJson: jest.fn(),
  loadConfig: jest.fn(),
  writeOutput: jest.fn(),
  logTranslationResult: jest.fn().mockResolvedValue(),
}));

jest.mock("../translate/doc-writer.js", () => ({
  createTranslationDoc: jest.fn().mockResolvedValue("mock-doc-id"),
}));

const { createTranslationDoc } = require("../translate/doc-writer.js");

const {
  loadDoc,
  loadSheet,
  loadExtractionJson,
  loadConfig,
  writeOutput,
  logTranslationResult,
} = require("../translate/loaders.js");

// --- Mock llm so tests don't call real LLMs ---

jest.mock("../translate/llm.js", () => {
  const actual = jest.requireActual("../translate/llm.js");
  return {
    ...actual,
    callLlm: jest.fn(),
  };
});

const { callLlm } = require("../translate/llm.js");

// --- parseInput ---

describe("parseInput", () => {
  test("returns body as-is for direct HTTP call", () => {
    const body = { extractionFileId: "abc", sourceFileName: "test.pdf" };
    expect(parseInput(body)).toEqual(body);
  });

  test("returns body as-is when message has no data", () => {
    const body = { message: {}, extractionFileId: "abc" };
    expect(parseInput(body)).toEqual(body);
  });

  test("decodes Pub/Sub push envelope", () => {
    const payload = { extractionFileId: "abc", sourceFileName: "test.pdf" };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const body = { message: { data: encoded } };

    expect(parseInput(body)).toEqual(payload);
  });

  test("throws on invalid base64 JSON in Pub/Sub envelope", () => {
    const encoded = Buffer.from("not json").toString("base64");
    const body = { message: { data: encoded } };

    expect(() => parseInput(body)).toThrow();
  });
});

// --- translate (HTTP handler) ---

describe("translate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  }

  test("returns 204 when body is empty", async () => {
    const res = mockRes();
    await translate({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.NO_CONTENT);
  });

  test("returns 204 when extractionFileId is missing", async () => {
    const res = mockRes();
    await translate({ body: { sourceFileName: "test.pdf" } }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.NO_CONTENT);
  });

  test("returns 204 for invalid Pub/Sub envelope", async () => {
    const res = mockRes();
    const encoded = Buffer.from("not json").toString("base64");
    await translate({ body: { message: { data: encoded } } }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.NO_CONTENT);
  });

  test("returns 500 with structured error when prompt assembly fails", async () => {
    loadExtractionJson.mockRejectedValue(new Error("TRANSLATION_PROMPT_DOC_ID not set in .env"));

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Prompt assembly failed") })
    );
  });

  test("returns 500 when config loading fails", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockRejectedValue(new Error("Config sheet not found"));

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Failed to load model config") })
    );
  });

  test("returns 500 when no active translate models in config", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [{ role: "extract", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("No active translate models") })
    );
  });

  test("calls LLM and returns translations for valid direct call", async () => {
    const extractionJson = { blocks: [{ id: "b01", text: "Hello", translate: true }] };
    const basePrompt = "Translate the following. [Paste content to be translated in the area below]";

    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue(basePrompt);
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue('{"translated_text": "Hola"}');
    writeOutput.mockResolvedValue("output-file-id");

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf", sourceFileId: "src456" } },
      res
    );

    expect(callLlm).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", expect.any(String));
    expect(writeOutput).toHaveBeenCalledWith("test_anthropic_claude-sonnet-4-6.json", {
      translated_text: "Hola",
      sourceFileId: "src456",
      extractionFileId: "file123",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        extractionFileId: "file123",
        sourceFileName: "test.pdf",
        translations: [
          expect.objectContaining({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            outputFileId: "output-file-id",
            status: "translated",
          }),
        ],
      })
    );
  });

  test("runs multiple active models in parallel", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [
        { role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true },
        { role: "translate", provider: "google", model: "gemini-3.1-pro-preview", active: true },
        { role: "translate", provider: "google", model: "gemini-3.5-flash", active: false },
      ],
    });
    callLlm.mockResolvedValue('{"translated_text": "Hola"}');
    writeOutput.mockResolvedValue("out-id");

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "doc.pdf" } },
      res
    );

    expect(callLlm).toHaveBeenCalledTimes(2);
    const result = res.json.mock.calls[0][0];
    expect(result.translations).toHaveLength(2);
  });

  test("returns 500 when all translation models fail", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [
        { role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true },
        { role: "translate", provider: "google", model: "gemini-3.1-pro-preview", active: true },
      ],
    });
    callLlm
      .mockRejectedValueOnce(new Error("Anthropic rate limit"))
      .mockRejectedValueOnce(new Error("Gemini API key missing"));

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR);
    const result = res.json.mock.calls[0][0];
    expect(result.error).toBe("All translation models failed");
    expect(result.translations).toHaveLength(2);
    expect(result.translations[0]).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("Anthropic rate limit"),
    }));
    expect(result.translations[1]).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("Gemini API key missing"),
    }));
  });

  test("reports per-model errors without failing the whole request", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [
        { role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true },
        { role: "translate", provider: "google", model: "gemini-3.1-pro-preview", active: true },
      ],
    });
    callLlm
      .mockResolvedValueOnce('{"translated_text": "Hola"}')
      .mockRejectedValueOnce(new Error("Gemini API key missing"));
    writeOutput.mockResolvedValue("out-id");

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf" } },
      res
    );

    const result = res.json.mock.calls[0][0];
    expect(result.status).toBe("partial");
    expect(result.translations[0].outputFileId).toBe("out-id");
    expect(result.translations[1].error).toContain("Gemini API key missing");
  });

  test("handles Pub/Sub envelope end-to-end", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue('{"translated_text": "Hola"}');
    writeOutput.mockResolvedValue("out-id");

    const payload = {
      extractionFileId: "file123",
      sourceFileName: "test.pdf",
      sourceFileId: "src456",
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = mockRes();
    await translate({ body: { message: { data: encoded } } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        extractionFileId: "file123",
      })
    );
  });
});

// --- formatGlossaryEntry ---

describe("formatGlossaryEntry", () => {
  test("returns null for row with no english term", () => {
    expect(formatGlossaryEntry({})).toBeNull();
    expect(formatGlossaryEntry({ [GLOSSARY_COLUMNS.ENGLISH_TERM]: "" })).toBeNull();
  });

  test("formats entry with just the term", () => {
    const row = { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave" };
    expect(formatGlossaryEntry(row)).toBe("actual leave");
  });

  test("includes acronym in parentheses after term", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "Family and Medical Leave Insurance",
      [GLOSSARY_COLUMNS.ACRONYM]: "FAMLI",
    };
    expect(formatGlossaryEntry(row)).toContain("Family and Medical Leave Insurance (FAMLI)");
  });

  test("includes approved spanish translation", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
      [GLOSSARY_COLUMNS.APPROVED_SPANISH]: "duración real de la ausencia",
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain("Approved Spanish: duración real de la ausencia");
  });

  test("includes forbidden terms", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
      [GLOSSARY_COLUMNS.FORBIDDEN_TERMS]: "permiso, baja",
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain("Forbidden: permiso, baja");
  });

  test("includes definition", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
      [GLOSSARY_COLUMNS.DEFINITION]: "The total amount of continuous time away from work",
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain("Definition: The total amount of continuous time away from work");
  });

  test("includes example pair when both english and spanish present", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
      [GLOSSARY_COLUMNS.EXAMPLE_ENGLISH]: "Your actual leave duration",
      [GLOSSARY_COLUMNS.EXAMPLE_SPANISH]: "La duración real de su ausencia",
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain('Example: "Your actual leave duration" → "La duración real de su ausencia"');
  });

  test("omits example when only one language present", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
      [GLOSSARY_COLUMNS.EXAMPLE_ENGLISH]: "Your actual leave duration",
    };
    const result = formatGlossaryEntry(row);
    expect(result).not.toContain("Example:");
  });

  test("includes notes", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "Authorized Officer",
      [GLOSSARY_COLUMNS.NOTES]: 'Translate "leave" in this context as "ausencia"',
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain("Notes:");
  });

  test("formats a full entry with all fields", () => {
    const row = {
      [GLOSSARY_COLUMNS.ENGLISH_TERM]: "Authorized Officer",
      [GLOSSARY_COLUMNS.ACRONYM]: "AO",
      [GLOSSARY_COLUMNS.APPROVED_SPANISH]: "oficial autorizado",
      [GLOSSARY_COLUMNS.FORBIDDEN_TERMS]: "Do not capitalize in Spanish",
      [GLOSSARY_COLUMNS.DEFINITION]: "A representative of the employer",
      [GLOSSARY_COLUMNS.EXAMPLE_ENGLISH]: "Contact your Authorized Officer",
      [GLOSSARY_COLUMNS.EXAMPLE_SPANISH]: "Comuníquese con su oficial autorizado",
      [GLOSSARY_COLUMNS.NOTES]: "Always write the English term after",
    };
    const result = formatGlossaryEntry(row);
    expect(result).toContain("Authorized Officer (AO)");
    expect(result).toContain("Approved Spanish:");
    expect(result).toContain("Forbidden:");
    expect(result).toContain("Definition:");
    expect(result).toContain("Example:");
    expect(result).toContain("Notes:");
  });
});

// --- formatGlossary ---

describe("formatGlossary", () => {
  test("returns empty string for null", () => {
    expect(formatGlossary(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(formatGlossary(undefined)).toBe("");
  });

  test("returns empty string for empty array", () => {
    expect(formatGlossary([])).toBe("");
  });

  test("filters out rows with no english term", () => {
    const rows = [
      { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "" },
      { [GLOSSARY_COLUMNS.APPROVED_SPANISH]: "something" },
    ];
    expect(formatGlossary(rows)).toBe("");
  });

  test("joins multiple entries with double newlines", () => {
    const rows = [
      { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave" },
      { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "appeal" },
    ];
    const result = formatGlossary(rows);
    expect(result).toBe("actual leave\n\nappeal");
  });
});

// --- buildTranslationPrompt ---

describe("buildTranslationPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("assembles prompt with extraction JSON and no glossary", async () => {
    const extractionJson = {
      page_metadata: { page_number: 1 },
      blocks: [{ id: "b01", text: "Hello", translate: true }],
      non_translatable_elements: [],
      translation_warnings: [],
    };
    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue(
      "Translate this. [Paste content to be translated in the area below]"
    );
    loadSheet.mockResolvedValue([]);

    const prompt = await buildTranslationPrompt("file123");

    expect(loadExtractionJson).toHaveBeenCalledWith("file123");
    expect(prompt).toContain("Translate this.");
    expect(prompt).not.toContain("[Paste content to be translated in the area below]");
    expect(prompt).toContain("<extraction_context>");
    expect(prompt).toContain("<extraction>");
    expect(prompt).toContain('"id": "b01"');
    expect(prompt).not.toContain("<glossary>");
  });

  test("includes glossary when sheet has data", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([
      {
        [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
        [GLOSSARY_COLUMNS.APPROVED_SPANISH]: "duración real de la ausencia",
      },
    ]);

    const prompt = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<glossary>");
    expect(prompt).toContain("actual leave");
    expect(prompt).toContain("duración real de la ausencia");
  });

  test("continues without glossary when sheet loading fails", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockRejectedValue(new Error("GLOSSARY_SHEET_ID not set in .env"));

    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const prompt = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<extraction>");
    expect(prompt).not.toContain("<glossary>");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("prompt sections appear in correct order", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([
      { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "term" },
    ]);

    const prompt = await buildTranslationPrompt("file123");

    const contextIdx = prompt.indexOf("<extraction_context>");
    const extractionIdx = prompt.indexOf("<extraction>");
    const glossaryIdx = prompt.indexOf("<glossary>");

    expect(contextIdx).toBeLessThan(extractionIdx);
    expect(extractionIdx).toBeLessThan(glossaryIdx);
  });
});

// --- loadTranslationSchema ---

describe("loadTranslationSchema", () => {
  test("loads Claude schema with additionalProperties", () => {
    const schema = loadTranslationSchema(PROVIDER_ANTHROPIC);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.blocks).toBeDefined();
    expect(schema.properties.metadata).toBeDefined();
  });

  test("loads Gemini schema without additionalProperties", () => {
    const schema = loadTranslationSchema(PROVIDER_GOOGLE);
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.blocks).toBeDefined();
    expect(schema.properties.metadata).toBeDefined();
  });

  test("throws for unknown provider", () => {
    expect(() => loadTranslationSchema("openai")).toThrow("No translation schema for provider");
  });

  test("both schemas have the same required fields", () => {
    const claude = loadTranslationSchema(PROVIDER_ANTHROPIC);
    const gemini = loadTranslationSchema(PROVIDER_GOOGLE);
    expect(claude.required).toEqual(gemini.required);
  });
});

// --- formatTimestamp ---

const { formatTimestamp } = jest.requireActual("../translate/loaders.js");

describe("formatTimestamp", () => {
  test("produces MM/DD/YYYY HH:MM with no comma", () => {
    const result = formatTimestamp(new Date(2026, 6, 8, 14, 5));
    expect(result).toBe("07/08/2026 14:05");
  });

  test("zero-pads single-digit month and day", () => {
    const result = formatTimestamp(new Date(2026, 0, 3, 9, 7));
    expect(result).toBe("01/03/2026 09:07");
  });

  test("handles midnight", () => {
    const result = formatTimestamp(new Date(2026, 11, 25, 0, 0));
    expect(result).toBe("12/25/2026 00:00");
  });
});
