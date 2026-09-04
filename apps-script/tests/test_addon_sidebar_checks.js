const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ADDON_PATH = path.resolve(__dirname, "../editor-addon/addon.js");

function translationJson(blocks) {
  return JSON.stringify({ blocks: blocks || [], metadata: {} });
}

/**
 * Build a mock table where cells track their text and support replaceText.
 * rows is an array of [blockId, original, translated] triples.
 */
function mockTable(rows) {
  const cells = rows.map((row) =>
    row.map((text) => {
      const cell = {
        _text: text,
        getText: () => cell._text,
        replaceText: jest.fn((pattern, replacement) => {
          cell._text = cell._text.replace(new RegExp(pattern, "g"), replacement);
        }),
        getNumChildren: () => 1,
        getChild: () => ({
          getType: () => "PARAGRAPH",
          asText: () => ({
            getText: () => cell._text,
            setBackgroundColor: jest.fn(),
          }),
        }),
      };
      return cell;
    })
  );

  return {
    getNumRows: () => rows.length,
    getRow: (r) => ({
      getCell: (c) => cells[r][c],
      getNumCells: () => cells[r].length,
    }),
    _cells: cells,
  };
}

/**
 * Build a Drive.Files mock that handles both the doc-property lookup
 * (returns { properties: { usdr_translation_review: fileId } }) and
 * the content fetch (alt: "media" → returns parsed JSON string).
 */
function mockDriveFiles(translationFileId, driveFileContents) {
  return {
    get: jest.fn((id, opts) => {
      if (opts && opts.alt === "media") {
        if (id in driveFileContents) return driveFileContents[id];
        throw new Error("File not found: " + id);
      }
      return {
        properties: translationFileId
          ? { usdr_translation_review: translationFileId }
          : {},
      };
    }),
    list: jest.fn(() => ({ files: [] })),
  };
}

