// readDocTable: reads the translation table from a Google Doc via the Docs API
// (mocked). Covers the current three-column layout (with a Block column) and
// older two-column docs.

const mockDocumentsGet = jest.fn();
jest.mock("../capture-feedback/node_modules/googleapis", () => ({
  google: {
    docs: () => ({ documents: { get: mockDocumentsGet } }),
  },
}));

const { readDocTable } = require("../capture-feedback/doc-reader.js");

function cell(text) {
  return { content: [{ paragraph: { elements: [{ textRun: { content: text + "\n" } }] } }] };
}

function docWithTable(rows) {
  return {
    data: {
      body: {
        content: [
          { paragraph: {} },
          { table: { tableRows: rows.map((r) => ({ tableCells: r.map(cell) })) } },
        ],
      },
    },
  };
}

const HEADER_3 = ["Block", "Original Text (English)", "Translated Text (Spanish)"];
const HEADER_2 = ["Original Text (English)", "Translated Text (Spanish)"];

describe("readDocTable", () => {
  beforeEach(() => mockDocumentsGet.mockReset());

  test("reads the current three-column layout, including block IDs", async () => {
    mockDocumentsGet.mockResolvedValue(docWithTable([
      HEADER_3,
      ["b01", "Hello", "Hola"],
      ["b03", "Goodbye", "Adiós"],
    ]));

    const blocks = await readDocTable("doc-1", {});

    expect(blocks).toEqual([
      { original_text: "Hello", translated_text: "Hola", block_id: "b01" },
      { original_text: "Goodbye", translated_text: "Adiós", block_id: "b03" },
    ]);
  });

  test("reads older two-column docs with an empty block ID", async () => {
    mockDocumentsGet.mockResolvedValue(docWithTable([
      HEADER_2,
      ["Hello", "Hola"],
    ]));

    const blocks = await readDocTable("doc-1", {});

    expect(blocks).toEqual([{ original_text: "Hello", translated_text: "Hola", block_id: "" }]);
  });

  test("finds columns by label regardless of order", async () => {
    mockDocumentsGet.mockResolvedValue(docWithTable([
      ["Translated Text (Spanish)", "Block", "Original Text (English)"],
      ["Hola", "b01", "Hello"],
    ]));

    const [block] = await readDocTable("doc-1", {});

    expect(block).toEqual({ original_text: "Hello", translated_text: "Hola", block_id: "b01" });
  });

  test("rejects a table without the English and Spanish columns", async () => {
    mockDocumentsGet.mockResolvedValue(docWithTable([
      ["Block", "Notes"],
      ["b01", "something"],
    ]));

    await expect(readDocTable("doc-1", {})).rejects.toThrow(/Unexpected table header/);
  });

  test("rejects a document with no table", async () => {
    mockDocumentsGet.mockResolvedValue({ data: { body: { content: [{ paragraph: {} }] } } });

    await expect(readDocTable("doc-1", {})).rejects.toThrow("No table found");
  });

  test("rejects an empty first content row", async () => {
    mockDocumentsGet.mockResolvedValue(docWithTable([
      HEADER_3,
      ["b01", "", ""],
    ]));

    await expect(readDocTable("doc-1", {})).rejects.toThrow(/First content row is empty/);
  });
});
