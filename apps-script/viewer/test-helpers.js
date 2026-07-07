// Manual test functions — run from the Apps Script editor (Run > testFetchJson, etc.)
// These are NOT Jest tests; they exercise real Drive access.

var TEST_FILE_ID = 'PASTE_A_REAL_FILE_ID_HERE';

function testFetchJson() {
  var data = fetchJsonFromDrive(TEST_FILE_ID);
  Logger.log('Parsed JSON keys: %s', Object.keys(data).join(', '));
  Logger.log('Type: %s', data.blocks ? 'has blocks' : 'no blocks');
  if (data.blocks && data.blocks.length > 0) {
    var first = data.blocks[0];
    Logger.log('First block keys: %s', Object.keys(first).join(', '));
    if (first.translated_text) {
      Logger.log('Detected: translation');
    } else if (first.text) {
      Logger.log('Detected: extraction');
    }
  }
}

function testCheckAccess() {
  var result = checkAccess();
  Logger.log('Access check result: %s', result);
}

function testDoGet() {
  var output = doGet({ parameter: { fileId: TEST_FILE_ID } });
  var content = output.getContent();
  Logger.log('HTML output length: %s chars', content.length);
  Logger.log('Contains FILE_ID: %s', content.indexOf(TEST_FILE_ID) > -1);
}

function testGetFileName() {
  var name = getFileName(TEST_FILE_ID);
  Logger.log('File name: %s', name);
}