function loadAddon(globals = {}) {
  const documentProps = globals._documentProps || {};
  const table = globals._table !== undefined ? globals._table : null;

  const bodyText = globals._bodyText || "";

  const driveFileContents = globals._driveFileContents || {};
  const translationFileId = globals._translationFileId || null;

  const defaults = {
    Logger: { log: jest.fn() },
    PropertiesService: {
      getDocumentProperties: jest.fn().mockReturnValue({
        getProperty: jest.fn((k) => (k in documentProps ? documentProps[k] : null)),
        setProperty: jest.fn((k, v) => { documentProps[k] = v; }),
      }),
      getScriptProperties: jest.fn().mockReturnValue({
        getProperty: jest.fn(() => null),
      }),
    },
    DocumentApp: {
      getActiveDocument: jest.fn().mockReturnValue({
        getId: () => "doc-123",
        getBody: () => ({
          getNumChildren: () => (table ? 1 : 0),
          getChild: () => (table ? { getType: () => "TABLE", asTable: () => table } : null),
          getText: () => bodyText,
          replaceText: jest.fn(),
        }),
      }),
      ElementType: { TABLE: "TABLE", PARAGRAPH: "PARAGRAPH" },
      getUi: jest.fn().mockReturnValue({ alert: jest.fn(), ButtonSet: { OK: "OK" } }),
    },
    Drive: {
      Files: globals._driveFiles || mockDriveFiles(translationFileId, driveFileContents),
    },
    DriveApp: {
      getFileById: jest.fn((id) => {
        if (!(id in driveFileContents)) throw new Error("File not found: " + id);
        return { getBlob: () => ({ getDataAsString: () => driveFileContents[id] }) };
      }),
    },
    UrlFetchApp: { fetch: jest.fn() },
    ScriptApp: { getIdentityToken: jest.fn().mockReturnValue("fake-token") },
    HtmlService: { createHtmlOutputFromFile: jest.fn() },
    Utilities: {
      DigestAlgorithm: { MD5: "MD5" },
      Charset: { UTF_8: "UTF_8" },
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

// ── alwaysShowAlt persistence ───────────────────────────────────────────

describe("saveSidebarChecks / getSidebarData round-trip", () => {
  const FILE_ID = "translation-file-1";

  function setup(extraDocProps) {
    const content = translationJson([{ id: "b1" }]);
    return loadAddon({
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: content },
      _documentProps: extraDocProps || {},
    });
  }

  test("alwaysShowAlt persists and loads back", () => {
    const env = setup();

    env.saveSidebarChecks({
      status: { "alt_translations::0": "accepted" },
      flagged: {},
      alwaysShowAlt: true,
    });

    const result = env.getSidebarData();
    expect(result.checks.alwaysShowAlt).toBe(true);
    expect(result.checks.status["alt_translations::0"]).toBe("accepted");
  });

  test("old docs without alwaysShowAlt return empty checks gracefully", () => {
    const env = setup({
      SIDEBAR_CHECKS: JSON.stringify({ status: { "x::0": "fixed" }, flagged: {} }),
    });

    const result = env.getSidebarData();
    expect(result.checks.alwaysShowAlt).toBeUndefined();
    expect(result.checks.status["x::0"]).toBe("fixed");
  });

  test("alwaysShowAlt false round-trips correctly", () => {
    const env = setup();

    env.saveSidebarChecks({ status: {}, flagged: {}, alwaysShowAlt: false });

    const result = env.getSidebarData();
    expect(result.checks.alwaysShowAlt).toBe(false);
  });
});

// ── getSidebarData flattening ───────────────────────────────────────────

describe("getSidebarData flattening", () => {
  const FILE_ID = "tf-1";

  test("flattens per-block items into flat section arrays with block metadata", () => {
    const blocks = [
      {
        id: "b1",
        alt_translations: [
          { original_phrase: "Hello", primary_translation: "Hola", alt_translation: "Buenos días" },
        ],
        terms_flagged_for_clarification: [
          { original_text: "benefits", translation: "beneficios", note: "ambiguous" },
        ],
      },
      {
        id: "b2",
        alt_translations: [
          { original_phrase: "Goodbye", primary_translation: "Adiós", alt_translation: "Hasta luego" },
        ],
      },
    ];
    const env = loadAddon({
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: translationJson(blocks) },
    });

    const result = env.getSidebarData();
    expect(result.data.alt_translations).toHaveLength(2);
    expect(result.data.alt_translations[0].block_id).toBe("b1");
    expect(result.data.alt_translations[0].block_index).toBe(0);
    expect(result.data.alt_translations[0].original_phrase).toBe("Hello");
    expect(result.data.alt_translations[1].block_id).toBe("b2");
    expect(result.data.alt_translations[1].block_index).toBe(1);

    expect(result.data.terms_flagged_for_clarification).toHaveLength(1);
    expect(result.data.terms_flagged_for_clarification[0].block_id).toBe("b1");
    expect(result.data.terms_flagged_for_clarification[0].note).toBe("ambiguous");
  });

  test("blocks without a section key produce empty arrays", () => {
    const env = loadAddon({
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: translationJson([{ id: "b1" }]) },
    });

    const result = env.getSidebarData();
    expect(result.data.alt_translations).toEqual([]);
    expect(result.data.terms_flagged_for_clarification).toEqual([]);
    expect(result.data.glossary_cross_check).toEqual([]);
  });

  test("assigns synthetic block_id when block has no id", () => {
    const blocks = [{ alt_translations: [{ original_phrase: "Test" }] }];
    const env = loadAddon({
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: translationJson(blocks) },
    });

    const result = env.getSidebarData();
    expect(result.data.alt_translations[0].block_id).toBe("b1");
  });

  test("returns null data when no translation file is linked", () => {
    const env = loadAddon({ _translationFileId: null });

    const result = env.getSidebarData();
    expect(result.data).toBeNull();
  });
});

// ── replaceTranslationInDoc ─────────────────────────────────────────────

