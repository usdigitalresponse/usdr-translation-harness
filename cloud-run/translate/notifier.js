const { STATUS_CODES } = require("http");

const DOC_BASE_URL = "https://docs.google.com/document/d/";

// All webhook problems share this prefix so a single log-based metric can alert
// on them. Changing it means updating the Chat notification alert policy.
const LOG_PREFIX = "Chat webhook";

const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_MAX = 500;

/**
 * Reads the Chat webhook URL, warning loudly when it is missing.
 *
 * An unset URL disables notifications entirely, so it is logged rather than
 * skipped in silence.
 *
 * @returns {string} The webhook URL, or "" when unconfigured.
 */
function getWebhookUrl() {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (webhookUrl) return webhookUrl;

  console.warn(
    `${LOG_PREFIX} not configured: GOOGLE_CHAT_WEBHOOK_URL is unset. ` +
      `No Chat notifications will be sent.`
  );
  return "";
}

/**
 * Posts a "translation ready" notification with a link to the output doc.
 *
 * No-ops when the webhook is unconfigured. Never throws.
 *
 * @param {{sourceFileName: string, provider: string, model: string,
 *          docId: string, submittedByEmail?: string}} params
 */
async function notifyDocCreated({ sourceFileName, provider, model, docId, submittedByEmail }) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return;

  const docUrl = `${DOC_BASE_URL}${docId}`;
  const text = `Translation ready: *${sourceFileName}* (${provider}/${model}) — <${docUrl}|Open doc>`;
  await postToChat(webhookUrl, text);
}

/**
 * Posts a notification that output-doc creation failed for a translation.
 *
 * No-ops when the webhook is unconfigured. Never throws.
 *
 * @param {{sourceFileName: string, provider: string, model: string,
 *          error: string, submittedByEmail?: string}} params
 */
async function notifyDocFailed({ sourceFileName, provider, model, error, submittedByEmail }) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return;

  const text =
    `Translation doc creation failed for *${sourceFileName}* (${provider}/${model}). ` +
    `The translation JSON was saved but no output document was created. ` +
    `Error: ${error}. Contact your workflow owner to retry.`;
  await postToChat(webhookUrl, text);
}

/**
 * Posts a plain-text message to a Google Chat incoming webhook.
 *
 * Notifications are best-effort: failures are logged and swallowed so they
 * never fail a translation. 4xx responses are labelled as permanent, since they
 * mean the webhook or the Workspace Chat policy needs an operator to fix it and
 * every later notification will fail the same way until then.
 *
 * @param {string} webhookUrl
 * @param {string} text
 */
async function postToChat(webhookUrl, text) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return;

    const body = await res.text();
    const status = `${res.status} ${STATUS_CODES[res.status] ?? ""}`.trim();

    if (res.status >= CLIENT_ERROR_MIN && res.status < CLIENT_ERROR_MAX) {
      console.error(
        `${LOG_PREFIX} rejected with ${status} and will keep failing until ` +
          `the webhook or the Workspace Chat policy is fixed: ${body}`
      );
      return;
    }
    console.error(`${LOG_PREFIX} returned ${status}: ${body}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed: ${err.message}`);
  }
}

module.exports = { notifyDocCreated, notifyDocFailed, DOC_BASE_URL, LOG_PREFIX };
