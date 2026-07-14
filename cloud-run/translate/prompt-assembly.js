const fs = require("fs");
const path = require("path");

const { loadDoc, loadSheet, loadExtractionJson } = require("./loaders");

const CONTENT_PLACEHOLDER = "[Paste content to be translated in the area below]";
const PDF_EXTRACTION_CONTEXT = fs.readFileSync(
  path.join(__dirname, "extraction-context.md"),
  "utf-8"
);
const TEXT_EXTRACTION_CONTEXT =
  "The content below is structured text from a document. " +
  "Each block contains a paragraph. Translate blocks where " +
  '"translate" is true. Preserve block IDs in your response.';
const DEFAULT_GLOSSARY_SHEET_TAB = "Glossary";
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
 * Load all inputs and assemble the full translation prompt.
 *
 * Loads the base prompt from the Google Doc, the glossary from Google Sheets,
 * and the extraction JSON from Drive, then combines them into:
 *   1. Base prompt (with content placeholder stripped)
 *   2. Extraction context (explains the JSON structure to the LLM)
 *   3. Extraction JSON (full structured output from the extract function)
 *   4. Glossary (terminology reference with approved translations and constraints)
 */
async function buildTranslationPrompt(extractionFileId) {
  console.log("Loading extraction JSON...");
  const extractionJson = await loadExtractionJson(extractionFileId);

  console.log("Loading base prompt from Google Doc...");
  const basePrompt = await loadDoc("TRANSLATION_PROMPT_DOC_ID");

  let glossaryText = "";
  try {
    console.log("Loading glossary...");
    const tab = process.env.GLOSSARY_SHEET_TAB || DEFAULT_GLOSSARY_SHEET_TAB;
    const glossaryRows = await loadSheet("GLOSSARY_SHEET_ID", `${tab}!${GLOSSARY_SHEET_COLUMNS}`);
    glossaryText = formatGlossary(glossaryRows);
    console.log(`Glossary loaded (${glossaryRows.length} entries)`);
  } catch (err) {
    console.warn("Could not load glossary, proceeding without:", err.message);
  }

  let prompt = basePrompt.replace(CONTENT_PLACEHOLDER, "").trimEnd();

  const extractionContext = extractionJson.sourceType === "text"
    ? TEXT_EXTRACTION_CONTEXT
    : PDF_EXTRACTION_CONTEXT;
  prompt += `\n\n<extraction_context>\n${extractionContext}</extraction_context>`;

  const extractionStr = JSON.stringify(extractionJson, null, 2);
  prompt += `\n\n<extraction>\n${extractionStr}\n</extraction>`;

  if (glossaryText) {
    prompt += `\n\n<glossary>\n${glossaryText}\n</glossary>`;
  }

  console.log(`Prompt assembled (${prompt.length} chars)`);
  return prompt;
}

module.exports = {
  GLOSSARY_COLUMNS,
  DEFAULT_GLOSSARY_SHEET_TAB,
  GLOSSARY_SHEET_COLUMNS,
  formatGlossaryEntry,
  formatGlossary,
  buildTranslationPrompt,
};
