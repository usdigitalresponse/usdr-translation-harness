const fs = require("fs");
const path = require("path");

const { google } = require("googleapis");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const MODEL_CONFIG_SHEET_RANGE = "Config!A:E";
const ACTIVE_YES = "YES";
const MIN_SHEET_ROWS = 2;
const COL_ACTIVE = "active";
const COL_PROVIDER = "provider";

// https://developers.google.com/docs/api/reference/rest
const DOCS_API_VERSION = "v1";
// https://developers.google.com/sheets/api/reference/rest
const SHEETS_API_VERSION = "v4";
// https://developers.google.com/drive/api/reference/rest/v3
const DRIVE_API_VERSION = "v3";

/**
 * Parse sheet rows into an array of objects keyed by the header row values.
 * Lowercases and trims header names. Returns [] if there are fewer than
 * MIN_SHEET_ROWS (i.e. no data rows beyond the header).
 */
function parseSheetRows(rows) {
  if (rows.length < MIN_SHEET_ROWS) {
    return [];
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const entry = {};
    headers.forEach((header, i) => {
      entry[header] = i < row.length ? row[i].trim() : "";
    });
    return entry;
  });
}

/**
 * Load the text content of a Google Doc identified by the given env var.
 * Used for loading the translation prompt.
 */
async function loadDoc(envVar) {
  const docId = process.env[envVar];
  if (!docId) {
    throw new Error(`${envVar} not set in .env`);
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/documents.readonly"],
  });
  const docs = google.docs({ version: DOCS_API_VERSION, auth });
  const { data } = await docs.documents.get({ documentId: docId });

  let text = "";
  for (const element of data.body?.content || []) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    for (const run of paragraph.elements || []) {
      if (run.textRun) {
        text += run.textRun.content;
      }
    }
  }
  return text;
}

/**
 * Load rows from a Google Sheet identified by the given env var.
 * Used for loading the glossary. Returns an array of objects keyed by
 * the header row values.
 */
async function loadSheet(envVar, range) {
  const sheetId = process.env[envVar];
  if (!sheetId) {
    throw new Error(`${envVar} not set in .env`);
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: SHEETS_API_VERSION, auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  return parseSheetRows(data.values || []);
}

/**
 * Load model config from the Google Sheet, or fall back to a local fixture.
 * Shared config sheet has models for all roles (extract, translate, eval).
 */
async function loadConfig() {
  const sheetId = process.env.MODEL_CONFIG_SHEET_ID;
  if (!sheetId) {
    const fixture = fs.readFileSync(
      path.join(FIXTURES_DIR, "config.json"),
      "utf-8"
    );
    return JSON.parse(fixture);
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: SHEETS_API_VERSION, auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: MODEL_CONFIG_SHEET_RANGE,
  });

  const rows = data.values || [];
  const parsed = parseSheetRows(rows);
  if (!parsed.length) {
    throw new Error(`Config sheet '${sheetId}' has no data rows`);
  }

  const models = parsed.map((entry) => ({
    ...entry,
    [COL_ACTIVE]: (entry[COL_ACTIVE] || "").toUpperCase() === ACTIVE_YES,
    [COL_PROVIDER]: (entry[COL_PROVIDER] || "").toLowerCase(),
  }));

  return { models };
}

/**
 * Fetch extraction JSON from Drive by file ID.
 * Falls back to loading from a local fixture path for local dev.
 *
 * Note: the googleapis alt:"media" response is auto-parsed based on the
 * file's content type. This works because our pipeline always writes with
 * mimeType "application/json". If files were uploaded manually with a
 * different MIME type, the return value could be a string instead of an object.
 */
async function loadExtractionJson(fileId) {
  const localPath = process.env.LOCAL_EXTRACTION_JSON_PATH;
  if (localPath) {
    const content = fs.readFileSync(localPath, "utf-8");
    return JSON.parse(content);
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: DRIVE_API_VERSION, auth });
  const { data } = await drive.files.get({
    fileId,
    alt: "media",
    supportsAllDrives: true,
  });

  return data;
}

/**
 * Write translation output to Drive, or to a local fixtures/output directory
 * when DRIVE_TRANSLATION_JSON_FOLDER_ID is not set.
 */
async function writeOutput(filename, data) {
  const content =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const folderId = process.env.DRIVE_TRANSLATION_JSON_FOLDER_ID;

  if (!folderId) {
    const outDir = path.join(FIXTURES_DIR, "output");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, filename), content);
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: DRIVE_API_VERSION, auth });

  const { data: created } = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: "application/json", body: content },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.id;
}

module.exports = {
  loadDoc,
  loadSheet,
  loadConfig,
  loadExtractionJson,
  writeOutput,
  parseSheetRows,
  DOCS_API_VERSION,
  SHEETS_API_VERSION,
  DRIVE_API_VERSION,
};
