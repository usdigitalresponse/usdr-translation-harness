const { StatusCodes } = require("../plain-language-eval/node_modules/http-status-codes");

const {
  plainLanguageEval,
  runEval,
  buildOutputFilename,
  SOURCE_FILE_ID_PROPERTY,
} = require("../plain-language-eval/index.js");

const {
  MIME_PDF,
  MIME_GOOGLE_DOCS,
  MIME_DOCX,
} = require("../plain-language-eval/loaders.js");

// --- Mock loaders so tests don't hit Google APIs ---

jest.mock("../plain-language-eval/loaders.js", () => {
  const path = require("path");
  return {
    loadDoc: jest.fn(),
    loadConfig: jest.fn(),
    fetchDocumentContent: jest.fn(),
    writeOutput: jest.fn(),
    logEvalResult: jest.fn().mockResolvedValue(),
    stripExtension: (fileName) => path.parse(fileName).name,
    MIME_PDF: "application/pdf",
    MIME_GOOGLE_DOCS: "application/vnd.google-apps.document",
    MIME_DOCX:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
});

const {
  loadDoc,
  loadConfig,
  fetchDocumentContent,
  writeOutput,
  logEvalResult,
} = require("../plain-language-eval/loaders.js");

// --- Mock llm so tests don't call real LLMs ---

jest.mock("../plain-language-eval/llm.js", () => ({
  callLlm: jest.fn(),
}));

const { callLlm } = require("../plain-language-eval/llm.js");

// --- buildOutputFilename ---

describe("buildOutputFilename", () => {
  test("replaces slashes in model name", () => {
    const result = buildOutputFilename("test", "anthropic/claude-sonnet-5");
    expect(result).toContain("anthropic_claude-sonnet-5");
    expect(result).toContain("_plain-language-eval.json");
  });

  test("includes timestamp between model and suffix", () => {
    const result = buildOutputFilename("doc", "claude-sonnet-5");
    expect(result).toMatch(
      /^doc_claude-sonnet-5_\d{14}\._plain-language-eval\.json$/
    );
  });
});

// --- plainLanguageEval (HTTP handler) ---

describe("plainLanguageEval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  }

  test("returns 400 when fileId is missing", async () => {
    const res = mockRes();
    await plainLanguageEval({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Provide fileId" })
    );
  });

  test("returns 202 and accepted payload when fileId is present", async () => {
    loadConfig.mockResolvedValue({ models: [] });
    fetchDocumentContent.mockResolvedValue({ text: "hello", pdfBase64: null });
    loadDoc.mockResolvedValue("Evaluate this document.");

    const res = mockRes();
    await plainLanguageEval(
      { body: { fileId: "abc123", fileName: "test.pdf" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(StatusCodes.ACCEPTED);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", fileId: "abc123" })
    );
  });

  test("defaults mimeType to PDF when not provided", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    const res = mockRes();
    await plainLanguageEval(
      { body: { fileId: "abc123", fileName: "test.pdf" } },
      res
    );

    // Wait for the async runEval to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchDocumentContent).toHaveBeenCalledWith("abc123", MIME_PDF);
  });
});

// --- runEval ---

describe("runEval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns early when no active models in config", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: false,
        },
      ],
    });

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(fetchDocumentContent).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("sends PDF as base64 with prompt only (no document tags)", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(callLlm).toHaveBeenCalledWith(
      "anthropic",
      "claude-sonnet-5",
      "Evaluate this document.",
      "base64data"
    );
  });

  test("wraps text documents in <document> tags with separator", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: "Some document text here.",
      pdfBase64: null,
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.docx", MIME_GOOGLE_DOCS);

    const prompt = callLlm.mock.calls[0][2];
    expect(prompt).toContain("Evaluate this document.");
    expect(prompt).toContain("---");
    expect(prompt).toContain("<document>");
    expect(prompt).toContain("Some document text here.");
    expect(prompt).toContain("</document>");
    expect(callLlm.mock.calls[0][3]).toBeNull();
  });

  test("writes output with source metadata appended", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85, "overall_summary": "Good"}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(writeOutput).toHaveBeenCalledWith(
      expect.stringContaining("_plain-language-eval.json"),
      expect.objectContaining({
        weighted_overall_score: 85,
        overall_summary: "Good",
        sourceFileId: "file123",
        sourceFileName: "test.pdf",
        provider: "anthropic",
        model: "claude-sonnet-5",
      }),
      { [SOURCE_FILE_ID_PROPERTY]: "file123" }
    );
  });

  test("logs eval result with duration_ms on success", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 2345 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(logEvalResult).toHaveBeenCalledWith("file123", "test.pdf", {
      status: "pl-eval-complete",
      outputFileId: "output-id",
      durationMs: 2345,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  test("logs failure when LLM returns invalid JSON", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: "not valid json",
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue(null);

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(logEvalResult).toHaveBeenCalledWith(
      "file123",
      "test.pdf",
      expect.objectContaining({
        status: "pl-eval-failed",
        error: expect.stringContaining("invalid JSON"),
      })
    );
    // Raw output is saved for debugging but not tagged, so the add-on's
    // property lookup never returns an unparseable file.
    expect(writeOutput).toHaveBeenCalledTimes(1);
    expect(writeOutput.mock.calls[0]).toHaveLength(2);
    errorSpy.mockRestore();
  });

  test("runs multiple active models in parallel", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
        {
          role: "plain-language-eval",
          provider: "google",
          model: "gemini-3.5-flash",
          active: true,
        },
        {
          role: "plain-language-eval",
          provider: "google",
          model: "gemini-3.1-pro",
          active: false,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(logEvalResult).toHaveBeenCalledTimes(2);
  });

  test("continues other models when one fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "plain-language-eval",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
        {
          role: "plain-language-eval",
          provider: "google",
          model: "gemini-3.5-flash",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm
      .mockRejectedValueOnce(new Error("Anthropic rate limit"))
      .mockResolvedValueOnce({
        text: '{"weighted_overall_score": 85}',
        usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
      });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(logEvalResult).toHaveBeenCalledTimes(2);
    expect(logEvalResult).toHaveBeenCalledWith(
      "file123",
      "test.pdf",
      expect.objectContaining({ status: "pl-eval-failed" })
    );
    expect(logEvalResult).toHaveBeenCalledWith(
      "file123",
      "test.pdf",
      expect.objectContaining({ status: "pl-eval-complete" })
    );
    errorSpy.mockRestore();
  });

  test("filters only plain-language-eval role models", async () => {
    loadConfig.mockResolvedValue({
      models: [
        {
          role: "translate",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
        {
          role: "extract",
          provider: "anthropic",
          model: "claude-sonnet-5",
          active: true,
        },
        {
          role: "plain-language-eval",
          provider: "google",
          model: "gemini-3.5-flash",
          active: true,
        },
      ],
    });
    fetchDocumentContent.mockResolvedValue({
      text: null,
      pdfBase64: "base64data",
    });
    loadDoc.mockResolvedValue("Evaluate this document.");
    callLlm.mockResolvedValue({
      text: '{"weighted_overall_score": 85}',
      usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1500 },
    });
    writeOutput.mockResolvedValue("output-id");

    await runEval("file123", "test.pdf", MIME_PDF);

    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(callLlm).toHaveBeenCalledWith(
      "google",
      "gemini-3.5-flash",
      expect.any(String),
      "base64data"
    );
  });
});

