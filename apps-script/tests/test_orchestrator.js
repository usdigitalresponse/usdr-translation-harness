const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ORCHESTRATOR_PATH = path.resolve(
  __dirname,
  "../orchestrator/orchestrator.js"
);

function loadOrchestrator(globals) {
  const defaults = {
    Logger: { log: jest.fn() },
    PropertiesService: { getScriptProperties: jest.fn() },
    DriveApp: { getFolderById: jest.fn() },
    SpreadsheetApp: { openById: jest.fn() },
    UrlFetchApp: { fetch: jest.fn() },
    ScriptApp: {
      getIdentityToken: jest.fn().mockReturnValue("fake-token"),
      newTrigger: jest.fn(),
    },
    MimeType: {
      PDF: "application/pdf",
      GOOGLE_DOCS: "application/vnd.google-apps.document",
      MICROSOFT_WORD: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    Date: Date,
    ...globals,
  };

  const sandbox = vm.createContext(defaults);
  const source = fs.readFileSync(ORCHESTRATOR_PATH, "utf8");
  vm.runInContext(source, sandbox);
  return sandbox;
}

function mockScriptProperties(props) {
  return {
    getScriptProperties: jest.fn().mockReturnValue({
      getProperty: jest.fn(function (key) {
        return props[key] || null;
      }),
    }),
  };
}

function mockSheet(rows) {
  var sheet = {
    getDataRange: jest.fn().mockReturnValue({
      getValues: jest.fn().mockReturnValue(rows),
    }),
    appendRow: jest.fn(),
  };
  return {
    openById: jest.fn().mockReturnValue({
      getSheetByName: jest.fn().mockReturnValue(sheet),
    }),
    _sheet: sheet,
  };
}

function mockFolder(filesByMimeType) {
  if (Array.isArray(filesByMimeType)) {
    filesByMimeType = { "application/pdf": filesByMimeType };
  }
  return {
    getFolderById: jest.fn().mockReturnValue({
      getName: jest.fn().mockReturnValue("Test Folder"),
      getFilesByType: jest.fn().mockImplementation(function (mimeType) {
        var files = filesByMimeType[mimeType] || [];
        var index = 0;
        return {
          hasNext: function () { return index < files.length; },
          next: function () { return files[index++]; },
        };
      }),
    }),
  };
}

function makeFile(id, name, mimeType) {
  return {
    getId: jest.fn().mockReturnValue(id),
    getName: jest.fn().mockReturnValue(name),
    getMimeType: jest.fn().mockReturnValue(mimeType || "application/pdf"),
    getSize: jest.fn().mockReturnValue(1024),
  };
}

var VALID_PROPS = {
  INPUT_FOLDER_ID: "folder-123",
  EXTRACT_FUNCTION_URL: "https://extract.example.com",
  PLAIN_LANGUAGE_EVAL_FUNCTION_URL: "https://pl-eval.example.com",
  PROCESSING_LOG_SHEET_ID: "sheet-456",
};

var HEADER_ROW = [
  "fileId", "fileName", "processedAt", "status", "durationMs", "errorDetail",
  "extractionFileId", "provider", "model",
];

describe("getConfig", () => {
  test("returns config when all properties are set", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
    });

    var config = ctx.getConfig();

    expect(config.EXTRACT_URL).toBe("https://extract.example.com");
    expect(config.PLAIN_LANGUAGE_EVAL_URL).toBe("https://pl-eval.example.com");
    expect(config.PROCESSING_LOG_SHEET_ID).toBe("sheet-456");
  });

  test("throws when properties are missing", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties({}),
    });

    expect(() => ctx.getConfig()).toThrow("Missing required script properties");
  });

  test("lists all missing property names", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties({ EXTRACT_FUNCTION_URL: "x" }),
    });

    expect(() => ctx.getConfig()).toThrow("PLAIN_LANGUAGE_EVAL_FUNCTION_URL");
    expect(() => ctx.getConfig()).toThrow("PROCESSING_LOG_SHEET_ID");
  });
});

