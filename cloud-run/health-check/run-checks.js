const { google } = require("googleapis");

const { SERVICES, INPUT_FOLDER_ENVS } = require("./rules");
const { loadServiceSettings } = require("./settings");
const { problem, STATUS_PROBLEM } = require("./results");
const { checkServices } = require("./checks/services");
const { checkDocs } = require("./checks/docs");
const {
  checkGlossary, checkModelConfig, checkProcessingLog, checkRefinementLog, checkEvalResults,
} = require("./checks/sheets");
const { checkDriveFolders, checkStatutes, checkPubSub } = require("./checks/infrastructure");
const { checkLoggedProblems } = require("./checks/logs");
const { checkQueue } = require("./checks/queue");

const AUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

const SEVERITY_INFO = "INFO";
const SEVERITY_WARNING = "WARNING";

/**
 * One structured log line (Cloud Logging reads severity and fields from JSON).
 */
function logStructured(severity, message, fields = {}) {
  console.log(JSON.stringify({ severity, message, ...fields }));
}

// In run order. Each takes the shared context and returns a list of results.
const CHECKS = [
  { name: "Services", run: checkServices },
  { name: "Prompt and rubric docs", run: checkDocs },
  { name: "Glossary", run: checkGlossary },
  { name: "Model Config", run: checkModelConfig },
  { name: "Processing Log", run: checkProcessingLog },
  { name: "Orchestrator queue", run: checkQueue },
  { name: "Refinement log", run: checkRefinementLog },
  { name: "Eval results", run: checkEvalResults },
  { name: "Drive folders", run: checkDriveFolders },
  { name: "Statutes", run: checkStatutes },
  { name: "Extract → Translate hand-off", run: checkPubSub },
  { name: "Logged problems", run: checkLoggedProblems },
];

/**
 * The Orchestrator's input folders, from the health-check service's own copies
 * of its Script Properties (see INPUT_FOLDER_ENVS). Unset ones are skipped.
 *
 * @returns {Array<{name: string, id: string}>}
 */
function inputFoldersFromEnv(env = process.env) {
  return INPUT_FOLDER_ENVS.filter((name) => env[name]).map((name) => ({ name, id: env[name] }));
}

/** googleapis clients the checks use, all authenticated as the service account. */
function createClients(auth) {
  return {
    run: google.run({ version: "v2", auth }),
    docs: google.docs({ version: "v1", auth }),
    sheets: google.sheets({ version: "v4", auth }),
    drive: google.drive({ version: "v3", auth }),
    storage: google.storage({ version: "v1", auth }),
    pubsub: google.pubsub({ version: "v1", auth }),
    logging: google.logging({ version: "v2", auth }),
  };
}

/**
 * Run every check. A check that throws becomes a "check_crashed" problem, so
 * one broken check never hides the others' results.
 *
 * Logs one line per check (items, problems, time taken), so the service's
 * logs show what ran even when the Chat message says "all clear".
 *
 * @param {{project: string, region: string, clients?: Object, checks?: Object[],
 *   log?: Function, inputFolders?: Array<{name: string, id: string}>}} options
 *   inputFolders defaults to inputFoldersFromEnv()
 * @returns {Promise<{results: Object[], problems: Object[], checksRun: number}>}
 */
async function runChecks({ project, region, clients, checks = CHECKS, log = logStructured,
  inputFolders = inputFoldersFromEnv() }) {
  if (!clients) {
    const auth = new google.auth.GoogleAuth({ scopes: AUTH_SCOPES });
    clients = createClients(auth);
  }
  const settings = await loadServiceSettings(clients.run, project, region, Object.keys(SERVICES));
  const ctx = { settings, clients, project, region, inputFolders };

  const results = [];
  for (const check of checks) {
    const started = Date.now();
    let checkResults;
    try {
      checkResults = await check.run(ctx);
    } catch (err) {
      console.error(`Health check "${check.name}" crashed:`, err);
      checkResults = [problem(check.name, "the check itself", "check_crashed", err.message)];
    }
    results.push(...checkResults);
    const found = checkResults.filter((r) => r.status === STATUS_PROBLEM);
    log(found.length ? SEVERITY_WARNING : SEVERITY_INFO,
      `Check "${check.name}": ${checkResults.length} items, ${found.length} problems`, {
        check: check.name,
        items: checkResults.length,
        problems: found.map((p) => `${p.resource}: ${p.detail}`),
        duration_ms: Date.now() - started,
      });
  }
  return {
    results,
    problems: results.filter((r) => r.status === STATUS_PROBLEM),
    checksRun: checks.length,
  };
}

module.exports = {
  runChecks, createClients, logStructured, inputFoldersFromEnv, CHECKS, AUTH_SCOPES, SEVERITY_INFO, SEVERITY_WARNING,
};
