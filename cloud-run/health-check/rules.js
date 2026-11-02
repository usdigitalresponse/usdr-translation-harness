// What each pipeline resource is expected to look like. These are copies of
// the rules in the services that own each resource (health-check deploys on its
// own, so it can't require their code); tests/test_health_check_rules.js fails
// if a copy stops matching its source.

// Cloud Run services the check inspects, and the env vars each needs to run.
// Optional settings (e.g. GLOSSARY_SHEET_TAB, which has a default) aren't listed.
const SERVICES = {
  extract: [
    "EXTRACTION_PROMPT_DOC_ID",
    "DRIVE_EXTRACTION_JSON_FOLDER_ID",
    "MODEL_CONFIG_SHEET_ID",
    "PROCESSING_LOG_SHEET_ID",
    "PUBSUB_TOPIC_EXTRACTION_COMPLETE",
  ],
  translate: [
    "TRANSLATION_PROMPT_DOC_ID",
    "GLOSSARY_SHEET_ID",
    "DRIVE_TRANSLATION_JSON_FOLDER_ID",
    "DRIVE_TRANSLATION_DOC_STAGING_FOLDER_ID",
    "DRIVE_TRANSLATION_DOC_FOLDER_ID",
    "MODEL_CONFIG_SHEET_ID",
    "PROCESSING_LOG_SHEET_ID",
    "STATUTES_GCS_BUCKET",
    "GOOGLE_CHAT_WEBHOOK_URL",
  ],
  "plain-language-eval": [
    "PLAIN_LANGUAGE_EVAL_PROMPT_DOC_ID",
    "MODEL_CONFIG_SHEET_ID",
    "PROCESSING_LOG_SHEET_ID",
    "DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID",
  ],
  "eval-quality": [
    "EVALUATION_RUBRIC_DOC_ID",
    "MODEL_CONFIG_SHEET_ID",
    "DRIVE_EVAL_RESULTS_FOLDER_ID",
    "EVAL_QUALITY_RESULTS_SHEET_ID",
  ],
  "capture-feedback": [
    "DERIVED_GLOSSARY_SHEET_ID",
    "DRIVE_FEEDBACK_FOLDER_ID",
  ],
};

// Env vars that hold a prompt or rubric Google Doc ID. Matched by pattern, so a
// new prompt (e.g. one per department) is picked up without a code change.
const DOC_ID_ENV_PATTERN = /(_PROMPT_DOC_ID|_RUBRIC_DOC_ID)(_|$)/;

// Glossary (source: translate/prompt-assembly.js)
const GLOSSARY_SHEET_ENV = "GLOSSARY_SHEET_ID";
const GLOSSARY_TAB_ENV = "GLOSSARY_SHEET_TAB";
const DEFAULT_GLOSSARY_SHEET_TAB = "FAMLI Spanish Glossary";
const GLOSSARY_SHEET_COLUMNS = "A:I";
const GLOSSARY_ENGLISH_TERM = "english term";
// Columns Translate reads; "status" is optional there, so it isn't required here
const GLOSSARY_REQUIRED_COLUMNS = [
  GLOSSARY_ENGLISH_TERM,
  "acronym or abbreviation",
  "approved spanish",
  "forbidden terms",
  "definition/context",
  "example english",
  "example spanish",
  "notes",
];

// Model Config (source: translate/loaders.js)
const MODEL_CONFIG_SHEET_ENV = "MODEL_CONFIG_SHEET_ID";
const MODEL_CONFIG_SHEET_RANGE = "Config";
const MODEL_CONFIG_REQUIRED_COLUMNS = ["role", "provider", "model", "active"];
const MODEL_CONFIG_ACTIVE_YES = "YES";
// The Model Config role each service picks its models by
const SERVICE_ROLES = {
  extract: "extract",
  translate: "translate",
  "plain-language-eval": "plain-language-eval",
  "eval-quality": "eval",
};

// Processing Log (source: apps-script/orchestrator/orchestrator.js)
const PROCESSING_LOG_SHEET_ENV = "PROCESSING_LOG_SHEET_ID";
const PROCESSING_LOG_TAB = "ProcessingLog";
const PROCESSING_LOG_HEADERS = [
  "fileId", "fileName", "processedAt", "status", "durationMs", "errorDetails",
  "outputJsonId", "provider", "model", "submittedBy", "outputDocUrl", "outputDocId",
];
// Rows the Orchestrator writes, which always carry the submitter's email
const ORCHESTRATOR_STATUSES = ["triggered", "pl-eval-triggered"];

