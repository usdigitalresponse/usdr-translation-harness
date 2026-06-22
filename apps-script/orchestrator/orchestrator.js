// Watches a Drive input folder for new PDFs and triggers the Extract Cloud Run function.
// The extract function is fire-and-forget: it returns 202 immediately and processes in the background.
// Processing history is logged to a Google Sheet for auditability.

var HTTP_ACCEPTED = 202;
var POLL_INTERVAL_MINUTES = 5;
var TRIGGERED_STATUS = "triggered";
var COL_FILE_ID = 0;
var COL_STATUS = 3;
var HEADER_ROWS = 1;

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    INPUT_FOLDER_ID: props.getProperty("INPUT_FOLDER_ID"),
    EXTRACT_URL: props.getProperty("EXTRACT_FUNCTION_URL"),
    PROCESSING_LOG_SHEET_ID: props.getProperty("PROCESSING_LOG_SHEET_ID"),
  };
}

function watchForNewPDFs() {
  var config = getConfig();
  var folder = DriveApp.getFolderById(config.INPUT_FOLDER_ID);
  var files = folder.getFilesByType(MimeType.PDF);
  var processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);

  while (files.hasNext()) {
    var file = files.next();
    if (processed.has(file.getId())) continue;

    var success = callExtractFunction(file, config.EXTRACT_URL);
    logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, success);
  }
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
  Logger.log("Extract triggered for %s (HTTP %s): %s", file.getName(), code, response.getContentText());
  return code === HTTP_ACCEPTED;
}

function getProcessingLogSheet(sheetId) {
  return SpreadsheetApp.openById(sheetId).getSheetByName("ProcessingLog");
}

function getProcessedFileIds(sheetId) {
  const sheet = getProcessingLogSheet(sheetId);
  const data = sheet.getDataRange().getValues();
  return new Set(
    data.slice(HEADER_ROWS)
      .filter(row => row[COL_STATUS] === TRIGGERED_STATUS)
      .map(row => row[COL_FILE_ID])
  );
}

function logProcessingResult(sheetId, file, success) {
  var sheet = getProcessingLogSheet(sheetId);
  sheet.appendRow([
    file.getId(),
    file.getName(),
    new Date(),
    success ? TRIGGERED_STATUS : "failed",
  ]);
}

function createTimeTrigger() {
  ScriptApp.newTrigger("watchForNewPDFs")
    .timeBased()
    .everyMinutes(POLL_INTERVAL_MINUTES)
    .create();
}
