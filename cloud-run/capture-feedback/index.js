const path = require("path");

const functions = require("@google-cloud/functions-framework");
const { google } = require("googleapis");
const { StatusCodes } = require("http-status-codes");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { diffBlocks } = require("./differ");
const { extractDecisions } = require("./decisions");
const { writeDecisions } = require("./glossary-writer");
const {
  loadTranslationFileId,
  loadTranslationJson,
  storeFeedbackJson,
  createDriveClient,
  DOC_PROPERTY_KEY,
} = require("./loaders");
const { readDocTable } = require("./doc-reader");
const { computeMetrics, computeTimeToApprove } = require("./metrics");

const PIPELINE_STAGE = "capture_feedback";
const STATUS_OK = "ok";
const STATUS_FAILED = "failed";

function logStructured(severity, message, fields = {}) {
  console.log(JSON.stringify({
    severity,
    message,
    pipeline_stage: PIPELINE_STAGE,
    ...fields,
  }));
}

const AUTH_SCOPES = [
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

async function captureFeedback(req, res) {
  const { documentId, sidebarChecks, sidebarOrphans, sidebarOpenedAt } = req.body;

  if (!documentId) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: "Provide documentId" });
    return;
  }

  const auth = new google.auth.GoogleAuth({ scopes: AUTH_SCOPES });
  const drive = createDriveClient(auth);

  // Step 1: Read the translation JSON file ID from the doc's Drive property
  let translationFileId;
  try {
    translationFileId = await loadTranslationFileId(documentId, drive);
  } catch (err) {
    logStructured("ERROR", "Failed to read document properties", { status: STATUS_FAILED, documentId, error: err.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to read document properties: " + err.message,
    });
    return;
  }

  if (!translationFileId) {
    logStructured("WARNING", "Document missing translation property", { status: STATUS_FAILED, documentId });
    res.status(StatusCodes.BAD_REQUEST).json({
      error: "Document does not have translation data (" + DOC_PROPERTY_KEY + " property missing)",
    });
    return;
  }

  // Step 2: Fetch the stored translation JSON (AI output)
  let translationJson;
  try {
    translationJson = await loadTranslationJson(translationFileId, drive);
  } catch (err) {
    logStructured("ERROR", "Failed to fetch translation JSON", { status: STATUS_FAILED, documentId, translationFileId, error: err.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to fetch translation JSON: " + err.message,
    });
    return;
  }

  // Step 3: Read the final reviewer-edited text from the Google Doc
  let reviewedBlocks;
  try {
    reviewedBlocks = await readDocTable(documentId, auth);
  } catch (err) {
    logStructured("ERROR", "Failed to read document text", { status: STATUS_FAILED, documentId, error: err.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to read document text: " + err.message,
    });
    return;
  }

  // Step 4: Diff reviewer edits against AI output
  const aiBlocks = translationJson.blocks || [];
  const diffs = diffBlocks(aiBlocks, reviewedBlocks);

  // Step 5: Extract terminology decisions from diffs + sidebar state
  const decisions = extractDecisions(diffs, translationJson, {
    checks: sidebarChecks || {},
    orphans: sidebarOrphans || {},
  }, {
    documentId,
    translationFileId,
  });

  // Step 6: Compute quality metrics
  const metrics = computeMetrics(diffs, translationJson);
  const reviewedAt = new Date().toISOString();
  const timeToApproveSeconds = computeTimeToApprove(sidebarOpenedAt, reviewedAt);

  // Step 7: Emit structured log for Cloud Logging dashboards
  const logFields = {
    status: STATUS_OK,
    documentId,
    translationFileId,
    provider: metrics.provider,
    model: metrics.model,
    totalBlocks: metrics.totalBlocks,
    unchangedBlocks: metrics.unchangedBlocks,
    changedBlocks: metrics.changedBlocks,
    acceptanceRate: metrics.acceptanceRate,
    charEditDistance: metrics.editDistance.totalCharacter,
    wordEditDistance: metrics.editDistance.totalWord,
    normalizedCharEditDistance: metrics.editDistance.normalizedCharacter,
    normalizedWordEditDistance: metrics.editDistance.normalizedWord,
    terminologyDecisions: decisions.length,
  };
  if (timeToApproveSeconds !== null) {
    logFields.timeToApproveSeconds = timeToApproveSeconds;
  }
  logStructured("INFO", `feedback captured for ${metrics.provider}/${metrics.model}`, logFields);

  // Step 8: Write terminology decisions to derived glossary sheet
  const warnings = [];
  const derivedGlossarySheetId = process.env.DERIVED_GLOSSARY_SHEET_ID;
  if (derivedGlossarySheetId && decisions.length) {
    try {
      await writeDecisions(decisions, derivedGlossarySheetId, auth);
    } catch (err) {
      console.error("Failed to write decisions to derived glossary:", err.message);
      warnings.push("Failed to write to derived glossary: " + err.message);
    }
  }

  // Step 9: Store feedback results in Drive
  const feedbackFolderId = process.env.DRIVE_FEEDBACK_FOLDER_ID;
  const feedbackResult = {
    documentId,
    translationFileId,
    reviewedAt,
    sidebarOpenedAt: sidebarOpenedAt || null,
    timeToApproveSeconds,
    metrics,
    decisions,
    diffs,
  };

  if (feedbackFolderId) {
    try {
      await storeFeedbackJson(feedbackResult, documentId, reviewedAt, feedbackFolderId, drive);
    } catch (err) {
      console.error("Failed to store feedback JSON:", err.message);
      warnings.push("Failed to store feedback JSON: " + err.message);
    }
  }

  const response = {
    status: "ok",
    documentId,
    metrics,
    decisions,
  };
  if (warnings.length) {
    response.warnings = warnings;
  }
  res.status(StatusCodes.OK).json(response);
}

functions.http("captureFeedback", captureFeedback);
module.exports = { captureFeedback };
