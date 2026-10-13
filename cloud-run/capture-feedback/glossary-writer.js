const { google } = require("googleapis");

const { TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES } = require("./decisions");
const { logInputProblem, INPUT_REFINEMENT_LOG } = require("./input-problems");

// https://developers.google.com/sheets/api/reference/rest
const SHEETS_API_VERSION = "v4";
const DRIVE_FILE_URL_PREFIX = "https://drive.google.com/file/d/";
const DOCS_URL_PREFIX = "https://docs.google.com/document/d/";
const DOC_ID_NOT_AVAILABLE = "Document ID not available";
const TRANSLATION_FILE_ID_NOT_AVAILABLE = "Translation file ID not available";
const COLUMN_RANGE = "!A:J";

/**
 * Append terminology decisions to the derived glossary Google Sheet,
 * routing each decision to the appropriate tab based on its classification.
 *
 * Tabs:
 *   Reviewed — reviewer interacted with the sidebar (highest confidence)
 *   ModelFlagged — changed text overlaps with a model-flagged phrase
 *   OtherChanges — everything else (grammar, short words, incidental)
 *
 * Columns per tab: timestamp, reviewerEmail, aiTerm, reviewerTerm, blockId, reviewSignal, sourceText, docUrl, translationJsonUrl, contentType
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
      d.reviewerEmail || "",
      d.aiTerm,
      d.reviewerTerm,
      d.blockId,
      d.reviewSignal,
      d.sourceText || "",
      looksLikeId(d.documentId) ? DOCS_URL_PREFIX + d.documentId : DOC_ID_NOT_AVAILABLE,
      looksLikeId(d.translationFileId) ? DRIVE_FILE_URL_PREFIX + d.translationFileId : TRANSLATION_FILE_ID_NOT_AVAILABLE,
      d.contentType || "",
    ];
    tabGroups[tab].push(row);
  }

  const tabsToWrite = Object.entries(tabGroups).filter(([, rows]) => rows.length);
  const results = await Promise.allSettled(
    tabsToWrite.map(([tab, rows]) =>
      sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: tab + COLUMN_RANGE,
        valueInputOption: "RAW",
        requestBody: { values: rows },
      })
    )
  );

  // Tabs are written independently, so one renamed or deleted tab doesn't
  // stop the others; report every tab that failed.
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
 * renamed or deleted).
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
        `Check that the ${[TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES].join(" / ")} tabs exist with these exact names.`,
      { failed_tabs: err.failedTabs || [] }
    );
    return "Failed to write to the refinement log: " + err.message;
  }
}

function looksLikeId(value) {
  return value && !value.includes(" ");
}

module.exports = { writeDecisions, recordDecisions };
