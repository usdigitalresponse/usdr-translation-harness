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
};

var EXTRACT_STATUSES = [STATUS.TRIGGERED, STATUS.COMPLETE, STATUS.EXTRACTED];
var PL_EVAL_STATUSES = [STATUS.PL_EVAL_TRIGGERED, STATUS.PL_EVAL_COMPLETE];

var COL = {
  FILE_ID: 0,
  FILE_NAME: 1,
  PROCESSED_AT: 2,
  STATUS: 3,
  DURATION_MS: 4,
  ERROR_DETAIL: 5,
  EXTRACTION_FILE_ID: 6,
  PROVIDER: 7,
  MODEL: 8,
};

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

function getProcessedFileIds(sheetId) {
  var sheet = getProcessingLogSheet(sheetId);
  var data = sheet.getDataRange().getValues();
  var rows = data.slice(HEADER_ROWS);

  var extract = new Set(
    rows
      .filter(function (row) { return EXTRACT_STATUSES.indexOf(row[COL.STATUS]) !== -1; })
      .map(function (row) { return row[COL.FILE_ID]; })
  );
  var plEval = new Set(
    rows
      .filter(function (row) { return PL_EVAL_STATUSES.indexOf(row[COL.STATUS]) !== -1; })
      .map(function (row) { return row[COL.FILE_ID]; })
  );

  return { extract: extract, plEval: plEval };
}

function logProcessingResult(sheetId, file, result, successStatus, failedStatus) {
  var sheet = getProcessingLogSheet(sheetId);
  sheet.appendRow([
    file.getId(),
    file.getName(),
    new Date(),
    result.success ? successStatus : failedStatus,
    result.durationMs,
    result.error || "",
  ]);
}

function callCloudRunFunction(file, url, label, contentType) {
  var token = ScriptApp.getIdentityToken();

  var payload = {
    fileId: file.getId(),
    fileName: file.getName(),
    mimeType: file.getMimeType(),
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

function processFolder(folderConfig, config, processed) {
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
    var fid = file.getId();

    if (!processed.extract.has(fid)) {
      var extractStart = Date.now();
      try {
        var extractResult = callCloudRunFunction(file, config.EXTRACT_URL, "Extract", folderConfig.contentType);
        extractResult.durationMs = Date.now() - extractStart;
        logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, extractResult, STATUS.TRIGGERED, STATUS.FAILED);
      } catch (e) {
        Logger.log("Unexpected error calling Extract for %s: %s", file.getName(), e.message);
        logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, {
          success: false,
          durationMs: Date.now() - extractStart,
          error: e.message,
        }, STATUS.TRIGGERED, STATUS.FAILED);
      }
    }

    if (!processed.plEval.has(fid)) {
      var evalStart = Date.now();
      try {
        var evalResult = callCloudRunFunction(file, config.PLAIN_LANGUAGE_EVAL_URL, "Plain Language Eval", folderConfig.contentType);
        evalResult.durationMs = Date.now() - evalStart;
        logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, evalResult, STATUS.PL_EVAL_TRIGGERED, STATUS.PL_EVAL_FAILED);
      } catch (e) {
        Logger.log("Unexpected error calling Plain Language Eval for %s: %s", file.getName(), e.message);
        logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, {
          success: false,
          durationMs: Date.now() - evalStart,
          error: e.message,
        }, STATUS.PL_EVAL_TRIGGERED, STATUS.PL_EVAL_FAILED);
      }
    }
  }
}

function watchForNewFiles() {
  var config;
  try {
    config = getConfig();
  } catch (e) {
    Logger.log("Configuration error: %s", e.message);
    return;
  }

  var processed;
  try {
    processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    Logger.log("Cannot read processing log sheet %s: %s", config.PROCESSING_LOG_SHEET_ID, e.message);
    return;
  }

  for (var i = 0; i < INPUT_FOLDERS.length; i++) {
    processFolder(INPUT_FOLDERS[i], config, processed);
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
