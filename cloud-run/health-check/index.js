// Daily health check: verifies the resources the pipeline depends on and posts
// the result to a Google Chat space. Triggered by Cloud Scheduler.
//
// Env vars:
//   HEALTH_CHECK_CHAT_WEBHOOK_URL  Chat incoming webhook for the ops space (secret)
//   HEALTH_CHECK_ENVIRONMENT       Name shown in the message, e.g. "USDR"
//   HEALTH_CHECK_REGION            Region the pipeline's Cloud Run services are in
//   GOOGLE_CLOUD_PROJECT           Optional; defaults to the project it runs in

const path = require("path");

const functions = require("@google-cloud/functions-framework");
const { google } = require("googleapis");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { runChecks, logStructured, SEVERITY_INFO, SEVERITY_WARNING } = require("./run-checks");
const { formatReport, postToChat } = require("./report");

const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const DEFAULT_ENVIRONMENT = "unnamed environment";

/**
 * Read the settings this function needs. Throws listing anything missing.
 *
 * @returns {Promise<{project: string, region: string, environment: string, webhookUrl: string}>}
 */
async function getConfig() {
  const region = process.env.HEALTH_CHECK_REGION;
  const webhookUrl = process.env.HEALTH_CHECK_CHAT_WEBHOOK_URL;
  const missing = [!region && "HEALTH_CHECK_REGION", !webhookUrl && "HEALTH_CHECK_CHAT_WEBHOOK_URL"].filter(Boolean);
  if (missing.length) throw new Error(`Health check not configured: ${missing.join(", ")} unset`);

  const project = process.env.GOOGLE_CLOUD_PROJECT || (await new google.auth.GoogleAuth().getProjectId());
  const environment = process.env.HEALTH_CHECK_ENVIRONMENT || DEFAULT_ENVIRONMENT;
  return { project, region, environment, webhookUrl };
}

/**
 * Run all checks and post one Chat message: the problems with what to do, or
 * an all-clear. Responds 500 if the checks or the post fail, so Cloud
 * Scheduler records a failed run.
 */
async function healthCheck(req, res) {
  let config;
  const started = Date.now();
  try {
    config = await getConfig();
    logStructured(SEVERITY_INFO, `Health check started (${config.environment})`, {
      project: config.project, region: config.region,
    });
    const outcome = await runChecks(config);
    const text = formatReport(outcome, config.environment);
    await postToChat(config.webhookUrl, text);
    const count = outcome.problems.length;
    logStructured(count ? SEVERITY_WARNING : SEVERITY_INFO,
      `Health check finished (${config.environment}): ` +
        `${count ? `${count} problems` : "all clear"}, ${outcome.results.length} items checked, posted to Chat`, {
        problem_count: count,
        duration_ms: Date.now() - started,
        chat_message: text,
        results: outcome.results,
      });
    res.status(HTTP_OK).json({ problems: count, items: outcome.results.length });
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: `Health check failed: ${err.message}` }));
    if (config && config.webhookUrl) {
      try {
        await postToChat(config.webhookUrl, `🔴 *Daily pipeline check (${config.environment}) didn't finish:* ${err.message}`);
      } catch (postErr) {
        console.error(`Couldn't post the failure to Chat either: ${postErr.message}`);
      }
    }
    res.status(HTTP_SERVER_ERROR).json({ error: err.message });
  }
}

functions.http("healthCheck", healthCheck);

module.exports = { healthCheck, getConfig };
