const { google } = require("googleapis");

// https://developers.google.com/docs/api/reference/rest
const DOCS_API_VERSION = "v1";

// Header labels Translate writes (translate/doc-writer.js). Columns are located
// by label, so both layouts work: current docs are
// | Block | Original Text (English) | Translated Text (Spanish) |,
// older docs have no Block column.
const HEADER_BLOCK_ID = "Block";
const EXPECTED_HEADER_ORIGINAL = "Original Text (English)";
const EXPECTED_HEADER_TRANSLATED = "Translated Text (Spanish)";
const MIN_TABLE_ROWS = 2;
const NOT_FOUND = -1;

/**
 * Read the side-by-side translation table from a Google Doc.
 * Returns an array of { original_text, translated_text, block_id } objects,
 * one per content row (skipping the header row). block_id is the row's
 * Block column value, or "" for older docs without that column.
 *
 * Locates columns by their header labels (see getColumnLayout) and validates
 * that the first content row has text.
 */
async function readDocTable(documentId, auth) {
  const docs = google.docs({ version: DOCS_API_VERSION, auth });
  const { data: doc } = await docs.documents.get({ documentId });
  const content = doc.body?.content || [];

  const tableElement = content.find((el) => el.table);
  if (!tableElement) {
    throw new Error("No table found in document");
  }

  const rows = tableElement.table.tableRows || [];
  if (rows.length < MIN_TABLE_ROWS) {
    throw new Error("Table has no content rows (only " + rows.length + " row(s) found)");
  }

  const cols = getColumnLayout(rows[0]);
  validateFirstContentRow(rows[1], cols);

  const blocks = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].tableCells || [];
    blocks.push({
      original_text: extractCellText(cells[cols.original]),
      translated_text: extractCellText(cells[cols.translated]),
      block_id: cols.blockId === NOT_FOUND ? "" : extractCellText(cells[cols.blockId]).trim(),
    });
  }

  return blocks;
}

/**
 * Find the column index of each labeled column in the header row.
 * @returns {{ original: number, translated: number, blockId: number }}
 *   blockId is NOT_FOUND for docs without a Block column.
 * @throws if the English or Spanish column is missing.
 */
function getColumnLayout(headerRow) {
  const labels = (headerRow.tableCells || []).map((cell) => extractCellText(cell).trim());
  const cols = {
    original: labels.indexOf(EXPECTED_HEADER_ORIGINAL),
    translated: labels.indexOf(EXPECTED_HEADER_TRANSLATED),
    blockId: labels.indexOf(HEADER_BLOCK_ID),
  };

  if (cols.original === NOT_FOUND || cols.translated === NOT_FOUND) {
    throw new Error(
      "Unexpected table header — expected columns \"" + EXPECTED_HEADER_ORIGINAL +
      "\" and \"" + EXPECTED_HEADER_TRANSLATED +
      "\" but got " + JSON.stringify(labels)
    );
  }
  return cols;
}

function validateFirstContentRow(row, cols) {
  const cells = row.tableCells || [];
  const original = extractCellText(cells[cols.original]);
  const translated = extractCellText(cells[cols.translated]);

  if (!original.trim() && !translated.trim()) {
    throw new Error("First content row is empty — table may not contain translation data");
  }
}

function extractCellText(cell) {
  if (!cell?.content) return "";
  return cell.content
    .map((el) => {
      const paragraph = el.paragraph;
      if (!paragraph?.elements) return "";
      return paragraph.elements
        .map((e) => e.textRun?.content || "")
        .join("");
    })
    .join("")
    .replace(/\n$/, "");
}

module.exports = { readDocTable, getColumnLayout };
