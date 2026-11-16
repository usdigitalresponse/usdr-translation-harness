var HTTP_ACCEPTED = 202;
var POLL_INTERVAL_MINUTES = 5;
var HEADER_ROWS = 1;

var DEFAULT_CONTENT_TYPE = "public_flyer";

var SUPPORTED_MIME_TYPES = [
  MimeType.PDF,
  MimeType.GOOGLE_DOCS,
  MimeType.MICROSOFT_WORD,
];

var STATUS = {
  TRIGGERED: "triggered",
  COMPLETE: "complete",
  EXTRACTED: "extracted",
  FAILED: "failed",
  PL_EVAL_TRIGGERED: "pl-eval-triggered",
  PL_EVAL_COMPLETE: "pl-eval-complete",
  PL_EVAL_FAILED: "pl-eval-failed",
  EXTRACT_GAVE_UP: "extract-gave-up",
  PL_EVAL_GAVE_UP: "pl-eval-gave-up",
};

// Statuses that mean a file is done for that service (never sent again)
var EXTRACT_STATUSES = [STATUS.TRIGGERED, STATUS.COMPLETE, STATUS.EXTRACTED, STATUS.EXTRACT_GAVE_UP];
var PL_EVAL_STATUSES = [STATUS.PL_EVAL_TRIGGERED, STATUS.PL_EVAL_COMPLETE, STATUS.PL_EVAL_GAVE_UP];

// A file whose Extract or Plain Language Eval call keeps failing is given up
// on after this many failed rows, instead of being re-sent every 5 minutes
// forever. A non-202 means the service didn't start (no model call), but a
// call can also start the service and then error in UrlFetch, and that
// resend is billed.
var MAX_ATTEMPTS = 3;
// Files sent per run, across both folders; the rest wait for the next run.
// Keeps a bulk drop from triggering everything at once and keeps the run well
// inside Apps Script's 6-minute limit.
var MAX_FILES_PER_RUN = 10;

// The services the watcher sends each new file to
var SERVICES = [
  {
    label: "Extract", urlConfigKey: "EXTRACT_URL", processedKey: "extract", failuresKey: "extractFailures",
    successStatus: STATUS.TRIGGERED, failedStatus: STATUS.FAILED, gaveUpStatus: STATUS.EXTRACT_GAVE_UP,
  },
  {
    label: "Plain Language Eval", urlConfigKey: "PLAIN_LANGUAGE_EVAL_URL", processedKey: "plEval",
    failuresKey: "plEvalFailures",
    successStatus: STATUS.PL_EVAL_TRIGGERED, failedStatus: STATUS.PL_EVAL_FAILED, gaveUpStatus: STATUS.PL_EVAL_GAVE_UP,
  },
];

var COL = {
  FILE_ID: 0,
  FILE_NAME: 1,
  PROCESSED_AT: 2,
  STATUS: 3,
  DURATION_MS: 4,
  ERROR_DETAIL: 5,
  OUTPUT_JSON_ID: 6,
  PROVIDER: 7,
  MODEL: 8,
  SUBMITTED_BY: 9,
  OUTPUT_DOC_URL: 10,
  OUTPUT_DOC_ID: 11,
};

// Row 1 of the ProcessingLog tab, in column order. Every writer (this script,
// Extract, Translate, Plain Language Eval) writes by position, so a renamed,
// inserted, or moved column silently scrambles rows; checkProcessingLogHeaders
// stops the poll instead. Compared case-insensitively; extra columns after
// these are allowed.
var PROCESSING_LOG_HEADERS = [
  "fileId", "fileName", "processedAt", "status", "durationMs", "errorDetails",
  "outputJsonId", "provider", "model", "submittedBy", "outputDocUrl", "outputDocId",
];

var CONTENT_TYPE_TWO = "content_type_two";

var REQUIRED_CONFIG_KEYS = [
  "EXTRACT_FUNCTION_URL",
  "PLAIN_LANGUAGE_EVAL_FUNCTION_URL",
  "PROCESSING_LOG_SHEET_ID",
];

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  var missing = REQUIRED_CONFIG_KEYS.filter(function (key) {
    return !props.getProperty(key);
  });
  if (missing.length > 0) {
    throw new Error("Missing required script properties: " + missing.join(", "));
  }

  return {
    EXTRACT_URL: props.getProperty("EXTRACT_FUNCTION_URL"),
    PLAIN_LANGUAGE_EVAL_URL: props.getProperty("PLAIN_LANGUAGE_EVAL_FUNCTION_URL"),
    PROCESSING_LOG_SHEET_ID: props.getProperty("PROCESSING_LOG_SHEET_ID"),
  };
}

