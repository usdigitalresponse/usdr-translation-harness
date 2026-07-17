const { google } = require("googleapis");

// https://developers.google.com/drive/api/reference/rest/v3
const DRIVE_API_VERSION = "v3";

const DOC_PROPERTY_KEY = "usdr_translation_review";
const MIME_TYPE_JSON = "application/json";
const JSON_INDENT_SPACES = 2;

/**
 * Read the translation JSON file ID from a document's Drive properties.
 * The Translate function sets this property when creating the output doc.
 */
async function loadTranslationFileId(documentId, drive) {
  const { data: file } = await drive.files.get({
    fileId: documentId,
    fields: "properties",
    supportsAllDrives: true,
  });
  return file.properties?.[DOC_PROPERTY_KEY] || null;
}

/**
 * Fetch the stored translation JSON from Drive by file ID.
 *
 * The googleapis alt:"media" response is auto-parsed based on the file's
 * content type. This works because the pipeline always writes with
 * mimeType MIME_TYPE_JSON.
 */
async function loadTranslationJson(fileId, drive) {
  const { data } = await drive.files.get({
    fileId,
    alt: "media",
    supportsAllDrives: true,
  });
  return typeof data === "string" ? JSON.parse(data) : data;
}

/**
 * Store feedback results as a JSON file in Drive.
 */
async function storeFeedbackJson(feedbackResult, documentId, reviewedAt, folderId, drive) {
  const timestamp = reviewedAt.replace(/[:.]/g, "-");
  const fileName = `feedback_${documentId}_${timestamp}.json`;

  const { data } = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: MIME_TYPE_JSON,
      parents: [folderId],
    },
    media: {
      mimeType: MIME_TYPE_JSON,
      body: JSON.stringify(feedbackResult, null, JSON_INDENT_SPACES),
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return data.id;
}

/**
 * Create an authenticated Drive API client.
 */
function createDriveClient(auth) {
  return google.drive({ version: DRIVE_API_VERSION, auth });
}

module.exports = {
  loadTranslationFileId,
  loadTranslationJson,
  storeFeedbackJson,
  createDriveClient,
  DOC_PROPERTY_KEY,
};