// --- loaders unit tests ---

// Only the actual loaders (via requireActual) use googleapis; index.js gets the
// mocked loaders above.
const mockDriveCreate = jest.fn();
jest.mock("../plain-language-eval/node_modules/googleapis", () => ({
  google: {
    auth: { GoogleAuth: jest.fn() },
    drive: () => ({ files: { create: mockDriveCreate } }),
  },
}));

const {
  formatTimestamp,
  parseSheetRows,
  stripExtension,
  writeOutput: actualWriteOutput,
} = jest.requireActual("../plain-language-eval/loaders.js");

describe("writeOutput", () => {
  const FOLDER_ID = "pl-eval-folder";
  let savedFolderId;

  beforeEach(() => {
    savedFolderId = process.env.DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID;
    process.env.DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID = FOLDER_ID;
    mockDriveCreate.mockReset().mockResolvedValue({ data: { id: "new-file" } });
  });

  afterEach(() => {
    if (savedFolderId === undefined) {
      delete process.env.DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID;
    } else {
      process.env.DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID = savedFolderId;
    }
  });

  test("tags the Drive file with the given properties", async () => {
    const id = await actualWriteOutput("out.json", { a: 1 }, {
      [SOURCE_FILE_ID_PROPERTY]: "src-1",
    });

    expect(id).toBe("new-file");
    expect(mockDriveCreate.mock.calls[0][0].requestBody).toEqual({
      name: "out.json",
      parents: [FOLDER_ID],
      properties: { [SOURCE_FILE_ID_PROPERTY]: "src-1" },
    });
  });

  test("omits properties when none are given", async () => {
    await actualWriteOutput("raw.json", "not json");

    expect(mockDriveCreate.mock.calls[0][0].requestBody).toEqual({
      name: "raw.json",
      parents: [FOLDER_ID],
    });
  });
});

describe("formatTimestamp", () => {
  test("produces MM/DD/YYYY HH:MM with no comma", () => {
    const result = formatTimestamp(new Date(2026, 6, 8, 14, 5));
    expect(result).toBe("07/08/2026 14:05");
  });
});

describe("parseSheetRows", () => {
  test("returns empty for fewer than 2 rows", () => {
    expect(parseSheetRows([["header"]])).toEqual([]);
  });

  test("maps headers to lowercase keys", () => {
    const rows = [
      ["Role", "Provider", "Model"],
      ["eval", "anthropic", "claude-sonnet-5"],
    ];
    const result = parseSheetRows(rows);
    expect(result[0]).toEqual({
      role: "eval",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });
});

describe("stripExtension", () => {
  test("removes .pdf", () => {
    expect(stripExtension("test.pdf")).toBe("test");
  });

  test("removes only last extension", () => {
    expect(stripExtension("my.file.docx")).toBe("my.file");
  });

  test("handles no extension", () => {
    expect(stripExtension("noext")).toBe("noext");
  });
});