describe("replaceTranslationInDoc", () => {
  test("replaces in the target row by block ID", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
      ["b02", "Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", "b01", false);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(1);
    expect(table._cells[1][2]._text).toBe("Buenos días");
    expect(table._cells[2][2].replaceText).not.toHaveBeenCalled();
  });

  test("does not replace when block ID does not match any row", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
      ["b02", "Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", "b99", false);
    expect(result.replaced).toBe(false);
  });

  test("replaceAll replaces in every row that contains the text", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola amigos"],
      ["b02", "Goodbye", "Adiós"],
      ["b03", "Welcome", "Hola amigos bienvenidos"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola amigos", "Buenos días", "b01", true);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(2);
    expect(result.blockIds).toEqual(["b01", "b03"]);
    expect(table._cells[1][2]._text).toBe("Buenos días");
    expect(table._cells[3][2]._text).toBe("Buenos días bienvenidos");
  });

  test("returns not-replaced for empty or identical inputs", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    expect(env.replaceTranslationInDoc("", "alt", "b01", false).replaced).toBe(false);
    expect(env.replaceTranslationInDoc("Hola", "", "b01", false).replaced).toBe(false);
    expect(env.replaceTranslationInDoc("Hola", "Hola", "b01", false).replaced).toBe(false);
  });

  test("escapes regex special characters in the search text", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Price", "$100 (USD)"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("$100 (USD)", "$100 (dólares)", "b01", false);
    expect(result.replaced).toBe(true);
    expect(table._cells[1][2]._text).toBe("$100 (dólares)");
  });

  test("falls back to body search when there is no table", () => {
    const bodyReplaceText = jest.fn();
    const env = loadAddon({
      _table: null,
      _bodyText: "Some Hola text",
      DocumentApp: {
        getActiveDocument: jest.fn().mockReturnValue({
          getId: () => "doc-123",
          getBody: () => ({
            getNumChildren: () => 0,
            getChild: () => null,
            getText: () => "Some Hola text",
            replaceText: bodyReplaceText,
          }),
        }),
        ElementType: { TABLE: "TABLE", PARAGRAPH: "PARAGRAPH" },
        getUi: jest.fn().mockReturnValue({ alert: jest.fn(), ButtonSet: { OK: "OK" } }),
      },
    });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", 0);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(1);
    expect(bodyReplaceText).toHaveBeenCalled();
  });
});

// ── checkItemsExist (orphan detection) ──────────────────────────────────

describe("checkItemsExist", () => {
  const FILE_ID = "tf-1";

  function setup(rows, blocks) {
    const table = mockTable(rows);
    return loadAddon({
      _table: table,
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: translationJson(blocks) },
    });
  }

  test("returns empty when all items are found in the doc", () => {
    const env = setup(
      [
        ["Block", "English", "Spanish"],
        ["b01", "Hello world", "Hola mundo"],
      ],
      [
        {
          id: "b1",
          alt_translations: [
            { original_phrase: "Hello world", primary_translation: "Hola mundo" },
          ],
        },
      ]
    );

    const orphans = env.checkItemsExist();
    expect(orphans).toEqual({});
  });

  test("detects orphan when original phrase is missing from doc", () => {
    const env = setup(
      [
        ["Block", "English", "Spanish"],
        ["b01", "Different text", "Texto diferente"],
      ],
      [
        {
          id: "b1",
          alt_translations: [
            { original_phrase: "Hello world", primary_translation: "Texto diferente" },
          ],
        },
      ]
    );

    const orphans = env.checkItemsExist();
    expect(orphans["alt_translations::0"]).toBe(true);
  });

  test("detects orphan when translation is missing from doc", () => {
    const env = setup(
      [
        ["Block", "English", "Spanish"],
        ["b01", "Hello world", "Changed by reviewer"],
      ],
      [
        {
          id: "b1",
          alt_translations: [
            { original_phrase: "Hello world", primary_translation: "Hola mundo" },
          ],
        },
      ]
    );

    const orphans = env.checkItemsExist();
    expect(orphans["alt_translations::0"]).toBe(true);
  });

  test("checks clarification items using original_text field", () => {
    const env = setup(
      [
        ["Block", "English", "Spanish"],
        ["b01", "Benefits info", "Información de beneficios"],
      ],
      [
        {
          id: "b1",
          terms_flagged_for_clarification: [
            { original_text: "Benefits info", translation: "Información de beneficios" },
          ],
        },
      ]
    );

    const orphans = env.checkItemsExist();
    expect(orphans).toEqual({});
  });

  test("indexes orphans across multiple blocks correctly", () => {
    const env = setup(
      [
        ["Block", "English", "Spanish"],
        ["b01", "Hello", "Hola"],
        ["b02", "Goodbye", "Adiós"],
      ],
      [
        {
          id: "b1",
          alt_translations: [
            { original_phrase: "Hello", primary_translation: "Hola" },
          ],
        },
        {
          id: "b2",
          alt_translations: [
            { original_phrase: "Missing phrase", primary_translation: "Frase perdida" },
          ],
        },
      ]
    );

    const orphans = env.checkItemsExist();
    expect(orphans["alt_translations::0"]).toBeUndefined();
    expect(orphans["alt_translations::1"]).toBe(true);
  });
});

// ── paintHighlight ─────────────────────────────────────────────────────

