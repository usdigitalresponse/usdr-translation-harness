const { StatusCodes } = require("../translate/node_modules/http-status-codes");

const { translate, parseInput } = require("../translate/index.js");
const {
  formatGlossaryEntry,
  formatGlossary,
  formatStatutes,
  buildTranslationPrompt,
  buildGlossary,
  GLOSSARY_COLUMNS,
} = require("../translate/prompt-assembly.js");

// The glossary sheet's header row, as the pipeline expects it
const GLOSSARY_HEADERS = Object.values(GLOSSARY_COLUMNS);
const EMPTY_GLOSSARY = { headers: GLOSSARY_HEADERS, rows: [] };

/** A glossary sheet table with the expected headers and these rows. */
function glossaryTable(rows) {
  return { headers: GLOSSARY_HEADERS, rows };
}

/** Structured input-problem logs (glossary etc.) captured by a console.log spy. */
function inputProblems(logSpy) {
  return logSpy.mock.calls
    .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
    .filter((e) => e && e.input_problem);
}
const {
  loadTranslationSchema,
  PROVIDER_ANTHROPIC,
  PROVIDER_GOOGLE,
} = require("../translate/llm.js");

// --- Mock loaders so tests don't hit Google APIs ---

jest.mock("../translate/loaders.js", () => {
  const path = require("path");
  return {
    loadDoc: jest.fn(),
    loadSheetTable: jest.fn(),
    loadExtractionJson: jest.fn(),
    loadConfig: jest.fn(),
    loadStatutes: jest.fn().mockResolvedValue([]),
    loadStatuteUrls: jest.fn().mockReturnValue({}),
    writeOutput: jest.fn(),
    logTranslationResult: jest.fn().mockResolvedValue(),
    stripExtension: (fileName) => path.parse(fileName).name,
  };
});

jest.mock("../translate/doc-writer.js", () => ({
  createTranslationDoc: jest.fn().mockResolvedValue("mock-doc-id"),
}));

jest.mock("../translate/notifier.js", () => ({
  ...jest.requireActual("../translate/notifier.js"),
  notifyDocCreated: jest.fn().mockResolvedValue(),
  notifyDocFailed: jest.fn().mockResolvedValue(),
}));

const { createTranslationDoc } = require("../translate/doc-writer.js");

const {
  loadDoc,
  loadSheetTable,
  loadExtractionJson,
  loadConfig,
  loadStatutes,
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
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
    const basePrompt = "Translate the following.";

    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue(basePrompt);
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 } });
    writeOutput.mockResolvedValue("output-file-id");

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf", sourceFileId: "src456" } },
      res
    );

    expect(callLlm).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6", expect.any(String), { effort: undefined });
    expect(writeOutput).toHaveBeenCalledWith("test_anthropic_claude-sonnet-4-6.json", {
      translated_text: "Hola",
      sourceFileId: "src456",
      extractionFileId: "file123",
      contentType: "public_flyer",
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadConfig.mockResolvedValue({
      models: [
        { role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true },
        { role: "translate", provider: "google", model: "gemini-3.1-pro-preview", active: true },
        { role: "translate", provider: "google", model: "gemini-3.5-flash", active: false },
      ],
    });
    callLlm.mockResolvedValue({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 } });
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadConfig.mockResolvedValue({
      models: [
        { role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true },
        { role: "translate", provider: "google", model: "gemini-3.1-pro-preview", active: true },
      ],
    });
    callLlm
      .mockResolvedValueOnce({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 } })
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
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 } });
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

describe("translate structured logs", () => {
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  function structuredLogs(spy) {
    return spy.mock.calls
      .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter((e) => e && e.pipeline_stage === "translate");
  }

  beforeEach(() => {
    loadExtractionJson.mockResolvedValue({ blocks: [{ id: "b01", text: "Hello", translate: true }] });
    loadDoc.mockResolvedValue("Translate.");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 1, output_tokens: 1, duration_ms: 1 } });
    writeOutput.mockResolvedValue("output-file-id");
  });

  test("includes the submitter's email when provided", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation();
    await translate(
      { body: { extractionFileId: "f", sourceFileName: "a.pdf", sourceFileId: "s", submittedByEmail: "person@example.gov" } },
      mockRes()
    );
    const [entry] = structuredLogs(spy);
    spy.mockRestore();

    expect(entry.submittedByEmail).toBe("person@example.gov");
  });

  test("omits the field when there's no submitter", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation();
    await translate({ body: { extractionFileId: "f", sourceFileName: "a.pdf", sourceFileId: "s" } }, mockRes());
    const [entry] = structuredLogs(spy);
    spy.mockRestore();

    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("submittedByEmail");
  });
});

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

