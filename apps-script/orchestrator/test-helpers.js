// Manual test functions — run from the Apps Script Editor via Run > [function name].
// These verify configuration, Drive/Sheet access, and the full watcher flow
// using a stub instead of the real Extract endpoint.

function testConfig() {
  try {
    var config = getConfig();
    Logger.log("Config OK:");
    Logger.log("  INPUT_FOLDER_ID: %s", config.INPUT_FOLDER_ID);
    Logger.log("  EXTRACT_URL: %s", config.EXTRACT_URL);
    Logger.log("  PROCESSING_LOG_SHEET_ID: %s", config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    Logger.log("Config ERROR: %s", e.message);
  }
}

function testFolderAccess() {
  var config = getConfig();
  var folder = DriveApp.getFolderById(config.INPUT_FOLDER_ID);
  Logger.log("Folder name: %s", folder.getName());

  var files = folder.getFilesByType(MimeType.PDF);
  var count = 0;
  while (files.hasNext()) {
    var file = files.next();
    Logger.log("  PDF: %s (id: %s, size: %s bytes)", file.getName(), file.getId(), file.getSize());
    count++;
  }
  Logger.log("Total PDFs: %s", count);
}

function testProcessingLog() {
  var config = getConfig();
  var sheet = getProcessingLogSheet(config.PROCESSING_LOG_SHEET_ID);
  var data = sheet.getDataRange().getValues();
  Logger.log("Processing log has %s rows (including header)", data.length);

  var processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  Logger.log("Files with '%s' status: %s", STATUS.TRIGGERED, processed.size);

  if (data.length > HEADER_ROWS) {
    Logger.log("Last 5 rows:");
    var start = Math.max(HEADER_ROWS, data.length - 5);
    for (var i = start; i < data.length; i++) {
      Logger.log("  %s | %s | %s | %s | %sms | %s",
        data[i][COL.FILE_ID],
        data[i][COL.FILE_NAME],
        data[i][COL.PROCESSED_AT],
        data[i][COL.STATUS],
        data[i][COL.DURATION_MS],
        data[i][COL.ERROR_DETAIL]
      );
    }
  }
}

function testWatchWithStub() {
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

  var newCount = 0;
  var skippedCount = 0;

  while (files.hasNext()) {
    var file = files.next();
    if (processed.has(file.getId())) {
      skippedCount++;
      continue;
    }

    newCount++;
    var startTime = Date.now();
    Logger.log("STUB: Would call Extract for %s (id: %s)", file.getName(), file.getId());

    var stubResult = {
      success: true,
      durationMs: Date.now() - startTime,
      error: "",
    };
    logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, stubResult);
    Logger.log("  Logged to processing sheet with status '%s'", STATUS.TRIGGERED);
  }

  Logger.log("Done. New files processed: %s, already triggered: %s", newCount, skippedCount);
}
