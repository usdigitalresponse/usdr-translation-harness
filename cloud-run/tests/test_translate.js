const { StatusCodes } = require("../translate/node_modules/http-status-codes");

const { translate, parseInput } = require("../translate/index.js");
const {
  formatGlossaryEntry,
  formatGlossary,
  buildTranslationPrompt,
  GLOSSARY_COLUMNS,
} = require("../translate/prompt-assembly.js");

// --- Mock loaders so tests don't hit Google APIs ---

jest.mock("../translate/loaders.js", () => ({
  loadDoc: jest.fn(),
  loadSheet: jest.fn(),
  loadExtractionJson: jest.fn(),
}));

const {
  loadDoc,
  loadSheet,
  loadExtractionJson,
} = require("../translate/loaders.js");

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
  function mockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  }

  test("returns 400 when body is empty", async () => {
    const res = mockRes();
    await translate({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Missing required fields") })
    );
  });

  test("returns 400 when extractionFileId is missing", async () => {
    const res = mockRes();
    await translate({ body: { sourceFileName: "test.pdf" } }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("extractionFileId") })
    );
  });

  test("returns 400 for invalid Pub/Sub envelope", async () => {
    const res = mockRes();
    const encoded = Buffer.from("not json").toString("base64");
    await translate({ body: { message: { data: encoded } } }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Invalid Pub/Sub message") })
    );
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

  test("assembles prompt and returns ok for valid direct call", async () => {
    const extractionJson = { blocks: [{ id: "b01", text: "Hello", translate: true }] };
    const basePrompt = "Translate the following. [Paste content to be translated in the area below]";

    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue(basePrompt);
    loadSheet.mockResolvedValue([]);

    const res = mockRes();
    await translate(
      { body: { extractionFileId: "file123", sourceFileName: "test.pdf", sourceFileId: "src456" } },
      res
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        extractionFileId: "file123",
        sourceFileName: "test.pdf",
        promptLength: expect.any(Number),
      })
    );
  });

  test("assembles prompt from Pub/Sub envelope", async () => {
    const extractionJson = { blocks: [] };
    loadExtractionJson.mockResolvedValue(extractionJson);
    loadDoc.mockResolvedValue("Base prompt [Paste content to be translated in the area below]");
    loadSheet.mockResolvedValue([]);

    const payload = {
      extractionFileId: "file123",
      sourceFileName: "test.pdf",
      sourceFileId: "src456",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = mockRes();
    await translate({ body: { message: { data: encoded } } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        extractionFileId: "file123",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
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
