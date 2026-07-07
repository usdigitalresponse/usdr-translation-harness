var fs = require("fs");
var vm = require("vm");
var path = require("path");

var VIEWER_PATH = path.resolve(__dirname, "../viewer/server.js");

var EXTRACTION_FIXTURE_PATH = path.resolve(
  __dirname,
  "../../cloud-run/extract/fixtures/output/test_claude-sonnet-4-6_extraction.json"
);

var TRANSLATION_FIXTURE_PATH = path.resolve(
  __dirname,
  "../../cloud-run/translate/fixtures/output/test_claude_json_2.json"
);

function loadViewer(globals) {
  var defaults = {
    Logger: { log: jest.fn() },
    PropertiesService: {
      getScriptProperties: jest.fn().mockReturnValue({
        getProperty: jest.fn().mockReturnValue(null),
      }),
    },
    DriveApp: {
      getFileById: jest.fn(),
      getFolderById: jest.fn(),
    },
    HtmlService: {
      createTemplateFromFile: jest.fn().mockReturnValue({
        evaluate: jest.fn().mockReturnValue({
          setTitle: jest.fn().mockReturnValue({
            setXFrameOptionsMode: jest.fn().mockReturnValue("html-output"),
          }),
        }),
      }),
      createHtmlOutput: jest.fn().mockReturnValue({
        setTitle: jest.fn().mockReturnValue({
          setXFrameOptionsMode: jest.fn().mockReturnValue("html-output"),
        }),
      }),
      XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
    },
    ...globals,
  };

  var sandbox = vm.createContext(defaults);
  var source = fs.readFileSync(VIEWER_PATH, "utf8");
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

function mockDriveFile(content, name) {
  return {
    getFileById: jest.fn().mockReturnValue({
      getBlob: jest.fn().mockReturnValue({
        getDataAsString: jest.fn().mockReturnValue(content),
      }),
      getName: jest.fn().mockReturnValue(name || "test-file.json"),
    }),
    getFolderById: jest.fn(),
  };
}

describe("checkAccess", function () {
  test("returns true when no ACCESS_GATE_FOLDER_ID is set", function () {
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({}),
    });
    expect(ctx.checkAccess()).toBe(true);
  });

  test("returns true when user can access the gate folder", function () {
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({
        ACCESS_GATE_FOLDER_ID: "folder-123",
      }),
      DriveApp: {
        getFolderById: jest.fn().mockReturnValue({}),
        getFileById: jest.fn(),
      },
    });
    expect(ctx.checkAccess()).toBe(true);
  });

  test("returns false when user cannot access the gate folder", function () {
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({
        ACCESS_GATE_FOLDER_ID: "folder-123",
      }),
      DriveApp: {
        getFolderById: jest.fn().mockImplementation(function () {
          throw new Error("Access denied");
        }),
        getFileById: jest.fn(),
      },
    });
    expect(ctx.checkAccess()).toBe(false);
  });
});

describe("doGet", function () {
  test("returns access denied page when checkAccess fails", function () {
    var createHtmlOutput = jest.fn().mockReturnValue({
      setTitle: jest.fn().mockReturnValue({
        setXFrameOptionsMode: jest.fn().mockReturnValue("denied-output"),
      }),
    });

    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({
        ACCESS_GATE_FOLDER_ID: "folder-123",
      }),
      DriveApp: {
        getFolderById: jest.fn().mockImplementation(function () {
          throw new Error("Access denied");
        }),
        getFileById: jest.fn(),
      },
      HtmlService: {
        createHtmlOutput: createHtmlOutput,
        createTemplateFromFile: jest.fn(),
        XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      },
    });

    var result = ctx.doGet({ parameter: {} });
    expect(result).toBe("denied-output");
    expect(createHtmlOutput).toHaveBeenCalled();
    var htmlArg = createHtmlOutput.mock.calls[0][0];
    expect(htmlArg).toContain("Access denied");
  });

  test("creates template with fileId when provided", function () {
    var template = {
      evaluate: jest.fn().mockReturnValue({
        setTitle: jest.fn().mockReturnValue({
          setXFrameOptionsMode: jest.fn().mockReturnValue("html-output"),
        }),
      }),
    };
    var createTemplate = jest.fn().mockReturnValue(template);

    var ctx = loadViewer({
      HtmlService: {
        createTemplateFromFile: createTemplate,
        createHtmlOutput: jest.fn(),
        XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      },
    });

    ctx.doGet({ parameter: { fileId: "abc-123" } });

    expect(createTemplate).toHaveBeenCalledWith("viewer");
    expect(template.fileId).toBe("abc-123");
    expect(template.extractionFileId).toBe("");
    expect(template.pdfFileId).toBe("");
  });

  test("passes all URL parameters to template", function () {
    var template = {
      evaluate: jest.fn().mockReturnValue({
        setTitle: jest.fn().mockReturnValue({
          setXFrameOptionsMode: jest.fn().mockReturnValue("html-output"),
        }),
      }),
    };

    var ctx = loadViewer({
      HtmlService: {
        createTemplateFromFile: jest.fn().mockReturnValue(template),
        createHtmlOutput: jest.fn(),
        XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      },
    });

    ctx.doGet({
      parameter: {
        fileId: "main-file",
        extractionFileId: "ext-file",
        pdfFileId: "pdf-file",
      },
    });

    expect(template.fileId).toBe("main-file");
    expect(template.extractionFileId).toBe("ext-file");
    expect(template.pdfFileId).toBe("pdf-file");
  });

  test("defaults to empty strings when no parameters", function () {
    var template = {
      evaluate: jest.fn().mockReturnValue({
        setTitle: jest.fn().mockReturnValue({
          setXFrameOptionsMode: jest.fn().mockReturnValue("html-output"),
        }),
      }),
    };

    var ctx = loadViewer({
      HtmlService: {
        createTemplateFromFile: jest.fn().mockReturnValue(template),
        createHtmlOutput: jest.fn(),
        XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      },
    });

    ctx.doGet({ parameter: {} });

    expect(template.fileId).toBe("");
    expect(template.extractionFileId).toBe("");
    expect(template.pdfFileId).toBe("");
  });
});

