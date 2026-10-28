const rules = require("../rules");
const { ok, problem } = require("../results");
const { valuesOf } = require("../settings");
const { tabRange, readValues, headerMismatch, missingColumns, normalize, columnLetter } = require("./sheet-utils");

const HEADER_ROW = "1:1";
const HOURS_TO_CHECK = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
// Sheets serial dates count days from 1899-12-30
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
// Read dates as serial numbers so Orchestrator-written dates (real Date cells)
// don't depend on the sheet's display format
const SERIAL_DATES = { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" };

/** Distinct values of a setting across services: [{value, services: [...]}] */
function distinctSettings(settings, envName) {
  const byValue = new Map();
  for (const { service, value } of valuesOf(settings, envName)) {
    byValue.set(value, [...(byValue.get(value) || []), service]);
  }
  return [...byValue.entries()].map(([value, services]) => ({ value, services }));
}

/** A cell as a time in ms: serial date number, or a date string. NaN if neither. */
function cellTime(cell) {
  if (typeof cell === "number") return SHEETS_EPOCH_MS + cell * MS_PER_DAY;
  return Date.parse(cell);
}

// ── Check 3: Glossary ─────────────────────────────────────────────────────

/**
 * Every glossary a service is configured with (sheet + tab). A list, so
 * per-department glossaries are checked without code changes.
 */
function glossariesToCheck(settings) {
  return valuesOf(settings, rules.GLOSSARY_SHEET_ENV).map(({ service, value }) => ({
    service,
    sheetId: value,
    tab: settings[service].env[rules.GLOSSARY_TAB_ENV] || rules.DEFAULT_GLOSSARY_SHEET_TAB,
  }));
}

async function checkGlossary({ settings, clients }) {
  const CHECK = "Glossary";
  const results = [];
  for (const { service, sheetId, tab } of glossariesToCheck(settings)) {
    const resource = `'${tab}' tab (${service})`;
    let rows;
    try {
      rows = await readValues(clients.sheets, sheetId, tabRange(tab, rules.GLOSSARY_SHEET_COLUMNS));
    } catch (err) {
      results.push(problem(CHECK, resource, "glossary_unreadable", `Can't read sheet ${sheetId}: ${err.message}`));
      continue;
    }
    const [header = [], ...data] = rows;
    const missing = missingColumns(header, rules.GLOSSARY_REQUIRED_COLUMNS);
    if (missing.length) {
      results.push(problem(CHECK, resource, "glossary_missing_columns", `Missing column(s): ${missing.join(", ")}.`));
      continue;
    }
    const termCol = header.map(normalize).indexOf(rules.GLOSSARY_ENGLISH_TERM);
    const entries = data.filter((row) => String(row[termCol] ?? "").trim()).length;
    results.push(entries
      ? ok(CHECK, resource, `${entries} entries`)
      : problem(CHECK, resource, "glossary_empty", "No rows with an English Term."));
  }
  return results;
}

// ── Check 4: Model Config ─────────────────────────────────────────────────

async function checkModelConfig({ settings, clients }) {
  const CHECK = "Model Config";
  const results = [];
  for (const { value: sheetId, services } of distinctSettings(settings, rules.MODEL_CONFIG_SHEET_ENV)) {
    const resource = "Config tab";
    let rows;
    try {
      rows = await readValues(clients.sheets, sheetId, rules.MODEL_CONFIG_SHEET_RANGE);
    } catch (err) {
      results.push(problem(CHECK, resource, "model_config_unreadable", `Can't read sheet ${sheetId}: ${err.message}`));
      continue;
    }
    const [header = [], ...data] = rows;
    const missing = missingColumns(header, rules.MODEL_CONFIG_REQUIRED_COLUMNS);
    if (missing.length) {
      results.push(problem(CHECK, resource, "model_config_missing_columns", `Missing column(s): ${missing.join(", ")}.`));
      continue;
    }
    const col = Object.fromEntries(header.map((h, i) => [normalize(h), i]));
    for (const service of services) {
      const role = rules.SERVICE_ROLES[service];
      if (!role) continue;
      const active = data.filter((row) =>
        // Exact match, as the services compare roles (only whitespace is trimmed)
        String(row[col.role] ?? "").trim() === role &&
        String(row[col.active] ?? "").trim().toUpperCase() === rules.MODEL_CONFIG_ACTIVE_YES);
      results.push(active.length
        ? ok(CHECK, `role '${role}'`, active.map((r) => `${r[col.provider]}/${r[col.model]}`).join(", "))
        : problem(CHECK, `role '${role}'`, "model_config_no_active_model", `No row with active = YES (used by ${service}).`));
    }
  }
  return results;
}

// ── Check 5: Processing Log ───────────────────────────────────────────────

async function checkProcessingLog({ settings, clients, now = Date.now() }) {
  const CHECK = "Processing Log";
  const results = [];
  const lastColumn = columnLetter(rules.PROCESSING_LOG_HEADERS.length - 1);
  for (const { value: sheetId } of distinctSettings(settings, rules.PROCESSING_LOG_SHEET_ENV)) {
    const resource = `${rules.PROCESSING_LOG_TAB} tab`;
    let rows;
    try {
      rows = await readValues(clients.sheets, sheetId, tabRange(rules.PROCESSING_LOG_TAB, `A:${lastColumn}`), SERIAL_DATES);
    } catch (err) {
      results.push(problem(CHECK, resource, "processing_log_unreadable", `Can't read sheet ${sheetId}: ${err.message}`));
      continue;
    }
    const [header = [], ...data] = rows;
    const mismatch = headerMismatch(header, rules.PROCESSING_LOG_HEADERS);
    if (mismatch) {
      results.push(problem(CHECK, resource, "processing_log_headers", `Row 1 doesn't match: ${mismatch}.`));
      continue;
    }

    const col = Object.fromEntries(rules.PROCESSING_LOG_HEADERS.map((h, i) => [h, i]));
    const since = now - HOURS_TO_CHECK * MS_PER_HOUR;
    const recent = data.filter((row) =>
      rules.ORCHESTRATOR_STATUSES.includes(String(row[col.status] ?? "")) && cellTime(row[col.processedAt]) >= since);
    const blank = recent.filter((row) => !String(row[col.submittedBy] ?? "").trim());
    if (blank.length) {
      const names = [...new Set(blank.map((row) => row[col.fileName]))].join(", ");
      results.push(problem(CHECK, `${resource}, Submitted By`, "processing_log_blank_submitter",
        `${blank.length} of ${recent.length} rows in the last ${HOURS_TO_CHECK} hours have no Submitted By (${names}).`));
    } else {
      results.push(ok(CHECK, resource, `${recent.length} files submitted in the last ${HOURS_TO_CHECK} hours`));
    }
  }
  return results;
}

// ── Check 6: Refinement log ───────────────────────────────────────────────

async function checkRefinementLog({ settings, clients }) {
  const CHECK = "Refinement log";
  const results = [];
  for (const { value: sheetId } of distinctSettings(settings, rules.REFINEMENT_LOG_SHEET_ENV)) {
    for (const tab of rules.REFINEMENT_LOG_TABS) {
      const resource = `${tab} tab`;
      let rows;
      try {
        rows = await readValues(clients.sheets, sheetId, tabRange(tab, HEADER_ROW));
      } catch (err) {
        results.push(problem(CHECK, resource, "refinement_log_unreadable", `Can't read sheet ${sheetId}: ${err.message}`));
        continue;
      }
      const mismatch = headerMismatch(rows[0], rules.REFINEMENT_LOG_HEADERS);
      results.push(mismatch
        ? problem(CHECK, resource, "refinement_log_headers", `Row 1 doesn't match: ${mismatch}.`)
        : ok(CHECK, resource));
    }
  }
  return results;
}

module.exports = {
  checkGlossary,
  checkModelConfig,
  checkProcessingLog,
  checkRefinementLog,
  glossariesToCheck,
  cellTime,
};
