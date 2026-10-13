const fs = require("fs");
const path = require("path");

const { loadDoc, loadSheetTable, loadExtractionJson, loadStatutes } = require("./loaders");

const CONTENT_PLACEHOLDER = "[Paste content to be translated in the area below]";
const DEFAULT_CONTENT_TYPE = "public_flyer";
const PROMPT_DOC_ENV_VARS = {
  public_flyer: "TRANSLATION_PROMPT_DOC_ID",
  content_type_two: "TRANSLATION_PROMPT_DOC_ID_CONTENT_TYPE_TWO",
};
const CHARS_PER_TOKEN_ESTIMATE = 4;
const PDF_EXTRACTION_CONTEXT = fs.readFileSync(
  path.join(__dirname, "extraction-context.md"),
  "utf-8"
);
const TEXT_EXTRACTION_CONTEXT =
  "The content below is structured text from a document. " +
  "Each block contains a paragraph. Translate blocks where " +
  '"translate" is true. Preserve block IDs in your response.';
const DEFAULT_GLOSSARY_SHEET_TAB = "FAMLI Spanish Glossary";
const GLOSSARY_SHEET_COLUMNS = "A:I";

/**
 * Column headers in the FAMLI Glossary sheet, mapped to the keys returned
 * by loadSheet() (which lowercases and trims headers).
 */
const GLOSSARY_COLUMNS = {
  ENGLISH_TERM: "english term",
  ACRONYM: "acronym or abbreviation",
  APPROVED_SPANISH: "approved spanish",
  FORBIDDEN_TERMS: "forbidden terms",
  DEFINITION: "definition/context",
  EXAMPLE_ENGLISH: "example english",
  EXAMPLE_SPANISH: "example spanish",
  NOTES: "notes",
  STATUS: "status",
};

// Columns formatGlossaryEntry reads. A missing one means that field silently
// drops out of every entry (or, for English Term, every entry drops out).
const GLOSSARY_COLUMNS_USED = Object.values(GLOSSARY_COLUMNS).filter(
  (column) => column !== GLOSSARY_COLUMNS.STATUS
);

// Every input problem shares this message prefix and the input_problem field,
// so one log-based alert can catch them all.
const INPUT_PROBLEM_PREFIX = "Translation input problem";
const INPUT_GLOSSARY = "glossary";

/**
 * Log a problem with a supplemental prompt input (glossary, etc.) as a
 * structured ERROR. Translation continues without that input, so this log is
 * the only signal that the prompt is missing something.
 *
 * @param {string} input - Which input (e.g. "glossary")
 * @param {string} detail - What's wrong, in words an operator can act on
 * @param {Object} [fields] - Extra structured fields
 */
function logInputProblem(input, detail, fields = {}) {
  console.error(JSON.stringify({
    severity: "ERROR",
    message: `${INPUT_PROBLEM_PREFIX} (${input}): ${detail}`,
    pipeline_stage: "translate",
    input_problem: input,
    ...fields,
  }));
}

/**
 * Format a single glossary entry into a readable block for the LLM.
 * Only includes fields that have values.
 */
function formatGlossaryEntry(row) {
  const term = row[GLOSSARY_COLUMNS.ENGLISH_TERM] || "";
  if (!term) return null;

  const parts = [term];

  const acronym = row[GLOSSARY_COLUMNS.ACRONYM];
  if (acronym) {
    parts[0] += ` (${acronym})`;
  }

  const approved = row[GLOSSARY_COLUMNS.APPROVED_SPANISH];
  if (approved) {
    parts.push(`  Approved Spanish: ${approved}`);
  }

  const forbidden = row[GLOSSARY_COLUMNS.FORBIDDEN_TERMS];
  if (forbidden) {
    parts.push(`  Forbidden: ${forbidden}`);
  }

  const definition = row[GLOSSARY_COLUMNS.DEFINITION];
  if (definition) {
    parts.push(`  Definition: ${definition}`);
  }

  const exEnglish = row[GLOSSARY_COLUMNS.EXAMPLE_ENGLISH];
  const exSpanish = row[GLOSSARY_COLUMNS.EXAMPLE_SPANISH];
  if (exEnglish && exSpanish) {
    parts.push(`  Example: "${exEnglish}" → "${exSpanish}"`);
  }

  const notes = row[GLOSSARY_COLUMNS.NOTES];
  if (notes) {
    parts.push(`  Notes: ${notes}`);
  }

  return parts.join("\n");
}