function getProcessingLogSheet(sheetId) {
  return SpreadsheetApp.openById(sheetId).getSheetByName("ProcessingLog");
}

/**
 * Check the Processing Log's header row against PROCESSING_LOG_HEADERS.
 *
 * @param {Array} headerRow - Row 1 of the ProcessingLog tab
 * @returns {string|null} A description of the mismatch, or null if it matches
 */
function checkProcessingLogHeaders(headerRow) {
  var found = (headerRow || []).map(function (h) { return String(h).trim(); });
  var mismatches = PROCESSING_LOG_HEADERS.filter(function (expected, i) {
    return (found[i] || "").toLowerCase() !== expected.toLowerCase();
  });
  if (!mismatches.length) return null;
  return "ProcessingLog header row doesn't match. Expected: " + PROCESSING_LOG_HEADERS.join(", ") +
    ". Found: " + found.slice(0, PROCESSING_LOG_HEADERS.length).join(", ") + ".";
}

/**
 * Read the Processing Log and return the file IDs already sent to Extract and
 * to Plain Language Eval.
 *
 * @throws if the header row isn't PROCESSING_LOG_HEADERS: matching rows by
 *   column position against the wrong layout could re-send every input file
 */
function getProcessedFileIds(sheetId) {
  var sheet = getProcessingLogSheet(sheetId);
  var data = sheet.getDataRange().getValues();

  var headerProblem = checkProcessingLogHeaders(data[0]);
  if (headerProblem) {
    throw new Error(headerProblem);
  }

  var rows = data.slice(HEADER_ROWS);
  var withStatus = function (statuses) {
    return rows.filter(function (row) { return statuses.indexOf(row[COL.STATUS]) !== -1; });
  };
  var ids = function (statuses) {
    return new Set(withStatus(statuses).map(function (row) { return row[COL.FILE_ID]; }));
  };
  // Failed rows per file (from any writer: a service's own failures count too)
  var counts = function (status) {
    var byFile = new Map();
    withStatus([status]).forEach(function (row) {
      byFile.set(row[COL.FILE_ID], (byFile.get(row[COL.FILE_ID]) || 0) + 1);
    });
    return byFile;
  };

  return {
    extract: ids(EXTRACT_STATUSES),
    plEval: ids(PL_EVAL_STATUSES),
    extractFailures: counts(STATUS.FAILED),
    plEvalFailures: counts(STATUS.PL_EVAL_FAILED),
  };
}

function logProcessingResult(sheetId, file, result, successStatus, failedStatus) {
  var sheet = getProcessingLogSheet(sheetId);
  // outputJsonId, provider, model, outputDocUrl and outputDocId stay blank: those are written by the Cloud Run functions
  var row = new Array(PROCESSING_LOG_HEADERS.length).fill("");
  row[COL.FILE_ID] = file.getId();
  row[COL.FILE_NAME] = file.getName();
  row[COL.PROCESSED_AT] = new Date();
  row[COL.STATUS] = result.success ? successStatus : failedStatus;
  row[COL.DURATION_MS] = result.durationMs;
  row[COL.ERROR_DETAIL] = result.error || "";
  row[COL.SUBMITTED_BY] = result.submittedByEmail || "";
  sheet.appendRow(row);
}

