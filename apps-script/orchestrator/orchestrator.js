// Watches a Drive input folder for new PDFs and triggers the Extract Cloud Run function.
// The extract function is fire-and-forget: it returns 202 immediately and processes in the background.
// Processing history is logged to a Google Sheet for auditability.

var HTTP_ACCEPTED = 202;
var POLL_INTERVAL_MINUTES = 5;
var HEADER_ROWS = 1;

var STATUS = {
  TRIGGERED: "triggered",
  FAILED: "failed",
};

var COL = {
  FILE_ID: 0,
  FILE_NAME: 1,
  PROCESSED_AT: 2,
  STATUS: 3,
  DURATION_MS: 4,
  ERROR_DETAIL: 5,
};

var REQUIRED_CONFIG_KEYS = ["INPUT_FOLDER_ID", "EXTRACT_FUNCTION_URL", "PROCESSING_LOG_SHEET_ID"];

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  var missing = REQUIRED_CONFIG_KEYS.filter(function (key) {
    return !props.getProperty(key);
  });
  if (missing.length > 0) {
    throw new Error("Missing required script properties: " + missing.join(", "));
  }

  return {
    INPUT_FOLDER_ID: props.getProperty("INPUT_FOLDER_ID"),
    EXTRACT_URL: props.getProperty("EXTRACT_FUNCTION_URL"),
    PROCESSING_LOG_SHEET_ID: props.getProperty("PROCESSING_LOG_SHEET_ID"),
  };
}

function getProcessingLogSheet(sheetId) {
  return SpreadsheetApp.openById(sheetId).getSheetByName("ProcessingLog");
}

function getProcessedFileIds(sheetId) {
  var sheet = getProcessingLogSheet(sheetId);
  var data = sheet.getDataRange().getValues();
  return new Set(
    data.slice(HEADER_ROWS)
      .filter(function (row) { return row[COL.STATUS] === STATUS.TRIGGERED; })
      .map(function (row) { return row[COL.FILE_ID]; })
  );
}

function logProcessingResult(sheetId, file, result) {
  var sheet = getProcessingLogSheet(sheetId);
  sheet.appendRow([
    file.getId(),
    file.getName(),
    new Date(),
    result.success ? STATUS.TRIGGERED : STATUS.FAILED,
    result.durationMs,
    result.error || "",
  ]);
}

function callExtractFunction(file, extractUrl) {
  var token = ScriptApp.getIdentityToken();

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      fileId: file.getId(),
      fileName: file.getName(),
    }),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(extractUrl, options);
  var code = response.getResponseCode();
  var body = response.getContentText();
  var success = code === HTTP_ACCEPTED;

  Logger.log(
    "Extract %s for %s (HTTP %s): %s",
    success ? STATUS.TRIGGERED : STATUS.FAILED,
    file.getName(),
    code,
    body
  );

  return {
    success: success,
    error: success ? "" : "HTTP " + code + ": " + body.substring(0, 200),
  };
}

function watchForNewPDFs() {
  var config;
  try {
    config = getConfig();
  } catch (e) {
    Logger.log("Configuration error: %s", e.message);
    return;
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(config.INPUT_FOLDER_ID);
  } catch (e) {
    Logger.log("Cannot access input folder %s: %s", config.INPUT_FOLDER_ID, e.message);
    return;
  }

  var files = folder.getFilesByType(MimeType.PDF);
  var processed;
  try {
    processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    Logger.log("Cannot read processing log sheet %s: %s", config.PROCESSING_LOG_SHEET_ID, e.message);
    return;
  }

  while (files.hasNext()) {
    var file = files.next();
    if (processed.has(file.getId())) continue;

    var startTime = Date.now();
    try {
      var result = callExtractFunction(file, config.EXTRACT_URL);
      result.durationMs = Date.now() - startTime;
      logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, result);
    } catch (e) {
      Logger.log("Unexpected error processing %s: %s", file.getName(), e.message);
      logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, {
        success: false,
        durationMs: Date.now() - startTime,
        error: e.message,
      });
    }
  }
}

function createTimeTrigger() {
  ScriptApp.newTrigger("watchForNewPDFs")
    .timeBased()
    .everyMinutes(POLL_INTERVAL_MINUTES)
    .create();
}