/**
 * Build a mock table where each cell's text element is stable (same object
 * on every getChild call) so setBackgroundColor calls can be inspected.
 */
function highlightTable(rows) {
  const cells = rows.map((row) =>
    row.map((text) => {
      const textEl = {
        getText: () => text,
        setBackgroundColor: jest.fn(),
      };
      const cell = {
        _text: text,
        _textEl: textEl,
        getText: () => text,
        getNumChildren: () => 1,
        getChild: () => ({
          getType: () => "PARAGRAPH",
          asText: () => textEl,
        }),
      };
      return cell;
    })
  );

  return {
    getNumRows: () => rows.length,
    getRow: (r) => ({
      getCell: (c) => cells[r][c],
      getNumCells: () => cells[r].length,
    }),
    _cells: cells,
  };
}

describe("paintHighlight", () => {
  test("highlights matching English and Spanish in yellow", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "manutención económica"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "manutención económica", [], []);
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");
    expect(result.matchedBlockIds).toEqual(["b01"]);
    // English cell highlighted in yellow
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 16, "#FFD700");
    // Spanish cell highlighted in yellow
    expect(table._cells[1][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 20, "#FFD700");
  });

  test("highlights all rows where English matches", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support from parents", "manutención económica de los padres"],
      ["b02", "receive financial support", "recibir apoyo económico"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "manutención económica", ["apoyo económico"], []);
    expect(result.matchedBlockIds).toEqual(["b01", "b02"]);
    // Both English cells get yellow on the phrase
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 16, "#FFD700");
    expect(table._cells[2][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(8, 24, "#FFD700");
    // b01 Spanish matches card's translation → yellow
    expect(table._cells[1][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 20, "#FFD700");
    // b02 Spanish has variant → first alt color (light blue)
    // "recibir apoyo económico" — "apoyo económico" starts at 8, length 15, end index 22
    expect(table._cells[2][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(8, 22, "#A8D8FF");
  });

  test("assigns distinct colors to different variant translations", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "manutención económica"],
      ["b02", "financial support", "apoyo económico"],
      ["b03", "financial support", "soporte financiero"],
    ]);
    const env = loadAddon({ _table: table });

    env.paintHighlight("financial support", "manutención económica",
      ["apoyo económico", "soporte financiero"], []);
    // b01 yellow (matches card)
    expect(table._cells[1][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 20, "#FFD700");
    // b02 first variant color
    expect(table._cells[2][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 14, "#A8D8FF");
    // b03 second variant color
    expect(table._cells[3][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 17, "#C5B4E3");
  });

  test("does not highlight rows where neither column matches", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "manutención económica"],
      ["b02", "child care", "cuidado infantil"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "manutención económica", [], []);
    expect(result.matchedBlockIds).toEqual(["b01"]);
    expect(table._cells[2][1]._textEl.setBackgroundColor).not.toHaveBeenCalled();
    expect(table._cells[2][2]._textEl.setBackgroundColor).not.toHaveBeenCalled();
  });

  test("highlights variant English phrases when Spanish matches", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "apoyo económico"],
      ["b02", "economic assistance", "apoyo económico"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "apoyo económico",
      [], ["economic assistance"]);
    expect(result.matchedBlockIds).toEqual(["b01", "b02"]);
    // b01 English yellow (matches card)
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 16, "#FFD700");
    // b02 English variant color
    expect(table._cells[2][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 18, "#A8D8FF");
    // Both Spanish cells yellow
    expect(table._cells[1][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 14, "#FFD700");
    expect(table._cells[2][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, 14, "#FFD700");
  });

  test("works on old 2-column docs without block ID column", () => {
    const table = highlightTable([
      ["English", "Spanish"],
      ["financial support", "manutención económica"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "manutención económica", [], []);
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");
    // Two-column docs have no ID column, and extract's IDs ("b01", "b04",
    // "b05a") cannot be reconstructed from a row index, so none are reported.
    expect(result.matchedBlockIds).toEqual([]);
  });

  test("returns not_found when no rows match", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "child care", "cuidado infantil"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("financial support", "manutención económica", [], []);
    expect(result.original).toBe("not_found");
    expect(result.translation).toBe("not_found");
    expect(result.matchedBlockIds).toEqual([]);
  });
});

// ── clearHighlightColumns_ ─────────────────────────────────────────────

