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

function makeScores(score = 4, weighted = 4.2, priority = "Medium") {
  const scores = {};
  CRITERIA.forEach((key) => {
    scores[key] = {
      score,
      strengths: "clear",
      issues: "none",
      recommendations: "none",
      priority,
    };
  });
  scores.weighted_overall_score = weighted;
  scores.overall_priority_rating = priority;
  return scores;
}

function evaluation(provider, model, scores) {
  return { provider, model, scores };
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
      getNumCells: () => rows[r].length,
    }),
  };
}

function loadAddon(globals = {}) {
  const table = globals._table !== undefined ? globals._table : mockTable([
    ["Block", "English", "Spanish"],
    ["b01", "Hello", "Hola"],
    ["b02", "Goodbye", "Adiós"],
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
        // Query by documentId property → newest result file id, from a
        // { documentId: fileId } map. Emulates the eval function's tagging.
        list: jest.fn((params) => {
          const byDoc = globals._driveResultsByDoc || {};
          const m = (params.q || "").match(/value='([^']+)'/);
          const docId = m ? m[1] : null;
          const fileId = docId ? byDoc[docId] : null;
          return { files: fileId ? [{ id: fileId }] : [] };
        }),
      },
    },
    // Map of fileId -> string content, read by DriveApp.getFileById.
    DriveApp: {
      getFileById: jest.fn((id) => {
        const files = globals._driveFiles || {};
        if (!(id in files)) throw new Error("File not found: " + id);
        return { getBlob: () => ({ getDataAsString: () => files[id] }) };
      }),
    },
    UrlFetchApp: { fetch: jest.fn() },
    ScriptApp: { getIdentityToken: jest.fn().mockReturnValue("fake-token") },
    HtmlService: { createHtmlOutputFromFile: jest.fn() },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5" },
      Charset: { UTF_8: "UTF_8" },
      // Deterministic, content-sensitive stand-in for computeDigest: same text
      // yields the same bytes, edited text yields different bytes.
      computeDigest: (_alg, str) => {
        const out = new Array(16).fill(0);
        for (let i = 0; i < str.length; i++) {
          out[i % 16] = (out[i % 16] + str.charCodeAt(i)) & 0xff;
        }
        return out;
      },
    },
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
        ["Block", "English", "Spanish"],
        ["b01", "  Hello  ", "  Hola  "],
        ["b02", "", "   "],
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
    const s = loadAddon({ _table: mockTable([["Block", "English", "Spanish"]]) });
    expect(s.extractDocBlocks_()).toEqual([]);
  });
});

describe("compileEvalData_ (single model)", () => {
  const blocks = [{ id: "b01", original_text: "Hello", translated_text: "Hola" }];

  test("maps schema criteria onto the sidebar DIMENSIONS keys", () => {
    const s = loadAddon();
    const data = s.compileEvalData_([evaluation("google", "gemini", makeScores(4))], blocks);

    expect(data.scores.accuracy).toBe(4);
    expect(data.scores.clarity).toBe(4);
    expect(data.scores.cultural).toBe(4);
    expect(data.scores.voice).toBe(4);
    expect(data.scores.consistency).toBe(4);
    expect(data.scores.weightedOverall).toBe(4.2);
    expect(data.scores.priorityRating).toBe("Medium");
  });

  test("collapses to a single-entry models[] with its raw scores", () => {
    const s = loadAddon();
    const data = s.compileEvalData_([evaluation("google", "gemini-3.5-flash", makeScores())], blocks);

    expect(data.models).toHaveLength(1);
    expect(data.models[0].model).toBe("gemini-3.5-flash");
    expect(data.models[0].raw.accuracy_and_relevance.strengths).toBe("clear");
  });

  test("raw_eval_text round-trips to the per-dimension detail the sidebar reads", () => {
    const s = loadAddon();
    const data = s.compileEvalData_([evaluation("google", "gemini", makeScores())], blocks);
    const parsed = JSON.parse(data.raw_eval_text);

    expect(parsed.accuracy_and_relevance.strengths).toBe("clear");
    expect(parsed.consistency_and_style.recommendations).toBe("none");
  });

  test("blank score becomes empty string, not zero", () => {
    const scores = makeScores();
    delete scores.accuracy_and_relevance.score;
    const data = loadAddon().compileEvalData_([evaluation("g", "m", scores)], blocks);

    expect(data.scores.accuracy).toBe("");
  });

  test("joins block text for the debug panel", () => {
    const s = loadAddon();
    const data = s.compileEvalData_([evaluation("g", "m", makeScores())], [
      { original_text: "A", translated_text: "X" },
      { original_text: "B", translated_text: "Y" },
    ]);

    expect(data.source_text).toBe("A\n\nB");
    expect(data.translated_text).toBe("X\n\nY");
  });
});

