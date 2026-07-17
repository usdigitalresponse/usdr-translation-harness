const { google } = require("googleapis");

// https://developers.google.com/docs/api/reference/rest
const DOCS_API_VERSION = "v1";

const EXPECTED_HEADER_ORIGINAL = "Original Text (English)";
const EXPECTED_HEADER_TRANSLATED = "Translated Text (Spanish)";
const MIN_TABLE_ROWS = 2;
const COL_ORIGINAL = 0;
const COL_TRANSLATED = 1;

/**
 * Read the side-by-side translation table from a Google Doc.
 * Returns an array of { original_text, translated_text } objects,
 * one per content row (skipping the header row).
 *
 * Validates that the header row matches the expected labels and that
 * the first content row has non-empty text in both columns.
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

  validateHeader(rows[0]);
  validateFirstContentRow(rows[1]);

  const blocks = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].tableCells || [];
    const original = extractCellText(cells[COL_ORIGINAL]);
    const translated = extractCellText(cells[COL_TRANSLATED]);
    blocks.push({ original_text: original, translated_text: translated });
  }

  return blocks;
}

function validateHeader(headerRow) {
  const cells = headerRow.tableCells || [];
  const col0 = extractCellText(cells[COL_ORIGINAL]);
  const col1 = extractCellText(cells[COL_TRANSLATED]);

  if (col0 !== EXPECTED_HEADER_ORIGINAL || col1 !== EXPECTED_HEADER_TRANSLATED) {
    throw new Error(
      "Unexpected table header — expected [\"" + EXPECTED_HEADER_ORIGINAL +
      "\", \"" + EXPECTED_HEADER_TRANSLATED +
      "\"] but got [\"" + col0 + "\", \"" + col1 + "\"]"
    );
  }
}

function validateFirstContentRow(row) {
  const cells = row.tableCells || [];
  const original = extractCellText(cells[COL_ORIGINAL]);
  const translated = extractCellText(cells[COL_TRANSLATED]);

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

module.exports = { readDocTable };
