const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ADDON_PATH = path.resolve(__dirname, "../editor-addon/addon.js");

const CRITERIA = [
  "accuracy_and_relevance",
  "clarity_and_simplicity",
  "cultural_sensitivity",
  "active_voice_and_tone",
  "consistency_and_style",
];

function makeScores(score = 4) {
  const scores = {};
  CRITERIA.forEach((key) => {
    scores[key] = {
      score,
      strengths: "clear",
      issues: "none",
      recommendations: "none",
      priority: "Medium",
    };
  });
  scores.weighted_overall_score = 4.2;
  scores.overall_priority_rating = "Medium";
  return scores;
}

/**
 * Build a mock Docs table. `rows[0]` is treated as the header row by the
 * add-on, matching the real two-column English/Spanish layout.
 */
function mockTable(rows) {
  return {
    getNumRows: () => rows.length,
    getRow: (r) => ({
      getCell: (c) => ({
        getText: () => rows[r][c],
        getNumChildren: () => 0,
      }),
    }),
  };
}

function loadAddon(globals = {}) {
  const table = globals._table !== undefined ? globals._table : mockTable([
    ["English", "Spanish"],
    ["Hello", "Hola"],
    ["Goodbye", "Adiós"],
  ]);

  const documentProps = globals._documentProps || {};

  const defaults = {
    Logger: { log: jest.fn() },
    PropertiesService: {
      getDocumentProperties: jest.fn().mockReturnValue({
        getProperty: jest.fn((k) => (k in documentProps ? documentProps[k] : null)),
        setProperty: jest.fn((k, v) => { documentProps[k] = v; }),
      }),
      getScriptProperties: jest.fn().mockReturnValue({
        getProperty: jest.fn((k) => (globals._scriptProps || {})[k] || null),
      }),
    },
    DocumentApp: {
      getActiveDocument: jest.fn().mockReturnValue({
        getId: () => "doc-123",
        getBody: () => ({
          getNumChildren: () => (table ? 1 : 0),
          getChild: () => ({ getType: () => "TABLE", asTable: () => table }),
          getText: () => "body text",
        }),
      }),
      ElementType: { TABLE: "TABLE", PARAGRAPH: "PARAGRAPH" },
      getUi: jest.fn().mockReturnValue({ alert: jest.fn(), ButtonSet: { OK: "OK" } }),
    },
    Drive: {
      Files: {
        get: jest.fn().mockReturnValue({
          properties: { usdr_translation_review: "translation-file-1" },
        }),
      },
    },
    UrlFetchApp: { fetch: jest.fn() },
    ScriptApp: { getIdentityToken: jest.fn().mockReturnValue("fake-token") },
    HtmlService: { createHtmlOutputFromFile: jest.fn() },
    JSON,
    Date,
    ...globals,
  };

  const sandbox = vm.createContext(defaults);
  vm.runInContext(fs.readFileSync(ADDON_PATH, "utf8"), sandbox);
  sandbox._documentProps = documentProps;
  return sandbox;
}

function mockResponse(code, body) {
  return {
    getResponseCode: () => code,
    getContentText: () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("extractDocBlocks_", () => {
  test("reads English/Spanish pairs and skips the header row", () => {
    const s = loadAddon();
    const blocks = s.extractDocBlocks_();

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ id: "b01", original_text: "Hello", translated_text: "Hola" });
    expect(blocks[1].translated_text).toBe("Adiós");
  });

  test("trims whitespace and drops fully empty rows", () => {
    const s = loadAddon({
      _table: mockTable([
        ["English", "Spanish"],
        ["  Hello  ", "  Hola  "],
        ["", "   "],
      ]),
    });
    const blocks = s.extractDocBlocks_();

    expect(blocks).toHaveLength(1);
    expect(blocks[0].original_text).toBe("Hello");
  });

  test("returns empty when there is no table", () => {
    expect(loadAddon({ _table: null }).extractDocBlocks_()).toEqual([]);
  });

  test("returns empty when the table has only a header", () => {
    const s = loadAddon({ _table: mockTable([["English", "Spanish"]]) });
    expect(s.extractDocBlocks_()).toEqual([]);
  });
});