function callCloudRunFunction(file, url, label, contentType) {
  var token = ScriptApp.getIdentityToken();

  var submittedByEmail = "";
  // Read here rather than in Cloud Run: the service account only sees the email prefix as displayName
  var submittedByName = "";
  try {
    // supportsAllDrives: without it, files on a Shared Drive come back "File not found"
    var meta = Drive.Files.get(file.getId(), { fields: "lastModifyingUser", supportsAllDrives: true });
    if (meta.lastModifyingUser) {
      submittedByEmail = meta.lastModifyingUser.emailAddress || "";
      submittedByName = meta.lastModifyingUser.displayName || "";
    }
  } catch (e) {
    // console.error (not Logger.log) so it shows as an error in Executions and Cloud Logging;
    // the file is still processed, just with a blank Submitted By
    console.error("Could not get lastModifyingUser for " + file.getName() + ": " + e.message);
  }

  var payload = {
    fileId: file.getId(),
    fileName: file.getName(),
    mimeType: file.getMimeType(),
    submittedByEmail: submittedByEmail,
    submittedByName: submittedByName,
  };
  if (contentType) {
    payload.contentType = contentType;
  }

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  var success = code === HTTP_ACCEPTED;

  Logger.log(
    "%s %s for %s (HTTP %s): %s",
    label,
    success ? "triggered" : "failed",
    file.getName(),
    code,
    body
  );

  return {
    success: success,
    error: success ? "" : "HTTP " + code + ": " + body.substring(0, 200),
    submittedByEmail: submittedByEmail,
  };
}

function getInputFiles(folder) {
  var allFiles = [];
  for (var i = 0; i < SUPPORTED_MIME_TYPES.length; i++) {
    var files = folder.getFilesByType(SUPPORTED_MIME_TYPES[i]);
    while (files.hasNext()) {
      allFiles.push(files.next());
    }
  }
  return allFiles;
}

var INPUT_FOLDERS = [
  { propertyKey: "INPUT_FOLDER_ID", contentType: DEFAULT_CONTENT_TYPE },
  { propertyKey: "INPUT_FOLDER_ID_CONTENT_TYPE_TWO", contentType: CONTENT_TYPE_TWO },
];

/**
 * Send each new file in one input folder to Extract and Plain Language Eval,
 * while the run's file budget lasts.
 *
 * @param {{propertyKey: string, contentType: string}} folderConfig - One of INPUT_FOLDERS
 * @param {Object} config - From getConfig
 * @param {Object} processed - From getProcessedFileIds
 * @param {{remaining: number, waiting: number}} budget - Files this run may still send
 *   (shared across folders); files over it are counted in waiting
 */
function processFolder(folderConfig, config, processed, budget) {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(folderConfig.propertyKey);
  if (!folderId) {
    Logger.log("No %s set — skipping", folderConfig.propertyKey);
    return;
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    Logger.log("Cannot access folder %s (%s): %s", folderConfig.propertyKey, folderId, e.message);
    return;
  }

  var allFiles = getInputFiles(folder);

  for (var i = 0; i < allFiles.length; i++) {
    var file = allFiles[i];
    var pending = SERVICES.filter(function (service) {
      return !processed[service.processedKey].has(file.getId());
    });
    if (!pending.length) continue;
    if (budget.remaining <= 0) {
      budget.waiting++;
      continue;
    }
    budget.remaining--;
    for (var j = 0; j < pending.length; j++) {
      sendToService_(pending[j], file, config, folderConfig.contentType, processed);
    }
  }
}

/**
 * Send one file to one service (Extract or Plain Language Eval) and log the
 * result. After MAX_ATTEMPTS failed rows for that service, appends a gave-up
 * row instead (which marks the file done for that service).
 *
 * @param {Object} service - One of SERVICES
 * @param {File} file
 * @param {Object} config - From getConfig
 * @param {string} contentType
 * @param {Object} processed - From getProcessedFileIds
 */
function sendToService_(service, file, config, contentType, processed) {
  var attempts = processed[service.failuresKey].get(file.getId()) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    var message = "Gave up after " + attempts + " failed attempts to start " + service.label +
      "; see the earlier failed rows. To retry, upload the file again (a new copy gets a new file ID).";
    // console.error so it shows as an error in Executions and Cloud Logging
    console.error(service.label + ": " + message + " (" + file.getName() + ")");
    logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file,
      { success: false, durationMs: "", error: message }, service.successStatus, service.gaveUpStatus);
    return;
  }

  var start = Date.now();
  var result;
  try {
    result = callCloudRunFunction(file, config[service.urlConfigKey], service.label, contentType);
  } catch (e) {
    Logger.log("Unexpected error calling %s for %s: %s", service.label, file.getName(), e.message);
    result = { success: false, error: e.message };
  }
  result.durationMs = Date.now() - start;
  logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, result, service.successStatus, service.failedStatus);
}

// How long a run waits for the previous one to finish before skipping
var RUN_LOCK_WAIT_MS = 1000;

