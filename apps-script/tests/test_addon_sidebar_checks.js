const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ADDON_PATH = path.resolve(__dirname, "../editor-addon/addon.js");

function translationJson(blocks) {
  return JSON.stringify({ blocks: blocks || [], metadata: {} });
}

/**
 * Build a mock table where cells track their text and support replaceText.
 * rows is an array of [col0, col1] string pairs.
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
  test("replaces in the target row (blockIndex) first", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
      ["Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Hola", "Buenos días", 0);
    expect(result.replaced).toBe(true);
    expect(result.count).toBe(1);
    expect(table._cells[1][1]._text).toBe("Buenos días");
    expect(table._cells[2][1].replaceText).not.toHaveBeenCalled();
  });

  test("falls back to scanning all rows when target row doesn't match", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
      ["Goodbye", "Adiós"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("Adiós", "Hasta luego", 0);
    expect(result.replaced).toBe(true);
    expect(table._cells[2][1]._text).toBe("Hasta luego");
  });

  test("returns not-replaced for empty or identical inputs", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Hello", "Hola"],
    ]);
    const env = loadAddon({ _table: table });

    expect(env.replaceTranslationInDoc("", "alt", 0).replaced).toBe(false);
    expect(env.replaceTranslationInDoc("Hola", "", 0).replaced).toBe(false);
    expect(env.replaceTranslationInDoc("Hola", "Hola", 0).replaced).toBe(false);
  });

  test("escapes regex special characters in the search text", () => {
    const table = mockTable([
      ["English", "Spanish"],
      ["Price", "$100 (USD)"],
    ]);
    const env = loadAddon({ _table: table });

    const result = env.replaceTranslationInDoc("$100 (USD)", "$100 (dólares)", 0);
    expect(result.replaced).toBe(true);
    expect(table._cells[1][1]._text).toBe("$100 (dólares)");
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
        ["English", "Spanish"],
        ["Hello world", "Hola mundo"],
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
        ["English", "Spanish"],
        ["Different text", "Texto diferente"],
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
        ["English", "Spanish"],
        ["Hello world", "Changed by reviewer"],
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
        ["English", "Spanish"],
        ["Benefits info", "Información de beneficios"],
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
        ["English", "Spanish"],
        ["Hello", "Hola"],
        ["Goodbye", "Adiós"],
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
