const { google } = require("googleapis");

const { TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES } = require("./decisions");

// https://developers.google.com/sheets/api/reference/rest
const SHEETS_API_VERSION = "v4";
const DRIVE_FILE_URL_PREFIX = "https://drive.google.com/file/d/";
const DOCS_URL_PREFIX = "https://docs.google.com/document/d/";
const DOC_ID_NOT_AVAILABLE = "Document ID not available";
const TRANSLATION_FILE_ID_NOT_AVAILABLE = "Translation file ID not available";
const COLUMN_RANGE = "!A:G";

/**
 * Append terminology decisions to the derived glossary Google Sheet,
 * routing each decision to the appropriate tab based on its classification.
 *
 * Tabs:
 *   Reviewed — reviewer interacted with the sidebar (highest confidence)
 *   ModelFlagged — changed text overlaps with a model-flagged phrase
 *   OtherChanges — everything else (grammar, short words, incidental)
 *
 * Columns per tab: timestamp, aiTerm, reviewerTerm, blockId, reviewSignal, docUrl, translationJsonUrl
 *
 * @param {Array<Object>} decisions
 * @param {string} sheetId - Google Sheet ID for the derived glossary
 * @param {object} auth - GoogleAuth instance
 */
async function writeDecisions(decisions, sheetId, auth) {
  const sheets = google.sheets({ version: SHEETS_API_VERSION, auth });
  const timestamp = new Date().toISOString();

  const tabGroups = {
    [TAB_REVIEWED]: [],
    [TAB_MODEL_FLAGGED]: [],
    [TAB_OTHER_CHANGES]: [],
  };

  for (const d of decisions) {
    const tab = d.tab || TAB_OTHER_CHANGES;
    const row = [
      timestamp,
      d.aiTerm,
      d.reviewerTerm,
      d.blockId,
      d.reviewSignal,
      looksLikeId(d.documentId) ? DOCS_URL_PREFIX + d.documentId : DOC_ID_NOT_AVAILABLE,
      looksLikeId(d.translationFileId) ? DRIVE_FILE_URL_PREFIX + d.translationFileId : TRANSLATION_FILE_ID_NOT_AVAILABLE,
    ];
    tabGroups[tab].push(row);
  }

  const writePromises = [];
  for (const [tab, rows] of Object.entries(tabGroups)) {
    if (!rows.length) continue;
    writePromises.push(
      sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: tab + COLUMN_RANGE,
        valueInputOption: "RAW",
        requestBody: { values: rows },
      })
    );
  }

  await Promise.all(writePromises);
}

function looksLikeId(value) {
  return value && !value.includes(" ");
}

module.exports = { writeDecisions };