describe("compileEvalData_ (multiple models)", () => {
  const blocks = [{ id: "b01", original_text: "Hello", translated_text: "Hola" }];

  function twoModels() {
    return [
      evaluation("anthropic", "claude-opus-4-8", makeScores(4, 4.4, "Low")),
      evaluation("google", "gemini-3.5-flash", makeScores(2, 3.0, "High")),
    ];
  }

  test("headline weightedOverall is the average of both models", () => {
    const data = loadAddon().compileEvalData_(twoModels(), blocks);
    expect(data.scores.weightedOverall).toBe(3.7); // (4.4 + 3.0) / 2
  });

  test("per-dimension score is averaged and rounded to one decimal", () => {
    const data = loadAddon().compileEvalData_(twoModels(), blocks);
    expect(data.scores.accuracy).toBe(3); // (4 + 2) / 2
  });

  test("rounds a non-terminating average to one decimal", () => {
    const models = [
      evaluation("a", "m1", makeScores(4, 4.0, "Low")),
      evaluation("b", "m2", makeScores(5, 5.0, "Low")),
      evaluation("c", "m3", makeScores(5, 5.0, "Low")),
    ];
    const data = loadAddon().compileEvalData_(models, blocks);
    expect(data.scores.accuracy).toBe(4.7); // 14/3 = 4.666...
  });

  test("compiled priority is the most severe across models", () => {
    const data = loadAddon().compileEvalData_(twoModels(), blocks);
    expect(data.scores.priorityRating).toBe("High"); // High beats Low
  });

  test("keeps each model's own scores and raw for the hover breakdown", () => {
    const data = loadAddon().compileEvalData_(twoModels(), blocks);

    expect(data.models).toHaveLength(2);
    expect(data.models[0].model).toBe("claude-opus-4-8");
    expect(data.models[0].scores.weightedOverall).toBe(4.4);
    expect(data.models[1].scores.weightedOverall).toBe(3.0);
    expect(data.models[1].raw.accuracy_and_relevance.score).toBe(2);
  });

  test("returns both models' full detail from the sidebar entry point", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue(mockResponse(200, { evaluations: twoModels() })),
      },
    });

    const returned = s.evaluateTranslationFromSidebar();
    expect(returned.models).toHaveLength(2);
    expect(returned.scores.weightedOverall).toBe(3.7);
    expect(returned.models[0].raw.accuracy_and_relevance.score).toBe(4); // full, untrimmed
  });
});