// Refinement log (source: capture-feedback/glossary-writer.js, decisions.js)
const REFINEMENT_LOG_SHEET_ENV = "DERIVED_GLOSSARY_SHEET_ID";
const REFINEMENT_LOG_TABS = ["Reviewed", "ModelFlagged", "OtherChanges"];
const REFINEMENT_LOG_HEADERS = [
  "Timestamp", "Reviewer Email", "AI Term", "Reviewer Term", "Block ID", "Review Signal",
  "AI Sentence", "Doc URL", "Translation JSON URL", "Content Type", "English Source",
  "Reviewer Sentence",
];

// Eval Quality results (source: eval/quality/quality_loaders.py). The service
// creates the tab and header if they're missing, but never checks an existing one.
const EVAL_RESULTS_SHEET_ENV = "EVAL_QUALITY_RESULTS_SHEET_ID";
const EVAL_RESULTS_TAB = "EvalQuality";
const EVAL_RESULTS_HEADERS = [
  "Timestamp", "Document ID", "Provider", "Model", "Weighted Overall", "Priority",
  "Accuracy & Relevance", "Clarity & Simplicity", "Cultural Sensitivity",
  "Active Voice & Tone", "Consistency & Style", "Result File ID",
];

// Drive folders the services use: every DRIVE_*_FOLDER_ID setting. Input
// folders are only read, so they don't need to be writable.
const DRIVE_FOLDER_ENV_PATTERN = /^DRIVE_\w+_FOLDER_ID$/;
const READ_ONLY_FOLDER_ENV_PATTERN = /_INPUT_/;

// Statutes (source: translate/loaders.js loadStatutes)
const STATUTES_BUCKET_ENV = "STATUTES_GCS_BUCKET";
const STATUTES_PREFIX_ENV = "STATUTES_GCS_PREFIX";
const DEFAULT_STATUTES_PREFIX = "statutes/md-labor-emply-t8.3/";
const STATUTE_FILE_EXTENSIONS = [".txt", ".md"];

// Extract -> Translate hand-off (source: extract/main.py; ack deadline from
// setup guide 5: Translate can take up to its 600s timeout, and a shorter
// deadline makes Pub/Sub redeliver, translating the same file twice)
const PUBSUB_TOPIC_ENV = "PUBSUB_TOPIC_EXTRACTION_COMPLETE";
const MIN_ACK_DEADLINE_SECONDS = 600;

module.exports = {
  SERVICES,
  DOC_ID_ENV_PATTERN,
  GLOSSARY_SHEET_ENV,
  GLOSSARY_TAB_ENV,
  DEFAULT_GLOSSARY_SHEET_TAB,
  GLOSSARY_SHEET_COLUMNS,
  GLOSSARY_ENGLISH_TERM,
  GLOSSARY_REQUIRED_COLUMNS,
  MODEL_CONFIG_SHEET_ENV,
  MODEL_CONFIG_SHEET_RANGE,
  MODEL_CONFIG_REQUIRED_COLUMNS,
  MODEL_CONFIG_ACTIVE_YES,
  SERVICE_ROLES,
  PROCESSING_LOG_SHEET_ENV,
  PROCESSING_LOG_TAB,
  PROCESSING_LOG_HEADERS,
  ORCHESTRATOR_STATUSES,
  REFINEMENT_LOG_SHEET_ENV,
  REFINEMENT_LOG_TABS,
  REFINEMENT_LOG_HEADERS,
  EVAL_RESULTS_SHEET_ENV,
  EVAL_RESULTS_TAB,
  EVAL_RESULTS_HEADERS,
  DRIVE_FOLDER_ENV_PATTERN,
  READ_ONLY_FOLDER_ENV_PATTERN,
  STATUTES_BUCKET_ENV,
  STATUTES_PREFIX_ENV,
  DEFAULT_STATUTES_PREFIX,
  STATUTE_FILE_EXTENSIONS,
  PUBSUB_TOPIC_ENV,
  MIN_ACK_DEADLINE_SECONDS,
};