/**
 * Time-trigger entry point. Runs are serialized with a script lock: two
 * overlapping runs would both see a file as new and send it twice (two billed
 * extractions). A run that can't get the lock skips; the next one picks up.
 *
 * The script lock is one lock for the whole project. Only this function should
 * take it: if another function (archive, drift) did, its long runs would make
 * the watcher skip.
 */
function watchForNewFiles() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(RUN_LOCK_WAIT_MS)) {
    // console.error so repeated skips stand out in Executions and Cloud
    // Logging (the run still shows as Completed). Normal runs take seconds, so
    // this should be rare; if it keeps happening, runs are overlapping.
    console.error("Previous watchForNewFiles run still in progress; skipping this one");
    return;
  }
  try {
    watchForNewFilesLocked_();
  } finally {
    lock.releaseLock();
  }
}

function watchForNewFilesLocked_() {
  var config;
  try {
    config = getConfig();
  } catch (e) {
    // Rethrow, like the processing log check below: a missing script property
    // stops every run, so it must show as Failed in Executions (and email the
    // trigger owner) rather than look like a quiet, successful poll
    console.error("Configuration error: " + e.message);
    throw e;
  }

  var processed;
  try {
    processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    // Rethrow so the run shows as Failed in Executions (and the trigger owner
    // gets Google's failure notification) instead of quietly skipping
    console.error("Cannot use processing log sheet " + config.PROCESSING_LOG_SHEET_ID + ": " + e.message);
    throw e;
  }

  var budget = { remaining: MAX_FILES_PER_RUN, waiting: 0 };
  for (var i = 0; i < INPUT_FOLDERS.length; i++) {
    processFolder(INPUT_FOLDERS[i], config, processed, budget);
  }
  if (budget.waiting) {
    Logger.log("%s file(s) waiting for the next run (at most %s per run)", budget.waiting, MAX_FILES_PER_RUN);
  }
}

function createTimeTrigger() {
  ScriptApp.newTrigger("watchForNewFiles")
    .timeBased()
    .everyMinutes(POLL_INTERVAL_MINUTES)
    .create();
}

// -----------------------------------------------------------------------------
// Model-change detection → drift eval
//
// An installable onEdit trigger on the model-config sheet fires the drift eval
// whenever an edit changes the active model(s) it depends on. The signature +
// stored-value comparison dedupes: unrelated edits and multi-cell edits that
// don't change the active set are ignored. See createConfigTrigger for setup.
// -----------------------------------------------------------------------------

var MODEL_CONFIG_SHEET_NAME = "Config";
var ACTIVE_YES = "YES";
// Roles whose active model the drift eval actually exercises (translation
// candidate + reference-aware judge). Changes to other roles don't affect drift.
var DRIFT_RELEVANT_ROLES = ["translate", "eval"];
var LAST_ACTIVE_MODEL_SIGNATURE_KEY = "LAST_ACTIVE_MODEL_SIGNATURE";
// Hour (0–23, script timezone) for the weekly scheduled drift run.
var DRIFT_WEEKLY_HOUR = 9;

function activeModelSignature_(sheetId) {
  var sheet = SpreadsheetApp.openById(sheetId).getSheetByName(MODEL_CONFIG_SHEET_NAME);
  if (!sheet) {
    throw new Error("No '" + MODEL_CONFIG_SHEET_NAME + "' tab in config sheet " + sheetId);
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= HEADER_ROWS) {
    return "";
  }

  var headers = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var roleCol = headers.indexOf("role");
  var providerCol = headers.indexOf("provider");
  var modelCol = headers.indexOf("model");
  var activeCol = headers.indexOf("active");
  if (roleCol === -1 || providerCol === -1 || modelCol === -1 || activeCol === -1) {
    throw new Error("Config tab is missing role/provider/model/active columns");
  }

  var entries = [];
  for (var i = HEADER_ROWS; i < data.length; i++) {
    var row = data[i];
    var role = String(row[roleCol]).trim().toLowerCase();
    var isActive = String(row[activeCol]).trim().toUpperCase() === ACTIVE_YES;
    if (isActive && DRIFT_RELEVANT_ROLES.indexOf(role) !== -1) {
      entries.push(
        role + ":" +
        String(row[providerCol]).trim().toLowerCase() + ":" +
        String(row[modelCol]).trim()
      );
    }
  }
  entries.sort();
  return entries.join("|");
}

