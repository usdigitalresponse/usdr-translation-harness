// Formats check results as one Google Chat message, and posts it.

const { STATUS_CODES } = require("http");
const { whatToDo } = require("./runbook");

const TITLE = "Daily pipeline check";
const ICON_OK = "✅";
const ICON_PROBLEM = "🔴";
const LOG_PREFIX = "Health check Chat webhook";

/**
 * @param {{results: Object[], problems: Object[], checksRun: number}} outcome
 * @param {string} environment - e.g. "USDR" or "Maryland"
 * @returns {string} Chat message text (Chat supports *bold*)
 */
function formatReport({ results, problems, checksRun }, environment) {
  if (!problems.length) {
    return `${ICON_OK} *${TITLE} (${environment}): all clear.* ` +
      `${checksRun} checks, ${results.length} items, no problems.`;
  }
  const lines = [
    `${ICON_PROBLEM} *${TITLE} (${environment}): ${problems.length} ` +
      `${problems.length === 1 ? "problem" : "problems"} found.*`,
  ];
  for (const p of problems) {
    lines.push("", `*${p.check}* — ${p.resource}`, p.detail, `What to do: ${whatToDo(p.code)}`);
  }
  return lines.join("\n");
}

/**
 * Post a message to a Google Chat incoming webhook. Throws on failure, so a
 * broken webhook makes the scheduled run fail visibly instead of going quiet.
 *
 * @param {string} webhookUrl
 * @param {string} text
 */
async function postToChat(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const status = `${res.status} ${STATUS_CODES[res.status] ?? ""}`.trim();
    throw new Error(`${LOG_PREFIX} returned ${status}: ${await res.text()}`);
  }
}

module.exports = { formatReport, postToChat, LOG_PREFIX };
