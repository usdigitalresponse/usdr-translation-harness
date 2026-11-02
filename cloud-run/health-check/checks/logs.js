// Check 11: problems the services logged themselves in the last 24 hours.
// The services already log every input problem with an input_problem field,
// and every Chat webhook failure with a "Chat webhook" prefix
// (translate/notifier.js); this surfaces them daily instead of waiting for
// someone to search the logs.

const { SERVICES } = require("../rules");
const { ok, problem } = require("../results");

const CHECK = "Logged problems";
const HOURS_TO_CHECK = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_MESSAGE_CHARS = 300;
const CHAT_WEBHOOK_PREFIX = "Chat webhook";
const TRACEBACK_START = "Traceback";

// Only the pipeline's own services: other services in the project (e.g. a
// budget-alert relay) aren't ours to report on, and the runbook text assumes
// pipeline services.
const PIPELINE_SERVICES_FILTER =
  `resource.labels.service_name=(${Object.keys(SERVICES).map((s) => `"${s}"`).join(" OR ")})`;

function sinceFilter(now) {
  return `timestamp>="${new Date(now - HOURS_TO_CHECK * MS_PER_HOUR).toISOString()}"`;
}

async function listEntries(clients, project, filter) {
  const { data } = await clients.logging.entries.list({
    requestBody: {
      resourceNames: [`projects/${project}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: MAX_ENTRIES,
    },
  });
  return data.entries || [];
}

function serviceOf(entry) {
  return ((entry.resource || {}).labels || {}).service_name || "unknown service";
}

/**
 * The entry's message, shortened. For a Python traceback, the last line (the
 * exception itself) is the useful part, not the opening "Traceback" frames.
 */
function messageOf(entry) {
  let text = entry.textPayload || (entry.jsonPayload || {}).message || "";
  if (text.startsWith(TRACEBACK_START)) {
    const lines = text.trim().split("\n");
    text = lines[lines.length - 1].trim();
  }
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

/**
 * Group entries by a key, keeping a count and the newest message (entries
 * arrive newest first).
 */
function group(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const g = groups.get(key) || { key, count: 0, latest: messageOf(entry) };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

const times = (n) => `${n} ${n === 1 ? "time" : "times"} in the last ${HOURS_TO_CHECK} hours`;

async function checkLoggedProblems({ clients, project, now = Date.now() }) {
  const results = [];
  const since = sinceFilter(now);

  const inputProblems = await listEntries(clients, project,
    `${PIPELINE_SERVICES_FILTER} AND jsonPayload.input_problem:* AND ${since}`);
  for (const g of group(inputProblems, (e) => `${serviceOf(e)}: ${e.jsonPayload.input_problem}`)) {
    results.push(problem(CHECK, g.key, "logged_input_problem", `${times(g.count)}. Latest: ${g.latest}`));
  }

  const webhookFilter = `${PIPELINE_SERVICES_FILTER} AND ` +
    `(textPayload:"${CHAT_WEBHOOK_PREFIX}" OR jsonPayload.message:"${CHAT_WEBHOOK_PREFIX}") AND ${since}`;
  const webhookErrors = await listEntries(clients, project, webhookFilter);
  for (const g of group(webhookErrors, (e) => `${serviceOf(e)}: Chat webhook`)) {
    results.push(problem(CHECK, g.key, "logged_chat_webhook_error", `${times(g.count)}. Latest: ${g.latest}`));
  }

  if (!results.length) {
    results.push(ok(CHECK, "service logs", `no input problems or Chat webhook errors in the last ${HOURS_TO_CHECK} hours`));
  }
  return results;
}

module.exports = { checkLoggedProblems, messageOf, PIPELINE_SERVICES_FILTER };