/**
 * Format statute entries into a single text block with section-level XML tags.
 */
function formatStatutes(statutes) {
  if (!statutes?.length) {
    return "";
  }

  return statutes
    .map((s) => `<statute section="${s.section}">\n${s.body}\n</statute>`)
    .join("\n\n");
}

/**
 * Format glossary rows into a text block for inclusion in the translation prompt.
 * Returns an empty string if the glossary is empty or has no valid entries.
 */
function formatGlossary(glossaryRows) {
  if (!glossaryRows?.length) {
    return "";
  }

  return glossaryRows
    .map(formatGlossaryEntry)
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the glossary prompt section from a loaded sheet table, with counts of
 * what actually made it in.
 *
 * @param {{headers: string[], rows: Object[]}} table - From loadSheetTable
 * @returns {{text: string, included: number, withForbidden: number,
 *            skippedRows: number, missingColumns: string[]}}
 *   included: entries in the prompt; withForbidden: of those, entries with
 *   forbidden terms; skippedRows: non-blank rows dropped for having no English
 *   term; missingColumns: expected headers not found in row 1
 */
function buildGlossary({ headers, rows }) {
  const normalizedHeaders = headers.map((h) => h.toLowerCase());
  const missingColumns = GLOSSARY_COLUMNS_USED.filter(
    (column) => !normalizedHeaders.includes(column)
  );

  const hasTerm = (row) => Boolean(row[GLOSSARY_COLUMNS.ENGLISH_TERM]);
  const entries = rows.map(formatGlossaryEntry).filter(Boolean);
  const withForbidden = rows.filter(
    (row) => hasTerm(row) && row[GLOSSARY_COLUMNS.FORBIDDEN_TERMS]
  ).length;
  const skippedRows = rows.filter(
    (row) => !hasTerm(row) && Object.values(row).some(Boolean)
  ).length;

  return {
    text: entries.join("\n\n"),
    included: entries.length,
    withForbidden,
    skippedRows,
    missingColumns,
  };
}

/**
 * Load the glossary and log what was included, or an input problem if the
 * sheet can't be read, its header row isn't as expected, or no entries made it
 * into the prompt. Never throws: translation proceeds without a glossary.
 *
 * @returns {Promise<{text: string, included: number, withForbidden: number}>}
 */
async function loadGlossary() {
  const tab = process.env.GLOSSARY_SHEET_TAB || DEFAULT_GLOSSARY_SHEET_TAB;
  console.log(`Loading glossary ("${tab}" tab)...`);

  let table;
  try {
    table = await loadSheetTable("GLOSSARY_SHEET_ID", `${tab}!${GLOSSARY_SHEET_COLUMNS}`);
  } catch (err) {
    logInputProblem(INPUT_GLOSSARY, `could not load the "${tab}" tab: ${err.message}`);
    return { text: "", included: 0, withForbidden: 0 };
  }

  const glossary = buildGlossary(table);

  if (glossary.missingColumns.length) {
    logInputProblem(
      INPUT_GLOSSARY,
      `the "${tab}" tab is missing expected columns: ${glossary.missingColumns.join(", ")}. ` +
        "Row 1 must be the header row, with these exact column names.",
      { missing_columns: glossary.missingColumns, found_headers: table.headers }
    );
  }

  if (!glossary.included) {
    logInputProblem(
      INPUT_GLOSSARY,
      `no glossary entries were included in the prompt (${table.rows.length} rows read from the "${tab}" tab)`,
      { rows_read: table.rows.length }
    );
  }

  console.log(
    `Glossary: ${glossary.included} entries included in the prompt ` +
      `(${glossary.withForbidden} with forbidden terms; ` +
      `${glossary.skippedRows} rows skipped with no English term; ` +
      `${table.rows.length} rows read)`
  );
  return glossary;
}

/**
 * Load all inputs and assemble the full translation prompt.
 *
 * Loads the base prompt from the Google Doc, the glossary from Google Sheets,
 * and the extraction JSON from Drive, then combines them into:
 *   1. Base prompt (with content placeholder stripped)
 *   2. Extraction context (explains the JSON structure to the LLM)
 *   3. Extraction JSON (full structured output from the extract function)
 *   4. Glossary (terminology reference with approved translations and constraints)
 */
async function buildTranslationPrompt(extractionFileId, contentType, { includeStatutes = true } = {}) {
  console.log("Loading extraction JSON...");
  const extractionJson = await loadExtractionJson(extractionFileId);

  const promptEnvVar = PROMPT_DOC_ENV_VARS[contentType] || PROMPT_DOC_ENV_VARS[DEFAULT_CONTENT_TYPE];
  console.log("Loading base prompt from Google Doc (%s)...", promptEnvVar);
  const basePrompt = await loadDoc(promptEnvVar);

  const glossary = await loadGlossary();
  const glossaryText = glossary.text;

  let statutesText = "";
  if (includeStatutes) {
    try {
      console.log("Loading statutes...");
      const statutes = await loadStatutes();
      statutesText = formatStatutes(statutes);
      if (statutes.length) {
        console.log(`Statutes loaded (${statutes.length} sections)`);
      } else {
        console.log("No statute files found, proceeding without");
      }
    } catch (err) {
      console.warn("Could not load statutes, proceeding without:", err.message);
    }
  }

  const promptBase = basePrompt.replace(CONTENT_PLACEHOLDER, "").trimEnd();

  const extractionContext = extractionJson.sourceType === "text"
    ? TEXT_EXTRACTION_CONTEXT
    : PDF_EXTRACTION_CONTEXT;

  const extractionStr = JSON.stringify(extractionJson, null, 2);

  let prompt = promptBase;
  prompt += `\n\n<extraction_context>\n${extractionContext}</extraction_context>`;
  prompt += `\n\n<extraction>\n${extractionStr}\n</extraction>`;

  if (glossaryText) {
    prompt += `\n\n<glossary>\n${glossaryText}\n</glossary>`;
  }

  if (statutesText) {
    prompt += `\n\n<statutes>\n${statutesText}\n</statutes>`;
  }

  const promptTokenEstimate = Math.ceil(promptBase.length / CHARS_PER_TOKEN_ESTIMATE);
  const extractionTokenEstimate = Math.ceil(extractionStr.length / CHARS_PER_TOKEN_ESTIMATE);
  const glossaryTokenEstimate = glossaryText
    ? Math.ceil(glossaryText.length / CHARS_PER_TOKEN_ESTIMATE)
    : 0;
  const statutesTokenEstimate = statutesText
    ? Math.ceil(statutesText.length / CHARS_PER_TOKEN_ESTIMATE)
    : 0;

  const promptMetrics = {
    prompt_template_tokens: promptTokenEstimate,
    extraction_tokens: extractionTokenEstimate,
    glossary_tokens: glossaryTokenEstimate,
    glossary_entries: glossary.included,
    glossary_entries_with_forbidden: glossary.withForbidden,
    statutes_tokens: statutesTokenEstimate,
    total_prompt_chars: prompt.length,
  };

  console.log(`Prompt assembled (${prompt.length} chars)`);
  return { prompt, promptMetrics };
}

module.exports = {
  GLOSSARY_COLUMNS,
  DEFAULT_GLOSSARY_SHEET_TAB,
  GLOSSARY_SHEET_COLUMNS,
  formatGlossaryEntry,
  formatGlossary,
  buildGlossary,
  formatStatutes,
  buildTranslationPrompt,
};