function callDriftEval_(url, trigger) {
  var token = ScriptApp.getIdentityToken();
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ trigger: trigger }),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  // Drift is fire-and-forget: it acks with 202 and runs in the background.
  var success = code === HTTP_ACCEPTED;

  Logger.log("Drift eval %s (HTTP %s): %s", success ? "triggered" : "failed", code, body.substring(0, 200));
  return {
    success: success,
    code: code,
    error: success ? "" : "HTTP " + code + ": " + body.substring(0, 200),
  };
}

function onConfigEdit(e) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("MODEL_CONFIG_SHEET_ID");
  var driftUrl = props.getProperty("EVAL_DRIFT_FUNCTION_URL");
  if (!sheetId || !driftUrl) {
    Logger.log("onConfigEdit: MODEL_CONFIG_SHEET_ID or EVAL_DRIFT_FUNCTION_URL not set — skipping");
    return;
  }

  var signature;
  try {
    signature = activeModelSignature_(sheetId);
  } catch (err) {
    Logger.log("onConfigEdit: cannot read model config: %s", err.message);
    return;
  }

  if (signature === props.getProperty(LAST_ACTIVE_MODEL_SIGNATURE_KEY)) {
    return; // active model set unchanged — ignore this edit
  }

  var result = callDriftEval_(driftUrl, "model_change");
  if (result.success) {
    // Record the new signature only once the run is accepted, so a transient
    // failure retries on the next edit rather than being silently dropped.
    props.setProperty(LAST_ACTIVE_MODEL_SIGNATURE_KEY, signature);
    Logger.log("Model config changed — drift eval triggered. New signature: %s", signature);
  } else {
    Logger.log("Model config changed but drift trigger failed: %s", result.error);
  }
}

function createConfigTrigger() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("MODEL_CONFIG_SHEET_ID");
  if (!sheetId) {
    throw new Error("Set the MODEL_CONFIG_SHEET_ID script property before creating the config trigger");
  }

  // Avoid stacking duplicates if this is run more than once.
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === "onConfigEdit") {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger("onConfigEdit")
    .forSpreadsheet(sheetId)
    .onEdit()
    .create();

  // Seed the baseline signature so the first genuine change is detected, rather
  // than the next edit triggering a spurious run against an empty baseline.
  try {
    props.setProperty(LAST_ACTIVE_MODEL_SIGNATURE_KEY, activeModelSignature_(sheetId));
  } catch (err) {
    Logger.log("Could not seed model signature baseline: %s", err.message);
  }

  Logger.log("Installed onConfigEdit trigger on config sheet %s", sheetId);
}

// -----------------------------------------------------------------------------
// Weekly cadence → drift eval
//
// A weekly time trigger fires runWeeklyDrift, which POSTs the drift eval the
// same way onConfigEdit does. This is the scheduled counterpart to the
// model-change trigger and the backstop for config changes made outside the
// Sheet UI (which an installable onEdit can't see). See createDriftWeeklyTrigger.
// -----------------------------------------------------------------------------

function runWeeklyDrift() {
  var url = PropertiesService.getScriptProperties().getProperty("EVAL_DRIFT_FUNCTION_URL");
  if (!url) {
    Logger.log("runWeeklyDrift: EVAL_DRIFT_FUNCTION_URL not set — skipping");
    return;
  }
  callDriftEval_(url, "weekly");
}

function createDriftWeeklyTrigger() {
  // Avoid stacking duplicates if this is run more than once.
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === "runWeeklyDrift") {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger("runWeeklyDrift")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(DRIFT_WEEKLY_HOUR)
    .create();

  Logger.log("Installed weekly drift trigger (Mondays ~%s:00)", DRIFT_WEEKLY_HOUR);
}

// -----------------------------------------------------------------------------
// Archive utility
//
// Moves files untouched for 24+ hours from a source folder to an archive
// folder. Folder pairs are stored in a ARCHIVE_CONFIGS script property as JSON.
//
// Setup:  run setupArchiveFolder("sourceId", "archiveId", "my-label") once per
//         folder pair from the Script Editor. It stores the config and installs
//         a daily 6 PM trigger (idempotent — safe to re-run).
// Remove: run removeArchiveFolder("my-label") to drop a pair.
// Manual: run runArchive() to archive immediately without waiting for trigger.
// -----------------------------------------------------------------------------

