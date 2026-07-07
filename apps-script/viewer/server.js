function doGet(e) {
  var params = e.parameter || {};
  var fileId = params.fileId || '';
  var extractionFileId = params.extractionFileId || '';
  var pdfFileId = params.pdfFileId || '';

  if (!checkAccess()) {
    return HtmlService.createHtmlOutput(
      '<h2>Access denied</h2><p>You do not have permission to use this viewer. ' +
      'Ask the project owner to share the translation input folder with your Google account.</p>'
    )
      .setTitle('Translation Harness Viewer')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var template = HtmlService.createTemplateFromFile('viewer');
  template.fileId = fileId;
  template.extractionFileId = extractionFileId;
  template.pdfFileId = pdfFileId;

  return template.evaluate()
    .setTitle('Translation Harness Viewer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function checkAccess() {
  var folderId = PropertiesService.getScriptProperties()
    .getProperty('ACCESS_GATE_FOLDER_ID');

  if (!folderId) {
    return true;
  }

  try {
    DriveApp.getFolderById(folderId);
    return true;
  } catch (err) {
    return false;
  }
}

function fetchJsonFromDrive(fileId) {
  if (!fileId) {
    throw new Error('No file ID provided');
  }
  var file = DriveApp.getFileById(fileId);
  var content = file.getBlob().getDataAsString();
  return JSON.parse(content);
}

function getFileName(fileId) {
  if (!fileId) return '';
  var file = DriveApp.getFileById(fileId);
  return file.getName();
}

function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

function listFolderFiles(folderKey) {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(folderKey);
  if (!folderId) return [];

  var folder = DriveApp.getFolderById(folderId);
  var extension = (folderKey === 'PDF_FOLDER_ID') ? '.pdf' : '.json';
  var files = folder.getFiles();
  var result = [];
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (!name.toLowerCase().endsWith(extension)) continue;
    result.push({
      id: f.getId(),
      name: name,
      updated: f.getLastUpdated().toISOString(),
    });
  }
  result.sort(function(a, b) { return b.updated.localeCompare(a.updated); });
  return result;
}
