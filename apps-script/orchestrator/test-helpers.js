// Manual test functions — run from the Apps Script Editor via Run > [function name].
// These verify configuration, Drive/Sheet access, and the full watcher flow
// using a stub instead of the real Extract endpoint.
//
// Run testAll() to execute all checks in order, or run each function individually.

function testAll() {
  Logger.log("=== 1/4: Config ===");
  testConfig();
  Logger.log("");

  Logger.log("=== 2/4: Folder Access ===");
  testFolderAccess();
  Logger.log("");

  Logger.log("=== 3/4: Processing Log ===");
  testProcessingLog();
  Logger.log("");

  Logger.log("=== 4/4: Watch with Stub ===");
  testWatchWithStub();
  Logger.log("");

  Logger.log("=== All checks complete ===");
}

function testConfig() {
  try {
    var config = getConfig();
    Logger.log("Config OK:");
    Logger.log("  EXTRACT_URL: %s", config.EXTRACT_URL);
    Logger.log("  PLAIN_LANGUAGE_EVAL_URL: %s", config.PLAIN_LANGUAGE_EVAL_URL);
    Logger.log("  PROCESSING_LOG_SHEET_ID: %s", config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    Logger.log("Config ERROR: %s", e.message);
  }

  var props = PropertiesService.getScriptProperties();
  INPUT_FOLDERS.forEach(function(fc) {
    var id = props.getProperty(fc.propertyKey);
    Logger.log("  %s: %s (%s)", fc.propertyKey, id || "(not set)", fc.contentType);
  });
}

function testFolderAccess() {
  var props = PropertiesService.getScriptProperties();
  INPUT_FOLDERS.forEach(function(fc) {
    var folderId = props.getProperty(fc.propertyKey);
    if (!folderId) {
      Logger.log("  %s: not set — skipping", fc.propertyKey);
      return;
    }
    try {
      var folder = DriveApp.getFolderById(folderId);
      Logger.log("  %s: %s", fc.propertyKey, folder.getName());
      var allFiles = getInputFiles(folder);
      for (var i = 0; i < allFiles.length; i++) {
        var file = allFiles[i];
        Logger.log("    File: %s (id: %s, type: %s, size: %s bytes)", file.getName(), file.getId(), file.getMimeType(), file.getSize());
      }
      Logger.log("    Total files: %s", allFiles.length);
    } catch (e) {
      Logger.log("  %s: ERROR — %s", fc.propertyKey, e.message);
    }
  });
}

function testProcessingLog() {
  var config = getConfig();
  var sheet = getProcessingLogSheet(config.PROCESSING_LOG_SHEET_ID);
  var data = sheet.getDataRange().getValues();
  Logger.log("Processing log has %s rows (including header)", data.length);

  var processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  Logger.log("Files with extract status: %s, PL eval status: %s", processed.extract.size, processed.plEval.size);

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

  var props = PropertiesService.getScriptProperties();
  var processed;
  try {
    processed = getProcessedFileIds(config.PROCESSING_LOG_SHEET_ID);
  } catch (e) {
    Logger.log("Cannot read processing log sheet %s: %s", config.PROCESSING_LOG_SHEET_ID, e.message);
    return;
  }

  INPUT_FOLDERS.forEach(function(fc) {
    var folderId = props.getProperty(fc.propertyKey);
    if (!folderId) {
      Logger.log("  %s: not set — skipping", fc.propertyKey);
      return;
    }

    var folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (e) {
      Logger.log("Cannot access folder %s (%s): %s", fc.propertyKey, folderId, e.message);
      return;
    }

    Logger.log("Checking folder: %s (%s)", folder.getName(), fc.contentType);
    var allFiles = getInputFiles(folder);
    var newCount = 0;
    var skippedCount = 0;

    for (var i = 0; i < allFiles.length; i++) {
      var file = allFiles[i];
      if (processed.extract.has(file.getId())) {
        skippedCount++;
        continue;
      }

      newCount++;
      var startTime = Date.now();
      Logger.log("  STUB: Would call Extract for %s (id: %s, contentType: %s)", file.getName(), file.getId(), fc.contentType);

      var stubResult = {
        success: true,
        durationMs: Date.now() - startTime,
        error: "",
      };
      logProcessingResult(config.PROCESSING_LOG_SHEET_ID, file, stubResult, STATUS.TRIGGERED, STATUS.FAILED);
      Logger.log("    Logged to processing sheet with status '%s'", STATUS.TRIGGERED);
    }

    Logger.log("  Done. New files: %s, already triggered: %s", newCount, skippedCount);
  });
}
