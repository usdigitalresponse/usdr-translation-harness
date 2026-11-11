// Checks 8–10: Drive folders, statutes bucket, and the Extract -> Translate
// Pub/Sub hand-off.

const rules = require("../rules");
const { ok, problem } = require("../results");
const { valuesOf } = require("../settings");
const { describeAccessError } = require("./access-errors");

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FOLDER_FIELDS = "id,name,mimeType,trashed,capabilities(canAddChildren)";

// ── Check 8: Drive folders ────────────────────────────────────────────────

/** Every DRIVE_*_FOLDER_ID across services, deduplicated by folder ID. */
function foldersToCheck(settings) {
  const byId = new Map();
  for (const [service, s] of Object.entries(settings)) {
    for (const [name, value] of Object.entries(s.env || {})) {
      if (!rules.DRIVE_FOLDER_ENV_PATTERN.test(name) || !value) continue;
      // Writable is required if any service writes to it
      const entry = byId.get(value) || { folderId: value, usedBy: [], mustBeWritable: false };
      entry.usedBy.push(`${service} ${name}`);
      entry.mustBeWritable = entry.mustBeWritable || !rules.READ_ONLY_FOLDER_ENV_PATTERN.test(name);
      byId.set(value, entry);
    }
  }
  return [...byId.values()];
}

async function checkDriveFolders({ settings, clients }) {
  const CHECK = "Drive folders";
  const results = [];
  for (const { folderId, usedBy, mustBeWritable } of foldersToCheck(settings)) {
    const label = usedBy.join(", ");
    let data;
    try {
      ({ data } = await clients.drive.files.get({ fileId: folderId, fields: FOLDER_FIELDS, supportsAllDrives: true }));
    } catch (err) {
      results.push(problem(CHECK, label, "drive_folder_unreadable", describeAccessError(err, "folder", folderId)));
      continue;
    }
    const resource = `'${data.name}' (${label})`;
    if (data.mimeType !== FOLDER_MIME_TYPE) {
      results.push(problem(CHECK, resource, "drive_folder_not_folder", `${folderId} is a ${data.mimeType}, not a folder.`));
    } else if (data.trashed) {
      results.push(problem(CHECK, resource, "drive_folder_trashed", "The folder is in the trash."));
    } else if (mustBeWritable && !(data.capabilities && data.capabilities.canAddChildren)) {
      results.push(problem(CHECK, resource, "drive_folder_read_only", "The service account can't add files here."));
    } else {
      results.push(ok(CHECK, resource));
    }
  }
  return results;
}

// ── Check 9: Statutes ─────────────────────────────────────────────────────

async function checkStatutes({ settings, clients }) {
  const CHECK = "Statutes";
  const results = [];
  for (const { service, value: bucket } of valuesOf(settings, rules.STATUTES_BUCKET_ENV)) {
    const prefix = settings[service].env[rules.STATUTES_PREFIX_ENV] || rules.DEFAULT_STATUTES_PREFIX;
    const resource = `gs://${bucket}/${prefix} (${service})`;
    let items;
    try {
      ({ data: { items = [] } } = await clients.storage.objects.list({ bucket, prefix, fields: "items(name)" }));
    } catch (err) {
      results.push(problem(CHECK, resource, "statutes_unreadable", `Can't list the bucket: ${err.message}`));
      continue;
    }
    const files = items.filter((o) => rules.STATUTE_FILE_EXTENSIONS.some((ext) => o.name.endsWith(ext)));
    results.push(files.length
      ? ok(CHECK, resource, `${files.length} statute files`)
      : problem(CHECK, resource, "statutes_empty", `No ${rules.STATUTE_FILE_EXTENSIONS.join(" or ")} files under this prefix.`));
  }
  return results;
}

// ── Check 10: Extract -> Translate hand-off ───────────────────────────────

