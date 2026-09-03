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
