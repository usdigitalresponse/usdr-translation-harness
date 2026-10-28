const { DOC_ID_ENV_PATTERN } = require("../rules");
const { ok, problem } = require("../results");

const CHECK = "Prompt and rubric docs";
// Services read rubric tables too (eval/quality/quality_loaders.py); prompt
// loaders read paragraphs only (translate/loaders.js loadDoc), so a prompt
// moved into a table would reach the model empty.
const READS_TABLES = /_RUBRIC_DOC_ID/;

function paragraphText(elements) {
  let text = "";
  for (const el of elements || []) {
    for (const run of (el.paragraph && el.paragraph.elements) || []) {
      if (run.textRun) text += run.textRun.content;
    }
  }
  return text;
}

function structuralText(elements) {
  let text = paragraphText(elements);
  for (const el of elements || []) {
    for (const row of (el.table && el.table.tableRows) || []) {
      for (const cell of row.tableCells || []) text += structuralText(cell.content);
    }
  }
  return text;
}

/**
 * Every prompt/rubric doc any service is configured with, deduplicated by doc
 * ID. A list, so per-department prompts are checked without code changes.
 *
 * @returns {Array<{docId: string, readsTables: boolean, usedBy: string[]}>}
 */
function docsToCheck(settings) {
  const byId = new Map();
  for (const [service, s] of Object.entries(settings)) {
    for (const [name, value] of Object.entries(s.env || {})) {
      if (!DOC_ID_ENV_PATTERN.test(name) || !value) continue;
      const entry = byId.get(value) || { docId: value, readsTables: false, usedBy: [] };
      entry.readsTables = entry.readsTables || READS_TABLES.test(name);
      entry.usedBy.push(`${service} ${name}`);
      byId.set(value, entry);
    }
  }
  return [...byId.values()];
}

/**
 * Check 2: each prompt and rubric doc opens and has text.
 *
 * @param {{settings: Object, clients: {docs: Object}}} ctx
 */
async function checkDocs({ settings, clients }) {
  const results = [];
  for (const { docId, readsTables, usedBy } of docsToCheck(settings)) {
    const label = usedBy.join(", ");
    let data;
    try {
      ({ data } = await clients.docs.documents.get({ documentId: docId }));
    } catch (err) {
      results.push(problem(CHECK, label, "doc_unreadable", `Can't open doc ${docId}: ${err.message}`));
      continue;
    }
    const resource = `'${data.title}' (${label})`;
    const content = (data.body || {}).content;
    const text = (readsTables ? structuralText(content) : paragraphText(content)).trim();
    results.push(text
      ? ok(CHECK, resource, `${text.length} characters`)
      : problem(CHECK, resource, "doc_empty",
        readsTables ? "The doc has no text." : "The doc has no paragraph text (text inside tables isn't read)."));
  }
  return results;
}

module.exports = { checkDocs, docsToCheck };
