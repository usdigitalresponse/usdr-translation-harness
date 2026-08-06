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
const PROCESSING_LOG_TAB_NAME = "ProcessingLog";

const DOCS_API_VERSION = "v1";
const SHEETS_API_VERSION = "v4";
const DRIVE_API_VERSION = "v3";

const MIME_PDF = "application/pdf";
const MIME_GOOGLE_DOCS = "application/vnd.google-apps.document";
const MIME_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

async function fetchDocumentContent(fileId, mimeType) {
  const localPath = process.env.LOCAL_DOCUMENT_PATH;
  if (localPath) {
    const data = fs.readFileSync(localPath);
    if (mimeType === MIME_PDF) {
      return { text: null, pdfBase64: data.toString("base64") };
    }
    return { text: data.toString("utf-8"), pdfBase64: null };
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: DRIVE_API_VERSION, auth });

  if (mimeType === MIME_PDF) {
    const { data } = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return { text: null, pdfBase64: Buffer.from(data).toString("base64") };
  }

  if (mimeType === MIME_GOOGLE_DOCS) {
    const { data } = await drive.files.export({
      fileId,
      mimeType: "text/plain",
    });
    return { text: data, pdfBase64: null };
  }

  if (mimeType === MIME_DOCX) {
    const { data } = await drive.files.export({
      fileId,
      mimeType: "text/plain",
    });
    return { text: data, pdfBase64: null };
  }

  throw new Error(`Unsupported MIME type: ${mimeType}`);
}

async function writeOutput(filename, data) {
  const content =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const folderId = process.env.DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID;

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

function formatTimestamp(date) {
  return date
    .toLocaleString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(",", "");
}

async function logEvalResult(sourceFileId, sourceFileName, evalResult) {
  const sheetId = process.env.PROCESSING_LOG_SHEET_ID;
  if (!sheetId) {
    console.log("No PROCESSING_LOG_SHEET_ID set — skipping log update");
    return;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: SHEETS_API_VERSION, auth });

  const completedAt = formatTimestamp(new Date());

  const row = [
    sourceFileId || "",
    sourceFileName,
    completedAt,
    evalResult.status,
    evalResult.durationMs || "",
    evalResult.error || "",
    evalResult.outputFileId || "",
    evalResult.provider,
    evalResult.model,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${PROCESSING_LOG_TAB_NAME}!A:I`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  console.log(
    `Logged plain language eval result for ${evalResult.provider}/${evalResult.model} to processing log`
  );
}

function stripExtension(fileName) {
  return path.parse(fileName).name;
}

module.exports = {
  loadDoc,
  loadConfig,
  fetchDocumentContent,
  writeOutput,
  logEvalResult,
  formatTimestamp,
  parseSheetRows,
  stripExtension,
  MIME_PDF,
  MIME_GOOGLE_DOCS,
  MIME_DOCX,
};