describe("clearHighlightColumns_", () => {
  test("clears background from English and Spanish columns in 3-col doc", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "apoyo financiero"],
      ["b02", "child care", "cuidado infantil"],
    ]);
    const env = loadAddon({ _table: table });

    // Pre-paint something so there's color to clear
    env.paintHighlight("financial support", "apoyo financiero", [], []);
    // Verify paint happened
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalled();

    // Clear all mocks so we can check clearHighlightColumns_ calls in isolation
    table._cells.forEach((row) => row.forEach((c) => c._textEl.setBackgroundColor.mockClear()));

    env.clearHighlightColumns_();

    // Both content columns of both data rows should be cleared
    // paintEntireCell_ calls setBackgroundColor(0, len-1, null)
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
    expect(table._cells[1][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
    expect(table._cells[2][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
    expect(table._cells[2][2]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
  });

  test("does not touch Block ID column", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "apoyo financiero"],
    ]);
    const env = loadAddon({ _table: table });

    env.clearHighlightColumns_();

    // Block ID column (index 0) should not be touched
    expect(table._cells[1][0]._textEl.setBackgroundColor).not.toHaveBeenCalled();
  });

  test("handles 2-column docs without crash", () => {
    const table = highlightTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    env.clearHighlightColumns_();

    // English (col 0) and Spanish (col 1) should be cleared
    expect(table._cells[1][0]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
    expect(table._cells[1][1]._textEl.setBackgroundColor).toHaveBeenCalledWith(0, expect.any(Number), null);
  });

  test("no-ops when table has only a header row", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
    ]);
    const env = loadAddon({ _table: table });

    // Should not throw
    env.clearHighlightColumns_();
  });
});

// ── swapHighlight ──────────────────────────────────────────────────────

describe("swapHighlight", () => {
  test("clears all columns then paints the new phrase", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "apoyo financiero"],
      ["b02", "child care", "cuidado infantil"],
    ]);
    const env = loadAddon({ _table: table });

    // Paint the first term
    env.paintHighlight("financial support", "apoyo financiero", [], []);

    // Now swap to the second term
    const result = env.swapHighlight(
      "financial support", "apoyo financiero",
      "child care", "cuidado infantil",
      [], []
    );

    // The new term should be found and painted
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");

    // The old term's cells should have been cleared (null) by clearHighlightColumns_
    // then the new term's cells should end up with the highlight color
    // The new term's cells should end up with the highlight color as the last call
    const newOrigCalls = table._cells[2][1]._textEl.setBackgroundColor.mock.calls;
    const lastCall = newOrigCalls[newOrigCalls.length - 1];
    expect(lastCall[2]).toBe("#FFD700");
  });

  test("returns paintHighlight result for the new phrase", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.swapHighlight("", "", "Hello", "Hola", [], []);
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");
    expect(result.matchedBlockIds).toEqual(["b01"]);
  });

  test("returns not_found when new phrase is absent", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.swapHighlight("Hello", "Hola", "Goodbye", "Adiós", [], []);
    expect(result.original).toBe("not_found");
    expect(result.translation).toBe("not_found");
  });

  test("works with empty old state (first highlight)", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.swapHighlight("", "", "Hello", "Hola", [], []);
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");
  });
});

// ── replaceTranslationInDoc — 2-column fallback ──────────────────────────

describe("replaceTranslationInDoc — 2-column docs", () => {
  test("falls back to text matching when doc has no block ID column", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
      ["Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", "b01", false);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(1);
    expect(table._cells[1][1]._text).toBe("Buenos días");
  });

  test("replaceAll works on 2-column docs without block IDs", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola amigos"],
      ["Welcome", "Hola amigos bienvenidos"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola amigos", "Buenos días", "", true);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(2);
    expect(result.blockIds).toEqual([]);
  });
});

// ── replaceTranslationInDoc — selective block ID array ───────────────────

describe("replaceTranslationInDoc — block ID array", () => {
  test("replaces only in the specified block IDs", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
      ["b02", "Hi", "Hola"],
      ["b03", "Hey", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", "b01", ["b01", "b03"]);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(2);
    expect(result.blockIds).toEqual(["b01", "b03"]);
    expect(table._cells[1][2]._text).toBe("Buenos días");
    expect(table._cells[2][2]._text).toBe("Hola");
    expect(table._cells[3][2]._text).toBe("Buenos días");
  });
});

// ── rowBlockId_ ──────────────────────────────────────────────────────────