var ARCHIVE_CONFIGS_KEY = "ARCHIVE_CONFIGS";
var ARCHIVE_TRIGGER_HANDLER = "runArchive";
var ARCHIVE_HOUR = 18; // 6 PM in script timezone (America/New_York)
var STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function getArchiveConfigs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ARCHIVE_CONFIGS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveArchiveConfigs_(configs) {
  PropertiesService.getScriptProperties().setProperty(ARCHIVE_CONFIGS_KEY, JSON.stringify(configs));
}

function setupArchiveFolder(sourceFolderId, archiveFolderId, label) {
  if (!sourceFolderId || !archiveFolderId || !label) {
    throw new Error("All three arguments required: sourceFolderId, archiveFolderId, label");
  }

  // Validate folder access before saving.
  try {
    DriveApp.getFolderById(sourceFolderId);
  } catch (e) {
    throw new Error("Cannot access source folder " + sourceFolderId + ": " + e.message);
  }
  try {
    DriveApp.getFolderById(archiveFolderId);
  } catch (e) {
    throw new Error("Cannot access archive folder " + archiveFolderId + ": " + e.message);
  }

  var configs = getArchiveConfigs_();
  var existing = configs.findIndex(function (c) { return c.label === label; });
  var entry = {
    sourceFolderId: sourceFolderId,
    archiveFolderId: archiveFolderId,
    label: label,
  };

  if (existing !== -1) {
    configs[existing] = entry;
    Logger.log("Updated archive config '%s'", label);
  } else {
    configs.push(entry);
    Logger.log("Added archive config '%s'", label);
  }
  saveArchiveConfigs_(configs);

  // Ensure exactly one daily trigger exists.
  var triggers = ScriptApp.getProjectTriggers();
  var hasArchiveTrigger = triggers.some(function (t) {
    return t.getHandlerFunction() === ARCHIVE_TRIGGER_HANDLER;
  });
  if (!hasArchiveTrigger) {
    ScriptApp.newTrigger(ARCHIVE_TRIGGER_HANDLER)
      .timeBased()
      .atHour(ARCHIVE_HOUR)
      .everyDays(1)
      .create();
    Logger.log("Installed daily archive trigger at ~%s:00", ARCHIVE_HOUR);
  }

  Logger.log(
    "Archive config ready: '%s' — source %s → archive %s",
    label, sourceFolderId, archiveFolderId
  );
}

function removeArchiveFolder(label) {
  var configs = getArchiveConfigs_();
  var filtered = configs.filter(function (c) { return c.label !== label; });
  if (filtered.length === configs.length) {
    Logger.log("No archive config found with label '%s'", label);
    return;
  }

  saveArchiveConfigs_(filtered);
  Logger.log("Removed archive config '%s'", label);

  // If no configs remain, remove the trigger too.
  if (filtered.length === 0) {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === ARCHIVE_TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(triggers[i]);
        Logger.log("Removed archive trigger (no configs remain)");
      }
    }
  }
}

function runArchive() {
  var configs = getArchiveConfigs_();
  if (configs.length === 0) {
    Logger.log("No archive folder configs — nothing to do");
    return;
  }

  var cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  for (var i = 0; i < configs.length; i++) {
    var cfg = configs[i];
    try {
      archiveFolder_(cfg.sourceFolderId, cfg.archiveFolderId, cfg.label, cutoff);
    } catch (e) {
      Logger.log("Archive error for '%s': %s", cfg.label, e.message);
    }
  }
}

function archiveFolder_(sourceFolderId, archiveFolderId, label, cutoff) {
  var files = DriveApp.getFolderById(sourceFolderId).getFiles();
  var moved = 0;

  while (files.hasNext()) {
    var file = files.next();
    if (file.getDateCreated() > cutoff) {
      continue;
    }

    // Use Advanced Drive service for the move — reliable on Shared Drives.
    Drive.Files.update(
      {},
      file.getId(),
      null,
      {
        addParents: archiveFolderId,
        removeParents: sourceFolderId,
        supportsAllDrives: true,
      }
    );
    moved++;
  }

  Logger.log("Archive '%s': moved %s file(s)", label, moved);
}