describe("getProcessedFileIds", () => {
  test("returns per-service sets of processed file IDs", () => {
    var sheetMock = mockSheet([
      HEADER_ROW,
      ["file-1", "a.pdf", new Date(), "triggered", 100, ""],
      ["file-1", "a.pdf", new Date(), "pl-eval-triggered", 80, ""],
      ["file-2", "b.pdf", new Date(), "failed", 50, "HTTP 500"],
      ["file-3", "c.pdf", new Date(), "triggered", 200, ""],
    ]);

    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var ids = ctx.getProcessedFileIds("sheet-456");

    expect(ids.extract.has("file-1")).toBe(true);
    expect(ids.extract.has("file-3")).toBe(true);
    expect(ids.extract.has("file-2")).toBe(false);
    expect(ids.plEval.has("file-1")).toBe(true);
    expect(ids.plEval.has("file-3")).toBe(false);
  });

  test("includes extracted and complete statuses as processed for extract", () => {
    var sheetMock = mockSheet([
      HEADER_ROW,
      ["file-1", "a.pdf", new Date(), "complete", 100, ""],
      ["file-2", "a.pdf", new Date(), "extracted", "", "", "drive-id-1", "anthropic", "claude-sonnet-4-6"],
      ["file-3", "b.pdf", new Date(), "failed", 50, "HTTP 500"],
      ["file-2", "a.pdf", new Date(), "pl-eval-complete", 90, ""],
    ]);

    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var ids = ctx.getProcessedFileIds("sheet-456");

    expect(ids.extract.has("file-1")).toBe(true);
    expect(ids.extract.has("file-2")).toBe(true);
    expect(ids.extract.has("file-3")).toBe(false);
    expect(ids.plEval.has("file-2")).toBe(true);
    expect(ids.plEval.has("file-1")).toBe(false);
  });

  test("returns empty sets when sheet has only headers", () => {
    var sheetMock = mockSheet([HEADER_ROW]);

    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var ids = ctx.getProcessedFileIds("sheet-456");

    expect(ids.extract.size).toBe(0);
    expect(ids.plEval.size).toBe(0);
  });
});

describe("logProcessingResult", () => {
  test("logs triggered status for successful extract result", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var file = makeFile("file-1", "test.pdf");

    ctx.logProcessingResult("sheet-456", file, {
      success: true,
      durationMs: 150,
      error: "",
    }, "triggered", "failed");

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[0]).toBe("file-1");
    expect(row[1]).toBe("test.pdf");
    expect(row[3]).toBe("triggered");
    expect(row[4]).toBe(150);
    expect(row[5]).toBe("");
  });

  test("logs pl-eval-triggered status for successful eval result", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var file = makeFile("file-1", "test.pdf");

    ctx.logProcessingResult("sheet-456", file, {
      success: true,
      durationMs: 120,
      error: "",
    }, "pl-eval-triggered", "pl-eval-failed");

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[3]).toBe("pl-eval-triggered");
  });

  test("logs failed status with error detail", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var file = makeFile("file-1", "test.pdf");

    ctx.logProcessingResult("sheet-456", file, {
      success: false,
      durationMs: 300,
      error: "HTTP 500: Internal Server Error",
    }, "triggered", "failed");

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[3]).toBe("failed");
    expect(row[4]).toBe(300);
    expect(row[5]).toBe("HTTP 500: Internal Server Error");
  });
});