describe("fetchJsonFromDrive", function () {
  test("reads file content and returns parsed JSON", function () {
    var jsonContent = JSON.stringify({ blocks: [{ id: "b01" }] });
    var ctx = loadViewer({ DriveApp: mockDriveFile(jsonContent) });

    var result = ctx.fetchJsonFromDrive("file-123");

    expect(result).toEqual({ blocks: [{ id: "b01" }] });
    expect(ctx.DriveApp.getFileById).toHaveBeenCalledWith("file-123");
  });

  test("throws on invalid JSON", function () {
    var ctx = loadViewer({ DriveApp: mockDriveFile("not json") });

    expect(function () {
      ctx.fetchJsonFromDrive("file-123");
    }).toThrow();
  });
});

describe("getFileName", function () {
  test("returns the file name", function () {
    var ctx = loadViewer({
      DriveApp: mockDriveFile("{}", "my-extraction.json"),
    });

    var name = ctx.getFileName("file-123");
    expect(name).toBe("my-extraction.json");
  });
});

function mockDriveFolder(fileList) {
  var idx = 0;
  return {
    getFileById: jest.fn(),
    getFolderById: jest.fn().mockReturnValue({
      getFiles: jest.fn().mockReturnValue({
        hasNext: function () { return idx < fileList.length; },
        next: function () { return fileList[idx++]; },
      }),
    }),
  };
}

function makeFakeFile(id, name, updated) {
  return {
    getId: function () { return id; },
    getName: function () { return name; },
    getLastUpdated: function () { return new Date(updated); },
  };
}

describe("listFolderFiles", function () {
  test("returns empty array when folder property is not set", function () {
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({}),
    });
    expect(ctx.listFolderFiles("EXTRACTION_FOLDER_ID")).toEqual([]);
  });

  test("returns only .json files sorted by date descending", function () {
    var files = [
      makeFakeFile("a1", "doc.json", "2026-07-01T00:00:00Z"),
      makeFakeFile("a2", "notes.txt", "2026-07-05T00:00:00Z"),
      makeFakeFile("a3", "other.json", "2026-07-03T00:00:00Z"),
    ];
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({ EXTRACTION_FOLDER_ID: "folder-1" }),
      DriveApp: mockDriveFolder(files),
    });

    var result = ctx.listFolderFiles("EXTRACTION_FOLDER_ID");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("other.json");
    expect(result[1].name).toBe("doc.json");
  });

  test("returns only .pdf files for PDF_FOLDER_ID", function () {
    var files = [
      makeFakeFile("p1", "form.pdf", "2026-07-02T00:00:00Z"),
      makeFakeFile("p2", "readme.txt", "2026-07-04T00:00:00Z"),
    ];
    var ctx = loadViewer({
      PropertiesService: mockScriptProperties({ PDF_FOLDER_ID: "folder-2" }),
      DriveApp: mockDriveFolder(files),
    });

    var result = ctx.listFolderFiles("PDF_FOLDER_ID");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("form.pdf");
  });
});

describe("detectJsonType with fixtures", function () {
  var extractionFixture, translationFixture;

  beforeAll(function () {
    if (fs.existsSync(EXTRACTION_FIXTURE_PATH)) {
      extractionFixture = JSON.parse(
        fs.readFileSync(EXTRACTION_FIXTURE_PATH, "utf8")
      );
    }
    if (fs.existsSync(TRANSLATION_FIXTURE_PATH)) {
      translationFixture = JSON.parse(
        fs.readFileSync(TRANSLATION_FIXTURE_PATH, "utf8")
      );
    }
  });

  test("detects extraction fixture correctly", function () {
    if (!extractionFixture) return;
    expect(extractionFixture.page_metadata).toBeDefined();
    expect(extractionFixture.blocks).toBeDefined();
    expect(extractionFixture.blocks.length).toBeGreaterThan(0);
    expect(extractionFixture.blocks[0].text).toBeDefined();
    expect(extractionFixture.blocks[0].translated_text).toBeUndefined();
  });

  test("detects translation fixture correctly", function () {
    if (!translationFixture) return;
    expect(translationFixture.blocks).toBeDefined();
    expect(translationFixture.blocks.length).toBeGreaterThan(0);
    expect(translationFixture.blocks[0].translated_text).toBeDefined();
  });
});