describe("evaluateTranslationFromSidebar", () => {
  const OK_BODY = {
    status: "ok",
    evaluations: [{ provider: "google", model: "gemini-3.5-flash", scores: makeScores() }],
  };

  test("posts doc blocks and returns the full result (no doc-property storage)", () => {
    const documentProps = {};
    const s = loadAddon({
      _documentProps: documentProps,
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: { fetch: jest.fn().mockReturnValue(mockResponse(200, OK_BODY)) },
    });

    const result = s.evaluateTranslationFromSidebar();
    expect(result.scores.weightedOverall).toBe(4.2); // full result returned for render

    const [url, options] = s.UrlFetchApp.fetch.mock.calls[0];
    expect(url).toBe("https://eval.example/");
    expect(options.headers.Authorization).toBe("Bearer fake-token");

    const payload = JSON.parse(options.payload);
    expect(payload.documentId).toBe("doc-123");
    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[0].translated_text).toBe("Hola");

    // Result is persisted to Drive by the function, not to Document Properties.
    expect(documentProps.EVAL_RESULT).toBeUndefined();
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

});

// Build the combined-file JSON the eval function writes to Drive. It carries a
// contentHash (for staleness), not the translation itself.
function combinedFile(evaluations, contentHash) {
  return JSON.stringify({
    documentId: "doc-123",
    evaluatedAt: "2026-07-29T00:00:00Z",
    contentHash: contentHash || "",
    evaluations,
  });
}

describe("getEvalData (reads latest result from Drive)", () => {
  test("returns null when the doc has no result file yet", () => {
    expect(loadAddon().getEvalData()).toBeNull();
  });

  test("queries Drive by the active doc id", () => {
    const s = loadAddon({
      _driveResultsByDoc: { "doc-123": "file-1" },
      _driveFiles: { "file-1": combinedFile([evaluation("google", "gemini", makeScores())]) },
    });
    s.getEvalData();

    const q = s.Drive.Files.list.mock.calls[0][0].q;
    expect(q).toContain("documentId");
    expect(q).toContain("doc-123");
  });

  test("loads and compiles the latest file for the doc", () => {
    const s = loadAddon({
      _driveResultsByDoc: { "doc-123": "file-1" },
      _driveFiles: {
        "file-1": combinedFile([
          evaluation("anthropic", "claude-opus-4-8", makeScores(4, 4.4, "Low")),
          evaluation("google", "gemini-3.5-flash", makeScores(2, 3.0, "High")),
        ]),
      },
    });

    const data = s.getEvalData();
    expect(data.models).toHaveLength(2);
    expect(data.scores.weightedOverall).toBe(3.7); // compiled from the Drive file
    expect(data.timestamp).toBe("2026-07-29T00:00:00Z");
  });

  test("returns null when the query finds a file that can't be read", () => {
    const s = loadAddon({
      _driveResultsByDoc: { "doc-123": "missing" },
      _driveFiles: {}, // getFileById throws
    });
    expect(s.getEvalData()).toBeNull(); // caller re-runs
  });

  test("nothing is written to Document Properties", () => {
    const documentProps = {};
    const s = loadAddon({
      _documentProps: documentProps,
      _driveResultsByDoc: { "doc-123": "file-1" },
      _driveFiles: { "file-1": combinedFile([evaluation("google", "gemini", makeScores())]) },
    });
    s.getEvalData();
    expect(documentProps.EVAL_RESULT).toBeUndefined();
  });
});

describe("staleness (stored contentHash vs current doc)", () => {
  // The hash of the default mock table, as the add-on itself computes it.
  function hashOfCurrentDoc() {
    const probe = loadAddon();
    return probe.hashBlocks_(probe.extractDocBlocks_());
  }

  test("not stale when the stored hash matches the current doc", () => {
    const s = loadAddon({
      _driveResultsByDoc: { "doc-123": "file-1" },
      _driveFiles: { "file-1": combinedFile([evaluation("google", "gemini", makeScores())], hashOfCurrentDoc()) },
    });
    expect(s.getEvalData().stale).toBe(false);
  });

  test("stale when the stored hash differs from the current doc", () => {
    const s = loadAddon({
      _driveResultsByDoc: { "doc-123": "file-1" },
      _driveFiles: { "file-1": combinedFile([evaluation("google", "gemini", makeScores())], "some-old-hash") },
    });
    expect(s.getEvalData().stale).toBe(true);
  });

  test("sends a contentHash in the eval request", () => {
    const s = loadAddon({
      _scriptProps: { EVAL_QUALITY_FUNCTION_URL: "https://eval.example/" },
      UrlFetchApp: {
        fetch: jest.fn().mockReturnValue(mockResponse(200, {
          evaluations: [evaluation("google", "gemini", makeScores())],
        })),
      },
    });
    s.evaluateTranslationFromSidebar();
    const payload = JSON.parse(s.UrlFetchApp.fetch.mock.calls[0][1].payload);
    expect(payload.contentHash).toBeTruthy();
  });
});
