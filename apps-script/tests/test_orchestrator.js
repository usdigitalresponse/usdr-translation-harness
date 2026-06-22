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
    MimeType: { PDF: "application/pdf" },
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

function mockFolder(files) {
  var index = 0;
  return {
    getFolderById: jest.fn().mockReturnValue({
      getName: jest.fn().mockReturnValue("Test Folder"),
      getFilesByType: jest.fn().mockReturnValue({
        hasNext: function () { return index < files.length; },
        next: function () { return files[index++]; },
      }),
    }),
  };
}

function makeFile(id, name) {
  return {
    getId: jest.fn().mockReturnValue(id),
    getName: jest.fn().mockReturnValue(name),
    getSize: jest.fn().mockReturnValue(1024),
  };
}

var VALID_PROPS = {
  INPUT_FOLDER_ID: "folder-123",
  EXTRACT_FUNCTION_URL: "https://extract.example.com",
  PROCESSING_LOG_SHEET_ID: "sheet-456",
};

var HEADER_ROW = [
  "fileId", "fileName", "processedAt", "status", "durationMs", "errorDetail",
];

describe("getConfig", () => {
  test("returns config when all properties are set", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
    });

    var config = ctx.getConfig();

    expect(config.INPUT_FOLDER_ID).toBe("folder-123");
    expect(config.EXTRACT_URL).toBe("https://extract.example.com");
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
      PropertiesService: mockScriptProperties({ INPUT_FOLDER_ID: "x" }),
    });

    expect(() => ctx.getConfig()).toThrow("EXTRACT_FUNCTION_URL");
    expect(() => ctx.getConfig()).toThrow("PROCESSING_LOG_SHEET_ID");
  });
});

describe("getProcessedFileIds", () => {
  test("returns set of file IDs with triggered status", () => {
    var sheetMock = mockSheet([
      HEADER_ROW,
      ["file-1", "a.pdf", new Date(), "triggered", 100, ""],
      ["file-2", "b.pdf", new Date(), "failed", 50, "HTTP 500"],
      ["file-3", "c.pdf", new Date(), "triggered", 200, ""],
    ]);

    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var ids = ctx.getProcessedFileIds("sheet-456");

    expect(ids.has("file-1")).toBe(true);
    expect(ids.has("file-3")).toBe(true);
    expect(ids.has("file-2")).toBe(false);
  });

  test("returns empty set when sheet has only headers", () => {
    var sheetMock = mockSheet([HEADER_ROW]);

    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var ids = ctx.getProcessedFileIds("sheet-456");

    expect(ids.size).toBe(0);
  });
});

describe("logProcessingResult", () => {
  test("logs triggered status for successful result", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var file = makeFile("file-1", "test.pdf");

    ctx.logProcessingResult("sheet-456", file, {
      success: true,
      durationMs: 150,
      error: "",
    });

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[0]).toBe("file-1");
    expect(row[1]).toBe("test.pdf");
    expect(row[3]).toBe("triggered");
    expect(row[4]).toBe(150);
    expect(row[5]).toBe("");
  });

  test("logs failed status with error detail", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var ctx = loadOrchestrator({ SpreadsheetApp: sheetMock });
    var file = makeFile("file-1", "test.pdf");

    ctx.logProcessingResult("sheet-456", file, {
      success: false,
      durationMs: 300,
      error: "HTTP 500: Internal Server Error",
    });

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[3]).toBe("failed");
    expect(row[4]).toBe(300);
    expect(row[5]).toBe("HTTP 500: Internal Server Error");
  });
});

describe("callExtractFunction", () => {
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

    var result = ctx.callExtractFunction(file, "https://extract.example.com");

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

    var result = ctx.callExtractFunction(file, "https://extract.example.com");

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

    ctx.callExtractFunction(file, "https://extract.example.com");

    var options = fetchMock.mock.calls[0][1];
    var payload = JSON.parse(options.payload);
    expect(payload.fileId).toBe("file-1");
    expect(payload.fileName).toBe("test.pdf");
  });

  test("sends identity token in authorization header", () => {
    var fetchMock = jest.fn().mockReturnValue({
      getResponseCode: jest.fn().mockReturnValue(202),
      getContentText: jest.fn().mockReturnValue(""),
    });
    var ctx = loadOrchestrator({ UrlFetchApp: { fetch: fetchMock } });
    var file = makeFile("file-1", "test.pdf");

    ctx.callExtractFunction(file, "https://extract.example.com");

    var options = fetchMock.mock.calls[0][1];
    expect(options.headers.Authorization).toBe("Bearer fake-token");
  });
});

describe("watchForNewPDFs", () => {
  test("skips already-triggered files", () => {
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

    ctx.watchForNewPDFs();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("processes new files and logs results", () => {
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

    ctx.watchForNewPDFs();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sheetMock._sheet.appendRow).toHaveBeenCalledTimes(1);

    var row = sheetMock._sheet.appendRow.mock.calls[0][0];
    expect(row[0]).toBe("file-new");
    expect(row[3]).toBe("triggered");
  });

  test("continues processing after one file fails", () => {
    var sheetMock = mockSheet([HEADER_ROW]);
    var fetchMock = jest.fn()
      .mockImplementationOnce(function () { throw new Error("network error"); })
      .mockReturnValueOnce({
        getResponseCode: jest.fn().mockReturnValue(202),
        getContentText: jest.fn().mockReturnValue(""),
      });

    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties(VALID_PROPS),
      DriveApp: mockFolder([
        makeFile("file-fail", "fail.pdf"),
        makeFile("file-ok", "ok.pdf"),
      ]),
      SpreadsheetApp: sheetMock,
      UrlFetchApp: { fetch: fetchMock },
    });

    ctx.watchForNewPDFs();

    expect(sheetMock._sheet.appendRow).toHaveBeenCalledTimes(2);
    var failRow = sheetMock._sheet.appendRow.mock.calls[0][0];
    var okRow = sheetMock._sheet.appendRow.mock.calls[1][0];
    expect(failRow[3]).toBe("failed");
    expect(failRow[5]).toBe("network error");
    expect(okRow[3]).toBe("triggered");
  });

  test("exits gracefully on missing config", () => {
    var ctx = loadOrchestrator({
      PropertiesService: mockScriptProperties({}),
    });

    expect(() => ctx.watchForNewPDFs()).not.toThrow();
    expect(ctx.Logger.log).toHaveBeenCalledWith(
      "Configuration error: %s",
      expect.stringContaining("Missing required script properties")
    );
  });
});
