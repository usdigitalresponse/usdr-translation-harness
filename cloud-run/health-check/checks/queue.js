// Check: the Orchestrator's queue. Files it gave up on (extract-gave-up /
// pl-eval-gave-up rows) in the last 24 hours, and a backlog: files in the input
// folders that haven't been sent to Extract or Plain Language Eval yet.

const rules = require("../rules");
const { ok, problem } = require("../results");
const { valuesOf } = require("../settings");
const { describeAccessError } = require("./access-errors");
const { tabRange, readValues, headerMismatch, columnLetter } = require("./sheet-utils");
const { cellTime, SERIAL_DATES } = require("./sheets");

const CHECK = "Orchestrator queue";
const HOURS_TO_CHECK = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
// Backlog thresholds. The Orchestrator sends up to 10 files every 5 minutes, so
// a healthy queue clears within minutes.
const MAX_WAITING_FILES = 30;
const MAX_WAIT_MS = 1 * MS_PER_HOUR;
const PAGE_SIZE = 1000;

/** Processing Log rows as objects keyed by header, or null if the log can't be used
 * (the Processing Log check reports why). */
async function readProcessingLog(settings, clients) {
  const [entry] = valuesOf(settings, rules.PROCESSING_LOG_SHEET_ENV);
  if (!entry) return null;
  const lastColumn = columnLetter(rules.PROCESSING_LOG_HEADERS.length - 1);
  let rows;
  try {
    rows = await readValues(clients.sheets, entry.value,
      tabRange(rules.PROCESSING_LOG_TAB, `A:${lastColumn}`), SERIAL_DATES);
  } catch {
    return null;
  }
  const [header = [], ...data] = rows;
  if (headerMismatch(header, rules.PROCESSING_LOG_HEADERS)) return null;
  return data.map((row) => Object.fromEntries(rules.PROCESSING_LOG_HEADERS.map((h, i) => [h, row[i] ?? ""])));
}

/** One problem per file the Orchestrator gave up on in the last 24 hours, with
 * the last error that led to it. */
function gaveUpProblems(rows, now) {
  const since = now - HOURS_TO_CHECK * MS_PER_HOUR;
  const results = [];
  for (const row of rows) {
    const gaveUp = rules.GAVE_UP_STATUSES[row.status];
    if (!gaveUp || !(cellTime(row.processedAt) >= since)) continue;
    const lastFailure = rows.filter((r) => r.fileId === row.fileId && r.status === gaveUp.failedStatus).pop();
    const lastError = lastFailure && lastFailure.errorDetails ? ` Last error: ${lastFailure.errorDetails}` : "";
    results.push(problem(CHECK, `${row.fileName} (${gaveUp.service})`, "orchestrator_gave_up",
      `The Orchestrator stopped sending this file after 3 failed attempts.${lastError}`));
  }
  return results;
}

async function listInputFiles(drive, folderId) {
  const mimeTypes = rules.INPUT_MIME_TYPES.map((m) => `mimeType = '${m}'`).join(" or ");
  const files = [];
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (${mimeTypes})`,
      fields: "nextPageToken, files(id, name, createdTime)",
      pageSize: PAGE_SIZE,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

const hoursAgo = (ms) => `${Math.floor(ms / MS_PER_HOUR)} h ${Math.floor((ms % MS_PER_HOUR) / 60000)} min`;

/** Backlog: input-folder files not yet sent to (or given up on by) both services. */
async function backlogResults(rows, clients, inputFolders, now) {
  if (!inputFolders.length) {
    return [problem(CHECK, "input folders", "input_folders_not_set",
      `${rules.INPUT_FOLDER_ENVS[0]} isn't set on the health-check service, so the backlog isn't checked.`)];
  }
  const ids = (statuses) => new Set(rows.filter((r) => statuses.includes(r.status)).map((r) => r.fileId));
  const extractDone = ids(rules.EXTRACT_DONE_STATUSES);
  const plEvalDone = ids(rules.PL_EVAL_DONE_STATUSES);

  const results = [];
  const waiting = [];
  for (const { name, id } of inputFolders) {
    let files;
    try {
      files = await listInputFiles(clients.drive, id);
    } catch (err) {
      results.push(problem(CHECK, `input folder (${name})`, "input_folder_unreadable",
        describeAccessError(err, "folder", id)));
      continue;
    }
    waiting.push(...files.filter((f) => !extractDone.has(f.id) || !plEvalDone.has(f.id)));
  }

  if (waiting.length > MAX_WAITING_FILES) {
    results.push(problem(CHECK, "Backlog", "queue_backlog",
      `${waiting.length} files are waiting to be sent (more than ${MAX_WAITING_FILES}).`));
  }
  const oldest = waiting.reduce((a, f) => (!a || Date.parse(f.createdTime) < Date.parse(a.createdTime) ? f : a), null);
  const oldestWait = oldest ? now - Date.parse(oldest.createdTime) : 0;
  if (oldest && oldestWait > MAX_WAIT_MS) {
    results.push(problem(CHECK, "Backlog", "queue_stuck",
      `${waiting.length} file(s) waiting; the oldest, ${oldest.name}, was added ${hoursAgo(oldestWait)} ago ` +
      "(measured from when it was created in Drive)."));
  }
  if (!results.length) results.push(ok(CHECK, "Backlog", `${waiting.length} file(s) waiting`));
  return results;
}

async function checkQueue({ settings, clients, inputFolders = [], now = Date.now() }) {
  const rows = await readProcessingLog(settings, clients);
  if (!rows) return [];
  return [...gaveUpProblems(rows, now), ...await backlogResults(rows, clients, inputFolders, now)];
}

module.exports = { checkQueue, MAX_WAITING_FILES, MAX_WAIT_MS };