// --- formatStatutes ---

describe("formatStatutes", () => {
  test("returns empty string for null", () => {
    expect(formatStatutes(null)).toBe("");
  });

  test("returns empty string for empty array", () => {
    expect(formatStatutes([])).toBe("");
  });

  test("wraps each statute in section-tagged XML", () => {
    const statutes = [
      { section: "Subtitle 1 — Definitions; General Provisions", body: "§ 8.3-101. Definitions.", filename: "subtitle-01-definitions.md" },
      { section: "Subtitle 7 — Benefits", body: "§ 8.3-701. Eligibility for benefits.", filename: "subtitle-07-benefits.md" },
    ];
    const result = formatStatutes(statutes);
    expect(result).toContain('<statute section="Subtitle 1 — Definitions; General Provisions">');
    expect(result).toContain("§ 8.3-101. Definitions.");
    expect(result).toContain('<statute section="Subtitle 7 — Benefits">');
    expect(result).toContain("</statute>");
  });
});

// --- buildTranslationPrompt ---

describe("buildTranslationPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("assembles prompt with extraction JSON and no glossary", async () => {
    const extractionJson = {
      page_metadata: [{ page_number: 1, dimensions_description: "8.5x11in portrait", layout_type: "single-column", layout_description: "Single column layout" }],
      blocks: [{ id: "b01", text: "Hello", translate: true }],
      non_translatable_elements: [],
      translation_warnings: [],
    };
    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue(
      "Translate this."
    );
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);

    const { prompt, promptMetrics } = await buildTranslationPrompt("file123");

    expect(loadExtractionJson).toHaveBeenCalledWith("file123");
    expect(prompt).toContain("Translate this.");
    expect(prompt).toContain("<extraction_context>");
    expect(prompt).toContain("<extraction>");
    expect(prompt).toContain('"id": "b01"');
    expect(prompt).not.toContain("<glossary>");
    expect(promptMetrics.prompt_template_tokens).toBeGreaterThan(0);
    expect(promptMetrics.extraction_tokens).toBeGreaterThan(0);
    expect(promptMetrics.glossary_tokens).toBe(0);
  });

  test("includes glossary when sheet has data", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(glossaryTable([
      {
        [GLOSSARY_COLUMNS.ENGLISH_TERM]: "actual leave",
        [GLOSSARY_COLUMNS.APPROVED_SPANISH]: "duración real de la ausencia",
      },
    ]));

    const { prompt, promptMetrics } = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<glossary>");
    expect(prompt).toContain("actual leave");
    expect(prompt).toContain("duración real de la ausencia");
    expect(promptMetrics.glossary_tokens).toBeGreaterThan(0);
  });

  test("continues without glossary when sheet loading fails", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockRejectedValue(new Error("GLOSSARY_SHEET_ID not set in .env"));

    const logSpy = jest.spyOn(console, "log").mockImplementation();

    const { prompt } = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<extraction>");
    expect(prompt).not.toContain("<glossary>");
    const [problem] = inputProblems(logSpy);
    expect(problem.severity).toBe("ERROR");
    expect(problem.message).toContain("could not load");
    // No pipeline_stage, or the pipeline_stage_status metric counts it as a run
    expect(problem).not.toHaveProperty("pipeline_stage");

    logSpy.mockRestore();
  });

  test("prompt sections appear in correct order", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(glossaryTable([
      { [GLOSSARY_COLUMNS.ENGLISH_TERM]: "term" },
    ]));
    loadStatutes.mockResolvedValue([
      { section: "Subtitle 7 — Benefits", body: "§ 8.3-701. Eligibility for benefits.", filename: "subtitle-07-benefits.md" },
    ]);

    const { prompt } = await buildTranslationPrompt("file123");

    const contextIdx = prompt.indexOf("<extraction_context>");
    const extractionIdx = prompt.indexOf("<extraction>");
    const glossaryIdx = prompt.indexOf("<glossary>");
    const statutesIdx = prompt.indexOf("<statutes>");

    expect(contextIdx).toBeLessThan(extractionIdx);
    expect(extractionIdx).toBeLessThan(glossaryIdx);
    expect(glossaryIdx).toBeLessThan(statutesIdx);
  });

  test("includes statutes when loadStatutes returns data", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadStatutes.mockResolvedValue([
      { section: "Subtitle 7 — Benefits", body: "§ 8.3-701. Eligibility for benefits.", filename: "subtitle-07-benefits.md" },
    ]);

    const { prompt, promptMetrics } = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<statutes>");
    expect(prompt).toContain('<statute section="Subtitle 7 — Benefits">');
    expect(prompt).toContain("§ 8.3-701. Eligibility for benefits.");
    expect(promptMetrics.statutes_tokens).toBeGreaterThan(0);
  });

  test("omits statutes when includeStatutes is false", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadStatutes.mockResolvedValue([
      { section: "Subtitle 7 — Benefits", body: "§ 8.3-701. Eligibility for benefits.", filename: "subtitle-07-benefits.md" },
    ]);

    const { prompt } = await buildTranslationPrompt("file123", undefined, { includeStatutes: false });

    expect(prompt).not.toContain("<statutes>");
    expect(loadStatutes).not.toHaveBeenCalled();
  });

  test("continues without statutes when loading fails", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadStatutes.mockRejectedValue(new Error("GCS bucket not found"));

    const logSpy = jest.spyOn(console, "log").mockImplementation();

    const { prompt } = await buildTranslationPrompt("file123");

    expect(prompt).toContain("<extraction>");
    expect(prompt).not.toContain("<statutes>");
    const problem = inputProblems(logSpy).find((p) => p.input_problem === "statutes");
    expect(problem.message).toContain("could not load statute files: GCS bucket not found");

    logSpy.mockRestore();
  });

  test("logs an input problem when no statute files are found", async () => {
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadStatutes.mockResolvedValue([]);

    const logSpy = jest.spyOn(console, "log").mockImplementation();

    const { prompt } = await buildTranslationPrompt("file123");

    expect(prompt).not.toContain("<statutes>");
    const problem = inputProblems(logSpy).find((p) => p.input_problem === "statutes");
    expect(problem.severity).toBe("ERROR");
    expect(problem.message).toContain("no statute files found");
    expect(problem).toHaveProperty("statutes_bucket");

    logSpy.mockRestore();
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

// --- parseStatuteFile ---

const { parseStatuteFile, formatTimestamp } = jest.requireActual("../translate/loaders.js");

describe("parseStatuteFile", () => {
  test("extracts section title from markdown heading", () => {
    const content = "# Subtitle 7 — Benefits\n\n§ 8.3-701. Eligibility for benefits.";
    const result = parseStatuteFile("subtitle-07-benefits.md", content);
    expect(result.section).toBe("Subtitle 7 — Benefits");
    expect(result.body).toBe("§ 8.3-701. Eligibility for benefits.");
    expect(result.filename).toBe("subtitle-07-benefits.md");
  });

  test("uses first line as section when no markdown heading", () => {
    const content = "Subtitle 7 — Benefits\n\n§ 8.3-701. Eligibility for benefits.";
    const result = parseStatuteFile("subtitle-07-benefits.md", content);
    expect(result.section).toBe("Subtitle 7 — Benefits");
    expect(result.body).toBe("§ 8.3-701. Eligibility for benefits.");
  });

  test("handles empty content", () => {
    const result = parseStatuteFile("subtitle-07-benefits.md", "");
    expect(result.section).toBe("subtitle-07-benefits");
    expect(result.body).toBe("");
  });
});

// --- formatTimestamp ---

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

// --- logTranslationResult (actual loader, googleapis mocked) ---

const mockSheetsAppend = jest.fn();
const mockSheetsGet = jest.fn();
jest.mock("../translate/node_modules/googleapis", () => ({
  google: {
    auth: { GoogleAuth: jest.fn() },
    sheets: () => ({ spreadsheets: { values: { append: mockSheetsAppend, get: mockSheetsGet } } }),
  },
}));

const {
  logTranslationResult: actualLogTranslationResult,
  loadConfig: actualLoadConfig,
} = jest.requireActual("../translate/loaders.js");

describe("logTranslationResult", () => {
  // Processing log columns (A–K): fileId, fileName, processedAt, status,
  // durationMs, errorDetails, outputJsonId, provider, model, submittedBy, outputDocUrl
  const COL_DURATION = 4;
  const COL_ERROR = 5;
  const COL_OUTPUT_FILE_ID = 6;
  const COL_SUBMITTED_BY = 9;
  const COL_OUTPUT_DOC_URL = 10;
  let savedSheetId;

  beforeEach(() => {
    savedSheetId = process.env.PROCESSING_LOG_SHEET_ID;
    process.env.PROCESSING_LOG_SHEET_ID = "log-sheet";
    mockSheetsAppend.mockReset().mockResolvedValue({});
    jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(() => {
    if (savedSheetId === undefined) delete process.env.PROCESSING_LOG_SHEET_ID;
    else process.env.PROCESSING_LOG_SHEET_ID = savedSheetId;
    console.log.mockRestore();
  });

  function loggedRow() {
    return mockSheetsAppend.mock.calls[0][0].requestBody.values[0];
  }

  test("writes the error to Error Detail, not Duration", async () => {
    await actualLogTranslationResult("src-1", "a.pdf", {
      status: "failed", error: "LLM returned invalid JSON", provider: "google", model: "gemini",
    });

    const row = loggedRow();
    expect(row[COL_DURATION]).toBe("");
    expect(row[COL_ERROR]).toBe("LLM returned invalid JSON");
  });

  test("writes LLM duration and output file on success", async () => {
    await actualLogTranslationResult("src-1", "a.pdf", {
      status: "translated", outputFileId: "out-1", provider: "google", model: "gemini",
      usage: { duration_ms: 1234 }, submittedByEmail: "person@example.gov",
    });

    const row = loggedRow();
    expect(row).toHaveLength(11);
    expect(row[COL_OUTPUT_DOC_URL]).toBe("");
    expect(row[COL_DURATION]).toBe(1234);
    expect(row[COL_ERROR]).toBe("");
    expect(row[COL_OUTPUT_FILE_ID]).toBe("out-1");
    expect(row[COL_SUBMITTED_BY]).toBe("person@example.gov");
  });

  test("writes a doc-created row with the doc URL in outputDocUrl and the doc build time", async () => {
    await actualLogTranslationResult("src-1", "a.pdf", {
      status: "doc-created", outputFileId: "json-1", outputDocUrl: "https://docs.google.com/document/d/doc-1",
      provider: "google", model: "gemini", durationMs: 4200,
    });

    const row = loggedRow();
    expect(row[3]).toBe("doc-created");
    expect(row[COL_DURATION]).toBe(4200);
    expect(row[COL_OUTPUT_FILE_ID]).toBe("json-1");
    expect(row[COL_OUTPUT_DOC_URL]).toBe("https://docs.google.com/document/d/doc-1");
    expect(mockSheetsAppend.mock.calls[0][0].range).toBe("ProcessingLog!A:K");
  });
});

// --- Glossary checks (header row, counts, input problems) ---

describe("buildGlossary", () => {
  const T = GLOSSARY_COLUMNS;

  test("counts included entries, forbidden terms, and skipped rows", () => {
    const glossary = buildGlossary(glossaryTable([
      { [T.ENGLISH_TERM]: "leave", [T.APPROVED_SPANISH]: "licencia", [T.FORBIDDEN_TERMS]: "permiso" },
      { [T.ENGLISH_TERM]: "claim", [T.APPROVED_SPANISH]: "solicitud" },
      { [T.ENGLISH_TERM]: "", [T.NOTES]: "orphan note" },
      { [T.ENGLISH_TERM]: "", [T.NOTES]: "" },
    ]));

    expect(glossary.included).toBe(2);
    expect(glossary.withForbidden).toBe(1);
    expect(glossary.skippedRows).toBe(1); // the fully blank row isn't counted
    expect(glossary.missingColumns).toEqual([]);
    expect(glossary.text).toContain("Forbidden: permiso");
  });

  test("reports missing columns when row 1 isn't the header row", () => {
    // e.g. a "Last updated" row above the headers: row 1 becomes the header row
    const glossary = buildGlossary({
      headers: ["Last updated: Oct 1"],
      rows: [{ "last updated: oct 1": "English Term" }],
    });

    expect(glossary.included).toBe(0);
    expect(glossary.missingColumns).toContain(T.ENGLISH_TERM);
  });

  test("reports a renamed column, ignoring case", () => {
    const headers = GLOSSARY_HEADERS
      .map((h) => (h === T.FORBIDDEN_TERMS ? "Forbidden Terms (Do Not Use)" : h.toUpperCase()));
    const glossary = buildGlossary({ headers, rows: [] });

    expect(glossary.missingColumns).toEqual([T.FORBIDDEN_TERMS]);
  });

  test("doesn't require the Status column (it isn't read)", () => {
    const headers = GLOSSARY_HEADERS.filter((h) => h !== T.STATUS);
    expect(buildGlossary({ headers, rows: [] }).missingColumns).toEqual([]);
  });
});

describe("buildTranslationPrompt glossary logging", () => {
  const T = GLOSSARY_COLUMNS;
  let logSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    loadExtractionJson.mockResolvedValue({ blocks: [] });
    loadDoc.mockResolvedValue("Base prompt");
    loadStatutes.mockResolvedValue([{ section: "S", body: "Statute text", filename: "s.md" }]);
    logSpy = jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("valid glossary: logs included counts, no input problems", async () => {
    loadSheetTable.mockResolvedValue(glossaryTable([
      { [T.ENGLISH_TERM]: "leave", [T.FORBIDDEN_TERMS]: "permiso" },
      { [T.ENGLISH_TERM]: "claim" },
    ]));

    const { promptMetrics } = await buildTranslationPrompt("file123");

    expect(inputProblems(logSpy)).toEqual([]);
    expect(promptMetrics.glossary_entries).toBe(2);
    expect(promptMetrics.glossary_entries_with_forbidden).toBe(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Glossary: 2 entries included in the prompt");
  });

  test("header row not in row 1: logs missing columns and zero entries", async () => {
    loadSheetTable.mockResolvedValue({
      headers: ["Last updated: Oct 1"],
      rows: [{ "last updated: oct 1": "English Term" }, { "last updated: oct 1": "leave" }],
    });

    const { prompt, promptMetrics } = await buildTranslationPrompt("file123");

    const problems = inputProblems(logSpy);
    expect(problems.map((p) => p.input_problem)).toEqual(["glossary", "glossary"]);
    expect(problems[0].missing_columns).toContain(T.ENGLISH_TERM);
    expect(problems[0].found_headers).toEqual(["Last updated: Oct 1"]);
    expect(problems[0].message).toContain("Row 1 must be the header row");
    expect(problems[1].message).toContain("no glossary entries were included");
    expect(prompt).not.toContain("<glossary>");
    expect(promptMetrics.glossary_entries).toBe(0);
  });

  test("renamed Forbidden Terms column: logs it, still includes entries", async () => {
    const headers = GLOSSARY_HEADERS
      .map((h) => (h === T.FORBIDDEN_TERMS ? "Forbidden Terms (Do Not Use)" : h));
    loadSheetTable.mockResolvedValue({
      headers,
      rows: [{ [T.ENGLISH_TERM]: "leave", "forbidden terms (do not use)": "permiso" }],
    });

    const { prompt, promptMetrics } = await buildTranslationPrompt("file123");

    const [problem] = inputProblems(logSpy);
    expect(problem.missing_columns).toEqual([T.FORBIDDEN_TERMS]);
    expect(prompt).toContain("<glossary>");
    expect(prompt).not.toContain("permiso");
    expect(promptMetrics.glossary_entries).toBe(1);
    expect(promptMetrics.glossary_entries_with_forbidden).toBe(0);
  });

  test("empty glossary: logs that no entries were included", async () => {
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);

    await buildTranslationPrompt("file123");

    const [problem] = inputProblems(logSpy);
    expect(problem.message).toContain("no glossary entries were included in the prompt (0 rows read");
  });
});

// --- loadConfig (actual loader, googleapis mocked) ---

describe("loadConfig", () => {
  const CONFIG_HEADERS = ["Role", "Provider", "Model", "Active", "Effort"];
  let saved;
  let logSpy;

  beforeEach(() => {
    saved = { sheetId: process.env.MODEL_CONFIG_SHEET_ID, kService: process.env.K_SERVICE };
    mockSheetsGet.mockReset();
    logSpy = jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(() => {
    for (const [key, value] of [["MODEL_CONFIG_SHEET_ID", saved.sheetId], ["K_SERVICE", saved.kService]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    logSpy.mockRestore();
  });

  test("uses the local fixture when the sheet ID is unset outside Cloud Run", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "";
    delete process.env.K_SERVICE;

    const config = await actualLoadConfig();

    expect(config.models.length).toBeGreaterThan(0);
    expect(inputProblems(logSpy)).toEqual([]);
  });

  test("errors instead of using the fixture when the sheet ID is unset on Cloud Run", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "";
    process.env.K_SERVICE = "translate";

    await expect(actualLoadConfig()).rejects.toThrow("MODEL_CONFIG_SHEET_ID is not set");
    const [problem] = inputProblems(logSpy);
    expect(problem.input_problem).toBe("model_config");
  });

  test("parses a valid sheet", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "config-sheet";
    mockSheetsGet.mockResolvedValue({ data: { values: [
      CONFIG_HEADERS,
      ["translate", "Anthropic", "claude-opus-5", "yes", "high"],
    ] } });

    const { models } = await actualLoadConfig();

    expect(models).toEqual([
      { role: "translate", provider: "anthropic", model: "claude-opus-5", active: true, effort: "high" },
    ]);
    expect(inputProblems(logSpy)).toEqual([]);
  });

  test("errors and names missing columns when row 1 isn't the header row", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "config-sheet";
    mockSheetsGet.mockResolvedValue({ data: { values: [
      ["Last updated: Oct 1"],
      CONFIG_HEADERS,
      ["translate", "anthropic", "claude-opus-5", "YES"],
    ] } });

    await expect(actualLoadConfig()).rejects.toThrow("missing expected columns: role, provider, model, active");
    const [problem] = inputProblems(logSpy);
    expect(problem.found_headers).toEqual(["Last updated: Oct 1"]);
  });

  test("errors on a renamed column", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "config-sheet";
    mockSheetsGet.mockResolvedValue({ data: { values: [
      ["Role", "Provider", "Model", "Active?"],
      ["translate", "anthropic", "claude-opus-5", "YES"],
    ] } });

    await expect(actualLoadConfig()).rejects.toThrow("missing expected columns: active");
  });

  test("errors when there are no data rows", async () => {
    process.env.MODEL_CONFIG_SHEET_ID = "config-sheet";
    mockSheetsGet.mockResolvedValue({ data: { values: [CONFIG_HEADERS] } });

    await expect(actualLoadConfig()).rejects.toThrow("no data rows");
  });
});

// --- Doc step rows (translate handler) ---

describe("translate doc step logging", () => {
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    loadExtractionJson.mockResolvedValue({ blocks: [{ id: "b01", text: "Hello", translate: true }] });
    loadDoc.mockResolvedValue("Translate.");
    loadSheetTable.mockResolvedValue(EMPTY_GLOSSARY);
    loadStatutes.mockResolvedValue([]);
    loadConfig.mockResolvedValue({
      models: [{ role: "translate", provider: "anthropic", model: "claude-sonnet-4-6", active: true }],
    });
    callLlm.mockResolvedValue({ text: '{"translated_text": "Hola"}', usage: { input_tokens: 1, output_tokens: 1, duration_ms: 1 } });
    writeOutput.mockResolvedValue("translation-json-id");
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  test("writes translated, then doc-created with the doc URL", async () => {
    createTranslationDoc.mockResolvedValue("output-doc-id");

    await translate({ body: { extractionFileId: "f", sourceFileName: "a.pdf", sourceFileId: "src" } }, mockRes());

    const rows = logTranslationResult.mock.calls.map((c) => c[2]);
    expect(rows.map((r) => r.status)).toEqual(["translated", "doc-created"]);
    expect(rows[1]).toMatchObject({
      outputFileId: "translation-json-id",
      outputDocUrl: "https://docs.google.com/document/d/output-doc-id",
    });
    expect(rows[1].durationMs).toEqual(expect.any(Number));
  });

  test("writes doc-failed with the error when the doc build fails", async () => {
    createTranslationDoc.mockRejectedValue(new Error("Docs API rate limit"));

    await translate({ body: { extractionFileId: "f", sourceFileName: "a.pdf", sourceFileId: "src" } }, mockRes());

    const rows = logTranslationResult.mock.calls.map((c) => c[2]);
    expect(rows.map((r) => r.status)).toEqual(["translated", "doc-failed"]);
    expect(rows[1]).toMatchObject({ outputFileId: "translation-json-id", error: "Docs API rate limit" });
    expect(rows[1].outputDocUrl).toBe("");
  });

  test("logs the doc step under its own pipeline stage", async () => {
    createTranslationDoc.mockResolvedValue("output-doc-id");

    await translate({ body: { extractionFileId: "f", sourceFileName: "a.pdf", sourceFileId: "src" } }, mockRes());

    const entries = console.log.mock.calls
      .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter(Boolean);
    const doc = entries.find((e) => e.pipeline_stage === "translate_doc");
    expect(doc).toMatchObject({ status: "doc-created", docId: "output-doc-id", translationFileId: "translation-json-id" });
  });
});