describe("callCloudRunFunction", () => {
  test("returns success when response is 202", () => {
    var ctx = loadOrchestrator({
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue({
          getResponseCode: jest.fn().mockReturnValue(202),
          getContentText: jest.fn().mockReturnValue('{"status":"accepted"}'),
        }),
      },
    });
    var file = makeFile("file-1", "test.pdf");

    var result = ctx.callCloudRunFunction(file, "https://extract.example.com", "Extract");

    expect(result.success).toBe(true);
    expect(result.error).toBe("");
  });

  test("returns failure with error detail when response is not 202", () => {
    var ctx = loadOrchestrator({
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue({
          getResponseCode: jest.fn().mockReturnValue(500),
          getContentText: jest.fn().mockReturnValue("Internal Server Error"),
        }),
      },
    });
    var file = makeFile("file-1", "test.pdf");

    var result = ctx.callCloudRunFunction(file, "https://extract.example.com", "Extract");

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 500");
    expect(result.error).toContain("Internal Server Error");
  });

  test("sends fileId and fileName in payload", () => {
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });
    var ctx = loadOrchestrator({ UrlFetchApp: { fetch: fetchMock } });
    var file = makeFile("file-1", "test.pdf");

    ctx.callCloudRunFunction(file, "https://extract.example.com", "Extract");

    var options = fetchMock.mock.calls[0][1];
    var payload = JSON.parse(options.payload);
    expect(payload.fileId).toBe("file-1");
    expect(payload.fileName).toBe("test.pdf");
    expect(payload.mimeType).toBe("application/pdf");
  });

  test("sends identity token in authorization header", () => {
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });
    var ctx = loadOrchestrator({ UrlFetchApp: { fetch: fetchMock } });
    var file = makeFile("file-1", "test.pdf");

    ctx.callCloudRunFunction(file, "https://extract.example.com", "Extract");

    var options = fetchMock.mock.calls[0][1];
    expect(options.headers.Authorization).toBe("Bearer fake-token");
  });
});

describe("watchForNewFiles", () => {
  test("skips files already triggered for both services", () => {
    var sheetMock = mockSheet([
      HEADER_ROW,
      ["file-1", "old.pdf", new Date(), "triggered", 100, ""],
      ["file-1", "old.pdf", new Date(), "pl-eval-triggered", 80, ""],
    ]);
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder([makeFile("file-1", "old.pdf")]),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewFiles();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("calls eval for file already triggered for extract only", () => {
    var sheetMock = mockSheet([
      HEADER_ROW,
      ["file-1", "old.pdf", new Date(), "triggered", 100, ""],
    ]);
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder([makeFile("file-1", "old.pdf")]),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewFiles();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://pl-eval.example.com");
    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[3]).toBe("pl-eval-triggered");
  });

  test("processes new files with both extract and eval calls", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder([makeFile("file-new", "new.pdf")]),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewFiles();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://extract.example.com");
    expect(fetchMock.mock.calls[1][0]).toBe("https://pl-eval.example.com");
    expect(sheetMock._sheet.appendRow).toHaveBeenCalledTimes(2);

    var extractRow = sheetMock._sheet.appendRow.mock.calls[0][0];
    var evalRow = sheetMock._sheet.appendRow.mock.calls[1][0];
    expect(extractRow[0]).toBe("file-new");
    expect(extractRow[3]).toBe("triggered");
    expect(evalRow[0]).toBe("file-new");
    expect(evalRow[3]).toBe("pl-eval-triggered");
  });

  test("continues eval call when extract fails for a file", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var fetchMock = jest.fn()
      .mockImplementationOnce(function () { throw new Error("network error"); })
      .mockReturnValue({
        getResponseCode: jest.fn().mockReturnValue(202),
        getContentText: jest.fn().mockReturnValue(""),
      });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder([makeFile("file-1", "test.pdf")]),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewFiles();

    expect(sheetMock._sheet.appendRow).toHaveBeenCalledTimes(2);
    var extractRow = sheetMock._sheet.appendRow.mock.calls[0][0];
    var evalRow = sheetMock._sheet.appendRow.mock.calls[1][0];
    expect(extractRow[3]).toBe("failed");
    expect(extractRow[5]).toBe("network error");
    expect(evalRow[3]).toBe("pl-eval-triggered");
  });

  test("processes Google Docs and DOCX files alongside PDFs for both services", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder({
        "application/pdf": [makeFile("f1", "doc.pdf", "application/pdf")],
        "application/vnd.google-apps.document": [makeFile("f2", "My Doc", "application/vnd.google-apps.document")],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [makeFile("f3", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
      }),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewFiles();

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test("exits gracefully on missing config", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties({}),
    });

    expect(() => ctx.watchForNewFiles()).not.toThrow();
    expect(ctx.Logger.log).toHaveBeenCalledWith(
      "Configuration error: %s",
      expect.stringContaining("Missing required script properties")
    );
  });
});
