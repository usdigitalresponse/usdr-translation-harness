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
    }
  }
  return results;
}

module.exports = { checkDriveFolders, checkStatutes, checkPubSub, foldersToCheck };
