// Cell ranges used to place and format text in the review doc's table
// (translate/doc-writer.js getCellIndices). Shapes follow the Docs API:
// a cell's content is a list of paragraphs, each ending in "\n".

const { getCellIndices } = require("../translate/doc-writer.js");

/** A cell whose paragraphs start at `start`, one per line of text (each line + "\n"). */
function cell(start, ...lines) {
  let index = start;
  const content = (lines.length ? lines : [""]).map((line) => {
    const begin = index;
    index += line.length + 1;
    return {
      startIndex: begin, endIndex: index,
      paragraph: { elements: [{ startIndex: begin, endIndex: index, textRun: { content: `${line}\n` } }] },
    };
  });
  return { content };
}

const tableOf = (...rows) => ({ table: { tableRows: rows.map((cells) => ({ tableCells: cells })) } });

describe("getCellIndices", () => {
  test("empty cells: start and end of the empty paragraph (where text is inserted)", () => {
    expect(getCellIndices(tableOf([cell(5), cell(7)]))).toEqual([[{ start: 5, end: 6 }, { start: 7, end: 8 }]]);
  });

  test("a single-line cell spans its text", () => {
    expect(getCellIndices(tableOf([cell(10, "Hola")]))).toEqual([[{ start: 10, end: 15 }]]);
  });

  test("a cell with a line break spans every line, not just the first", () => {
    // "123 Main St" (11 + 1) then "Suite 4" (7 + 1): 10..30
    expect(getCellIndices(tableOf([cell(10, "123 Main St", "Suite 4")]))).toEqual([[{ start: 10, end: 30 }]]);
  });

  test("a cell without a paragraph is an error", () => {
    expect(() => getCellIndices(tableOf([{ content: [{ table: {} }] }]))).toThrow("missing expected paragraph");
  });
});
