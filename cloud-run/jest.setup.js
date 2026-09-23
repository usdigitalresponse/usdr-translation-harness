// The functions load the repo-root .env when required, so without this a test
// that reaches real I/O would write to the live pipeline (Drive, Sheets, Chat).
// dotenv never overrides a variable that's already set, so blanking these
// before any module loads keeps .env values out of tests. Tests that need one
// set it explicitly.
const LIVE_RESOURCE_VARS = [
  "DERIVED_GLOSSARY_SHEET_ID",
  "DRIVE_FEEDBACK_FOLDER_ID",
  "DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID",
  "DRIVE_TRANSLATION_DOC_FOLDER_ID",
  "DRIVE_TRANSLATION_DOC_STAGING_FOLDER_ID",
  "DRIVE_TRANSLATION_JSON_FOLDER_ID",
  "GLOSSARY_SHEET_ID",
  "GOOGLE_CHAT_WEBHOOK_URL",
  "MODEL_CONFIG_SHEET_ID",
  "PROCESSING_LOG_SHEET_ID",
  "STATUTES_GCS_BUCKET",
  "TRANSLATION_PROMPT_DOC_ID",
  "PLAIN_LANGUAGE_EVAL_PROMPT_DOC_ID",
];

for (const key of LIVE_RESOURCE_VARS) {
  process.env[key] = "";
}
