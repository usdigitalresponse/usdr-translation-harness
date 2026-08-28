const DOC_BASE_URL = "https://docs.google.com/document/d/";

async function notifyDocCreated({ sourceFileName, provider, model, docId, submittedByEmail }) {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const docUrl = `${DOC_BASE_URL}${docId}`;
  const text = `Translation ready: *${sourceFileName}* (${provider}/${model}) — <${docUrl}|Open doc>`;
  await postToChat(webhookUrl, text);
}

async function notifyDocFailed({ sourceFileName, provider, model, error, submittedByEmail }) {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const text =
    `Translation doc creation failed for *${sourceFileName}* (${provider}/${model}). ` +
    `The translation JSON was saved but no output document was created. ` +
    `Error: ${error}. Contact your workflow owner to retry.`;
  await postToChat(webhookUrl, text);
}

async function postToChat(webhookUrl, text) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`Chat webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Chat webhook failed: ${err.message}`);
  }
}

module.exports = { notifyDocCreated, notifyDocFailed, DOC_BASE_URL };