async function checkPubSub({ settings, clients }) {
  const CHECK = "Extract → Translate hand-off";
  const results = [];
  for (const { value: topic } of valuesOf(settings, rules.PUBSUB_TOPIC_ENV)) {
    const resource = `topic ${topic.split("/").pop()}`;
    try {
      await clients.pubsub.projects.topics.get({ topic });
    } catch (err) {
      results.push(problem(CHECK, resource, "pubsub_topic_missing", `Can't find the topic: ${err.message}`));
      continue;
    }
    const { data: { subscriptions = [] } } = await clients.pubsub.projects.topics.subscriptions.list({ topic });
    if (!subscriptions.length) {
      results.push(problem(CHECK, resource, "pubsub_no_subscription",
        "No subscription on the topic, so extractions never reach Translate."));
      continue;
    }
    for (const subscription of subscriptions) {
      const { data } = await clients.pubsub.projects.subscriptions.get({ subscription });
      const name = `subscription ${subscription.split("/").pop()}`;
      results.push(data.ackDeadlineSeconds >= rules.MIN_ACK_DEADLINE_SECONDS
        ? ok(CHECK, name, `ack deadline ${data.ackDeadlineSeconds}s`)
        : problem(CHECK, name, "pubsub_ack_deadline_short",
          `Ack deadline is ${data.ackDeadlineSeconds}s; needs at least ${rules.MIN_ACK_DEADLINE_SECONDS}s or slow translations run twice.`));
      if (!data.retryPolicy) {
        results.push(problem(CHECK, name, "pubsub_no_retry_backoff", "No retry policy, so failed translations are redelivered immediately."));
      }
      if (!data.deadLetterPolicy || !data.deadLetterPolicy.deadLetterTopic) {
        results.push(problem(CHECK, name, "pubsub_no_dead_letter",
          "No dead-letter policy, so a translation that keeps failing is retried until the message expires."));
        continue;
      }
      results.push(...await checkDeadLetter(CHECK, clients, data.deadLetterPolicy));
    }
  }
  return results;
}

/** Decoded payload of a Pub/Sub message (Extract's JSON), or {} if it isn't JSON. */
function messagePayload(message) {
  try {
    return JSON.parse(Buffer.from(message.data || "", "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

/**
 * Report dead-lettered translations: messages Translate failed on every
 * delivery attempt, kept on the dead-letter topic's subscriptions.
 *
 * Peeks without removing anything: pulls up to DEAD_LETTER_PEEK_MAX messages,
 * then immediately hands them back (ack deadline 0), so they stay until someone
 * clears them. Needs Pub/Sub Subscriber on the dead-letter subscription.
 */
async function checkDeadLetter(CHECK, clients, { deadLetterTopic, maxDeliveryAttempts }) {
  const topicName = deadLetterTopic.split("/").pop();
  const { data: { subscriptions = [] } } = await clients.pubsub.projects.topics.subscriptions.list({ topic: deadLetterTopic });
  if (!subscriptions.length) {
    return [problem(CHECK, `dead-letter topic ${topicName}`, "pubsub_dead_letter_unwatched",
      "Nothing subscribes to the dead-letter topic, so failed translations are dropped without a trace.")];
  }
  const results = [];
  for (const subscription of subscriptions) {
    const resource = `dead-letter subscription ${subscription.split("/").pop()}`;
    let receivedMessages;
    try {
      ({ data: { receivedMessages = [] } } = await clients.pubsub.projects.subscriptions.pull({
        subscription,
        // Don't wait for messages to arrive: report what's there now
        requestBody: { maxMessages: rules.DEAD_LETTER_PEEK_MAX, returnImmediately: true },
      }));
    } catch (err) {
      results.push(problem(CHECK, resource, "pubsub_dead_letter_unreadable", `Can't read the subscription: ${err.message}`));
      continue;
    }
    if (!receivedMessages.length) {
      results.push(ok(CHECK, resource, `nothing dead-lettered (gives up after ${maxDeliveryAttempts} attempts)`));
      continue;
    }
    await clients.pubsub.projects.subscriptions.modifyAckDeadline({
      subscription,
      requestBody: { ackIds: receivedMessages.map((m) => m.ackId), ackDeadlineSeconds: 0 },
    });
    const files = [...new Set(receivedMessages.map((m) => messagePayload(m.message).sourceFileName || "(unknown file)"))];
    const count = receivedMessages.length >= rules.DEAD_LETTER_PEEK_MAX ? `${receivedMessages.length}+` : `${receivedMessages.length}`;
    results.push(problem(CHECK, resource, "pubsub_dead_lettered",
      `${count} translation request(s) failed every attempt and were set aside: ${files.join(", ")}`));
  }
  return results;
}

module.exports = { checkDriveFolders, checkStatutes, checkPubSub, foldersToCheck };
