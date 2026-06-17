// Watches a Drive input folder for new PDFs and triggers the Extract Cloud Run function.

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    INPUT_FOLDER_ID: props.getProperty("INPUT_FOLDER_ID"),
    EXTRACT_URL: props.getProperty("EXTRACT_FUNCTION_URL"),
  };
}

function watchForNewPDFs() {
  var config = getConfig();
  var folder = DriveApp.getFolderById(config.INPUT_FOLDER_ID);
  var files = folder.getFilesByType(MimeType.PDF);
  var processed = getProcessedFileIds();

  while (files.hasNext()) {
    var file = files.next();
    if (processed.indexOf(file.getId()) !== -1) continue;

    callExtractFunction(file, config.EXTRACT_URL);
    markFileProcessed(file.getId());
  }
}

function callExtractFunction(file, extractUrl) {
  var blob = file.getBlob();
  var base64 = Utilities.base64Encode(blob.getBytes());
  var token = ScriptApp.getIdentityToken();

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      pdfBase64: base64,
      fileName: file.getName(),
      fileId: file.getId(),
    }),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(extractUrl, options);
  Logger.log("Extract response for %s: %s", file.getName(), response.getContentText());
}

function getProcessedFileIds() {
  var prop = PropertiesService.getScriptProperties().getProperty("PROCESSED_FILES");
  return prop ? JSON.parse(prop) : [];
}

function markFileProcessed(fileId) {
  var processed = getProcessedFileIds();
  processed.push(fileId);
  PropertiesService.getScriptProperties().setProperty("PROCESSED_FILES", JSON.stringify(processed));
}

function createTimeTrigger() {
  ScriptApp.newTrigger("watchForNewPDFs")
    .timeBased()
    .everyMinutes(5)
    .create();
}