describe("rowBlockId_", () => {
  test("returns the block ID from a 3-column row", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const cols = env.getColumnLayout_(table);
    const row = table.getRow(1);
    expect(env.rowBlockId_(row, cols)).toBe("b01");
  });

  test("returns empty string for 2-column docs", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const cols = env.getColumnLayout_(table);
    const row = table.getRow(1);
    expect(env.rowBlockId_(row, cols)).toBe("");
  });

  test("trims whitespace from cell text", () => {
    const table = mockTable([
      ["Block", "English", "Spanish"],
      ["  b05a  ", "Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    const cols = env.getColumnLayout_(table);
    const row = table.getRow(1);
    expect(env.rowBlockId_(row, cols)).toBe("b05a");
  });
});

// ── getDocTextForHighlightCheck ──────────────────────────────────────────

describe("getDocTextForHighlightCheck", () => {
  test("concatenates text from original and translated columns", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "Hello world", "Hola mundo"],
      ["b02", "Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.getDocTextForHighlightCheck();
    expect(result.english).toBe("Hello world\nGoodbye");
    expect(result.spanish).toBe("Hola mundo\nAdiós");
  });

  test("returns empty strings when table has no data rows", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.getDocTextForHighlightCheck();
    expect(result.english).toBe("");
    expect(result.spanish).toBe("");
  });

  test("returns empty strings when there is no table", () => {
    const env = loadAddon({ _table: null });

    const result = env.getDocTextForHighlightCheck();
    expect(result.english).toBe("");
    expect(result.spanish).toBe("");
  });
});

// ── checkItemsExist — Unicode normalization ──────────────────────────────

describe("checkItemsExist — NFC normalization", () => {
  test("matches composed and decomposed accented characters", () => {
    const composed = "apoyo económico";
    const decomposed = "apoyo económico";

    const FILE_ID = "translation-file-1";
    const json = {
      blocks: [{
        id: "b01",
        original_text: "financial support",
        translated_text: composed,
        alt_translations: [{
          original_phrase: "financial support",
          primary_translation: composed,
          alt_translation: "ayuda financiera",
          rationale: "test",
        }],
      }],
      metadata: {},
    };

    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", decomposed],
    ]);
    const env = loadAddon({
      _table: table,
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: JSON.stringify(json) },
    });

    const orphans = env.checkItemsExist();
    expect(orphans).toEqual({});
  });

  test("flags orphan when accented text is genuinely missing", () => {
    const FILE_ID = "translation-file-1";
    const json = {
      blocks: [{
        id: "b01",
        original_text: "financial support",
        translated_text: "apoyo económico",
        alt_translations: [{
          original_phrase: "financial support",
          primary_translation: "apoyo económico",
          alt_translation: "ayuda financiera",
          rationale: "test",
        }],
      }],
      metadata: {},
    };

    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b01", "financial support", "something completely different"],
    ]);
    const env = loadAddon({
      _table: table,
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: JSON.stringify(json) },
    });

    const orphans = env.checkItemsExist();
    expect(orphans["alt_translations::0"]).toBe(true);
  });
});

// ── Smart quote normalization ──────────────────────────────────────────

describe("checkItemsExist — smart quote normalization", () => {
  test("matches curly apostrophe in doc against straight apostrophe in JSON", () => {
    const FILE_ID = "translation-file-1";
    const json = {
      blocks: [{
        id: "b06a",
        original_text: "driver's license",
        translated_text: "licencia de conducir",
        alt_translations: [{
          original_phrase: "driver's license",
          primary_translation: "licencia de conducir",
          alt_translation: "licencia de manejar",
          rationale: "test",
        }],
      }],
      metadata: {},
    };

    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b06a", "driver’s license", "licencia de conducir"],
    ]);
    const env = loadAddon({
      _table: table,
      _translationFileId: FILE_ID,
      _driveFileContents: { [FILE_ID]: JSON.stringify(json) },
    });

    const orphans = env.checkItemsExist();
    expect(orphans).toEqual({});
  });
});

describe("paintHighlight — smart quote normalization", () => {
  test("highlights cell containing curly apostrophe when needle has straight", () => {
    const table = highlightTable([
      ["Block", "English", "Spanish"],
      ["b06a", "driver’s license", "licencia de conducir"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.paintHighlight("driver's license", "licencia de conducir", [], []);
    expect(result.original).toBe("found");
    expect(result.translation).toBe("found");
  });
});