describe("toSidebarEvalData_", () => {
  const blocks = [{ id: "b01", original_text: "Hello", translated_text: "Hola" }];

  test("maps schema criteria onto the sidebar DIMENSIONS keys", () => {
    const s = loadAddon();
    const data = s.toSidebarEvalData_({ scores: makeScores(4) }, blocks);

    expect(data.scores.accuracy).toBe(4);
    expect(data.scores.clarity).toBe(4);
    expect(data.scores.cultural).toBe(4);
    expect(data.scores.voice).toBe(4);
    expect(data.scores.consistency).toBe(4);
    expect(data.scores.weightedOverall).toBe(4.2);
    expect(data.scores.priorityRating).toBe("Medium");
  });

  test("raw_eval_text round-trips to the per-dimension detail the sidebar reads", () => {
    const s = loadAddon();
    const data = s.toSidebarEvalData_({ scores: makeScores() }, blocks);
    const parsed = JSON.parse(data.raw_eval_text);

    expect(parsed.accuracy_and_relevance.strengths).toBe("clear");
    expect(parsed.consistency_and_style.recommendations).toBe("none");
  });

  test("blank score becomes empty string, not zero", () => {
    const scores = makeScores();
    delete scores.accuracy_and_relevance.score;
    const data = loadAddon().toSidebarEvalData_({ scores }, blocks);

    expect(data.scores.accuracy).toBe("");
  });

  test("joins block text for the debug panel", () => {
    const s = loadAddon();
    const data = s.toSidebarEvalData_({ scores: makeScores() }, [
      { original_text: "A", translated_text: "X" },
      { original_text: "B", translated_text: "Y" },
    ]);

    expect(data.source_text).toBe("A\n\nB");
    expect(data.translated_text).toBe("X\n\nY");
  });
});

describe("evaluateTranslationFromSidebar", () => {
  const OK_BODY = {
    status: "ok",
    evaluations: [{ provider: "google", model: "gemini-3.5-flash", scores: makeScores() }],
  };

  test("posts doc blocks and caches the result", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: { fetch: jest.fn().mockReturnValue(mockResponse(200, OK_BODY)) },
    });

    const result = s.evaluateTranslationFromSidebar();
    expect(result.ok).toBe(true);

    const [url, options] = s.UrlFetchApp.fetch.mock.calls[0];
    expect(url).toBe("https://eval.example/");
    expect(options.headers.Authorization).toBe("Bearer fake-token");

    const payload = JSON.parse(options.payload);
    expect(payload.documentId).toBe("doc-123");
    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[0].translated_text).toBe("Hola");

    // cached result is what getEvalData reads back
    expect(s.getEvalData().scores.weightedOverall).toBe(4.2);
  });

  test("reports a config problem when the URL is unset", () => {
    const s = loadAddon({ _scriptProps: {} });
    const result = s.evaluateTranslationFromSidebar();

    expect(result.problem).toBe("config");
    expect(s.UrlFetchApp.fetch).not.toHaveBeenCalled();
  });

  test("reports no_translation when the doc has no table", () => {
    const s = loadAddon({
      _table: null,
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
    });
    const result = s.evaluateTranslationFromSidebar();

    expect(result.problem).toBe("no_translation");
    expect(s.UrlFetchApp.fetch).not.toHaveBeenCalled();
  });

  test("surfaces a non-200 from the eval function", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue(mockResponse(500, { error: "All eval models failed" })),
      },
    });
    const result = s.evaluateTranslationFromSidebar();

    expect(result.problem).toBe("eval_failed");
    expect(result.message).toBe("All eval models failed");
  });

  test("surfaces a per-model error even on a 200", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue(
          mockResponse(200, { evaluations: [{ provider: "google", error: "api down" }] })
        ),
      },
    });
    const result = s.evaluateTranslationFromSidebar();

    expect(result.problem).toBe("eval_failed");
    expect(result.message).toBe("api down");
  });

  test("handles a non-JSON response body", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: { fetch: jest.fn().mockReturnValue(mockResponse(200, "<html>502</html>")) },
    });
    expect(s.evaluateTranslationFromSidebar().problem).toBe("eval_failed");
  });

  test("handles a network exception", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn(() => { throw new Error("DNS failure"); }),
      },
    });
    const result = s.evaluateTranslationFromSidebar();

    expect(result.problem).toBe("eval_failed");
    expect(result.message).toContain("DNS failure");
  });

  test("drops debug text when the payload would exceed the property cap", () => {
    const huge = makeScores();
    huge.accuracy_and_relevance.issues = "x".repeat(9500);
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue(
          mockResponse(200, { evaluations: [{ provider: "google", scores: huge }] })
        ),
      },
    });

    s.evaluateTranslationFromSidebar();
    const cached = s.getEvalData();

    expect(cached.source_text).toBe("");
    expect(cached.scores.weightedOverall).toBe(4.2);
  });
});

describe("getEvalData", () => {
  test("returns null when nothing is cached", () => {
    expect(loadAddon().getEvalData()).toBeNull();
  });

  test("returns null on unparseable cached JSON", () => {
    const s = loadAddon({ _documentProps: { EVAL_RESULT: "{not json" } });
    expect(s.getEvalData()).toBeNull();
  });
});
