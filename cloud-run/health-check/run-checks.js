const { google } = require("googleapis");

const { SERVICES } = require("./rules");
const { loadServiceSettings } = require("./settings");
const { problem, STATUS_PROBLEM } = require("./results");
const { checkServices } = require("./checks/services");
const { checkDocs } = require("./checks/docs");
const {
  checkGlossary, checkModelConfig, checkProcessingLog, checkRefinementLog, checkEvalResults,
} = require("./checks/sheets");
const { checkDriveFolders, checkStatutes, checkPubSub } = require("./checks/infrastructure");
const { checkLoggedProblems } = require("./checks/logs");

const AUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

// In run order. Each takes the shared context and returns a list of results.
const CHECKS = [
  { name: "Services", run: checkServices },
  { name: "Prompt and rubric docs", run: checkDocs },
  { name: "Glossary", run: checkGlossary },
  { name: "Model Config", run: checkModelConfig },
  { name: "Processing Log", run: checkProcessingLog },
  { name: "Refinement log", run: checkRefinementLog },
  { name: "Eval results", run: checkEvalResults },
  { name: "Drive folders", run: checkDriveFolders },
  { name: "Statutes", run: checkStatutes },
  { name: "Extract → Translate hand-off", run: checkPubSub },
  { name: "Logged problems", run: checkLoggedProblems },
];

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
 * @param {{project: string, region: string, clients?: Object, checks?: Object[]}} options
 * @returns {Promise<{results: Object[], problems: Object[], checksRun: number}>}
 */
async function runChecks({ project, region, clients, checks = CHECKS }) {
  if (!clients) {
    const auth = new google.auth.GoogleAuth({ scopes: AUTH_SCOPES });
    clients = createClients(auth);
  }
  const settings = await loadServiceSettings(clients.run, project, region, Object.keys(SERVICES));
  const ctx = { settings, clients, project, region };

  const results = [];
  for (const check of checks) {
    try {
      results.push(...(await check.run(ctx)));
    } catch (err) {
      console.error(`Health check "${check.name}" crashed:`, err);
      results.push(problem(check.name, "the check itself", "check_crashed", err.message));
    }
  }
  return {
    results,
    problems: results.filter((r) => r.status === STATUS_PROBLEM),
    checksRun: checks.length,
  };
}

module.exports = { runChecks, createClients, CHECKS, AUTH_SCOPES };
