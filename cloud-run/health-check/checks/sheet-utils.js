// Shared helpers for the sheet checks. Header matching follows the services:
// trimmed and case-insensitive, with extra columns after the expected ones allowed.

const ALPHABET_SIZE = 26;
const CHAR_CODE_A = "A".charCodeAt(0);

/** A1 range on a named tab, quoting the tab name as Sheets requires. */
function tabRange(tab, cells) {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

/**
 * Read a range's values. Throws the API error (e.g. tab missing, no access).
 *
 * @param {Object} sheets - googleapis Sheets v4 client
 * @param {Object} [options] - extra values.get parameters
 * @returns {Promise<Array<Array<*>>>}
 */
async function readValues(sheets, spreadsheetId, range, options = {}) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range, ...options });
  return data.values || [];
}

function normalize(header) {
  return String(header ?? "").trim().toLowerCase();
}

/**
 * Compare row 1 to the expected headers, in order.
 *
 * @returns {string|null} What differs, or null if it matches
 */
function headerMismatch(headerRow, expected) {
  const actual = (headerRow || []).map(normalize);
  const diffs = [];
  expected.forEach((want, i) => {
    if (actual[i] !== normalize(want)) {
      diffs.push(`column ${columnLetter(i)} should be "${want}" but is "${(headerRow || [])[i] ?? ""}"`);
    }
  });
  return diffs.length ? diffs.join("; ") : null;
}

/**
 * Required columns absent from the header row, in any position.
 *
 * @returns {string[]}
 */
function missingColumns(headerRow, required) {
  const actual = (headerRow || []).map(normalize);
  return required.filter((col) => !actual.includes(normalize(col)));
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" */
function columnLetter(index) {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / ALPHABET_SIZE)) {
    letters = String.fromCharCode(CHAR_CODE_A + ((n - 1) % ALPHABET_SIZE)) + letters;
  }
  return letters;
}

module.exports = { tabRange, readValues, headerMismatch, missingColumns, normalize, columnLetter };
