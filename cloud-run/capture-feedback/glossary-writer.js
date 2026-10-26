const { google } = require("googleapis");

const { TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES } = require("./decisions");
const { logInputProblem, INPUT_REFINEMENT_LOG } = require("./input-problems");

// https://developers.google.com/sheets/api/reference/rest
const SHEETS_API_VERSION = "v4";
const DRIVE_FILE_URL_PREFIX = "https://drive.google.com/file/d/";
const DOCS_URL_PREFIX = "https://docs.google.com/document/d/";
const DOC_ID_NOT_AVAILABLE = "Document ID not available";
const TRANSLATION_FILE_ID_NOT_AVAILABLE = "Translation file ID not available";
const COLUMN_RANGE = "!A:L";
const HEADER_RANGE = "!A1:L1";

// Row 1 of every refinement log tab, in column order. Rows are written by
// position, so a renamed, inserted, or moved column would scramble them; a tab
// whose header row doesn't match is skipped (the decisions are still in the
// feedback JSON in Drive). Compared case-insensitively; extra columns after
// these are allowed.
const REFINEMENT_LOG_HEADERS = [
  "Timestamp", "Reviewer Email", "AI Term", "Reviewer Term", "Block ID", "Review Signal",
  "AI Sentence", "Doc URL", "Translation JSON URL", "Content Type", "English Source",
  "Reviewer Sentence",
];

/**
 * Check a tab's header row against REFINEMENT_LOG_HEADERS.
 *
 * @param {string[]} headerRow - Row 1 of the tab
 * @returns {string|null} A description of the mismatch, or null if it matches
 */
function checkHeaders(headerRow) {
  const found = (headerRow || []).map((h) => String(h).trim());
  const matches = REFINEMENT_LOG_HEADERS.every(
    (expected, i) => (found[i] || "").toLowerCase() === expected.toLowerCase()
  );
  if (matches) return null;
  return `header row doesn't match. Expected: ${REFINEMENT_LOG_HEADERS.join(", ")}. ` +
    `Found: ${found.slice(0, REFINEMENT_LOG_HEADERS.length).join(", ")}`;
}

/**
 * Append terminology decisions to the refinement log Google Sheet,
 * routing each decision to the appropriate tab based on its classification.
 *
 * Tabs:
 *   Reviewed — reviewer interacted with the sidebar (highest confidence)
 *   ModelFlagged — changed text overlaps with a model-flagged phrase
 *   OtherChanges — everything else (grammar, short words, incidental)
 *
 * Columns per tab (A–L, see REFINEMENT_LOG_HEADERS): timestamp, reviewerEmail,
 * aiTerm, reviewerTerm, blockId, reviewSignal, AI sentence (sourceText), docUrl,
 * translationJsonUrl, contentType, English source, reviewer sentence.
 *
 * Each tab's header row is checked before writing; a tab that doesn't match is
 * skipped and reported as a failure, like a tab whose write fails.
 *
 * @param {Array<Object>} decisions
 * @param {string} sheetId - Google Sheet ID for the refinement log
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
      d.reviewerEmail || "",
      d.aiTerm,
      d.reviewerTerm,
      d.blockId,
      d.reviewSignal,
      d.sourceText || "",
      looksLikeId(d.documentId) ? DOCS_URL_PREFIX + d.documentId : DOC_ID_NOT_AVAILABLE,
      looksLikeId(d.translationFileId) ? DRIVE_FILE_URL_PREFIX + d.translationFileId : TRANSLATION_FILE_ID_NOT_AVAILABLE,
      d.contentType || "",
      d.englishSource || "",
      d.reviewerSentence || "",
    ];
    tabGroups[tab].push(row);
  }

  const tabsToWrite = Object.entries(tabGroups).filter(([, rows]) => rows.length);
  const results = await Promise.allSettled(
    tabsToWrite.map(async ([tab, rows]) => {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: tab + HEADER_RANGE,
      });
      const headerProblem = checkHeaders((data.values || [])[0]);
      if (headerProblem) throw new Error(headerProblem);

      return sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: tab + COLUMN_RANGE,
        valueInputOption: "RAW",
        requestBody: { values: rows },
      });
    })
  );

  // Tabs are written independently, so one renamed or deleted tab (or one with
  // a mismatched header row) doesn't stop the others; report every tab that failed.
  const failures = results
    .map((result, i) => ({ tab: tabsToWrite[i][0], rows: tabsToWrite[i][1].length, result }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length) {
    const error = new Error(
      failures.map(({ tab, result }) => `${tab} tab: ${result.reason.message}`).join("; ")
    );
    error.failedTabs = failures.map(({ tab, rows }) => ({ tab, rows }));
    throw error;
  }
}

/**
 * Record decisions in the refinement log (the "derived glossary" sheet),
 * logging an input problem instead of throwing when that isn't possible:
 * the sheet ID isn't set on Cloud Run, or a tab write fails (e.g. a tab was
 * renamed or deleted, or its header row doesn't match).
 *
 * @param {Array<Object>} decisions
 * @param {string|undefined} sheetId - DERIVED_GLOSSARY_SHEET_ID
 * @param {object} auth - GoogleAuth instance
 * @returns {Promise<string|null>} A warning for the add-on's response, or null
 */
async function recordDecisions(decisions, sheetId, auth) {
  if (!decisions.length) return null;

  if (!sheetId) {
    if (!process.env.K_SERVICE) return null; // local runs don't write the log
    const detail = `DERIVED_GLOSSARY_SHEET_ID is not set, so ${decisions.length} decisions were not recorded`;
    logInputProblem(INPUT_REFINEMENT_LOG, detail, { decisions: decisions.length });
    return "Refinement log not configured: " + detail;
  }

  try {
    await writeDecisions(decisions, sheetId, auth);
    return null;
  } catch (err) {
    logInputProblem(
      INPUT_REFINEMENT_LOG,
      `could not write decisions to the refinement log (${err.message}). ` +
        `Check that the ${[TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES].join(" / ")} tabs exist with these exact names, ` +
        "and that row 1 of each has the expected column headers.",
      { failed_tabs: err.failedTabs || [] }
    );
    return "Failed to write to the refinement log: " + err.message;
  }
}

function looksLikeId(value) {
  return value && !value.includes(" ");
}

module.exports = { writeDecisions, recordDecisions, REFINEMENT_LOG_HEADERS };
