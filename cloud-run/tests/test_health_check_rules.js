// health-check deploys on its own, so it keeps copies of the rules the services
// enforce. These tests fail when a copy drifts from the code that owns it.

const fs = require("fs");
const path = require("path");

const rules = require("../health-check/rules");
const { GLOSSARY_COLUMNS, DEFAULT_GLOSSARY_SHEET_TAB, GLOSSARY_SHEET_COLUMNS } = require("../translate/prompt-assembly");
const { REFINEMENT_LOG_HEADERS } = require("../capture-feedback/glossary-writer");
const { TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES } = require("../capture-feedback/decisions");

const REPO = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf-8");

/** Value of a string constant in a source file, e.g. const X = "y" or X = "y". */
function stringConstant(rel, name) {
  const match = read(rel).match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  if (!match) throw new Error(`${name} not found in ${rel}`);
  return match[1];
}

describe("health-check rules match the services", () => {
  test("glossary columns and default tab match Translate", () => {
    const translateRequired = Object.values(GLOSSARY_COLUMNS).filter((c) => c !== GLOSSARY_COLUMNS.STATUS);
    expect(rules.GLOSSARY_REQUIRED_COLUMNS).toEqual(translateRequired);
    expect(rules.GLOSSARY_ENGLISH_TERM).toBe(GLOSSARY_COLUMNS.ENGLISH_TERM);
    expect(rules.DEFAULT_GLOSSARY_SHEET_TAB).toBe(DEFAULT_GLOSSARY_SHEET_TAB);
    expect(rules.GLOSSARY_SHEET_COLUMNS).toBe(GLOSSARY_SHEET_COLUMNS);
  });

  test("Model Config range, columns and active value match Translate", () => {
    const src = "cloud-run/translate/loaders.js";
    expect(rules.MODEL_CONFIG_SHEET_RANGE).toBe(stringConstant(src, "MODEL_CONFIG_SHEET_RANGE"));
    expect(rules.MODEL_CONFIG_ACTIVE_YES).toBe(stringConstant(src, "ACTIVE_YES"));
    const columns = ["COL_ROLE", "COL_PROVIDER", "COL_MODEL", "COL_ACTIVE"].map((c) => stringConstant(src, c));
    expect(rules.MODEL_CONFIG_REQUIRED_COLUMNS).toEqual(columns);
  });

  test("each service's Model Config role matches the service", () => {
    expect(rules.SERVICE_ROLES.translate).toBe(stringConstant("cloud-run/translate/index.js", "TRANSLATE_ROLE"));
    expect(rules.SERVICE_ROLES.extract).toBe(stringConstant("cloud-run/extract/main.py", "EXTRACT_ROLE"));
    expect(rules.SERVICE_ROLES["plain-language-eval"]).toBe(stringConstant("cloud-run/plain-language-eval/index.js", "EVAL_ROLE"));
    expect(rules.SERVICE_ROLES["eval-quality"]).toBe(stringConstant("cloud-run/eval/quality/main.py", "EVAL_ROLE"));
  });

  test("Processing Log tab and headers match the Orchestrator", () => {
    const src = read("apps-script/orchestrator/orchestrator.js");
    const block = src.match(/var PROCESSING_LOG_HEADERS = \[([\s\S]*?)\];/)[1];
    const headers = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rules.PROCESSING_LOG_HEADERS).toEqual(headers);
    expect(rules.PROCESSING_LOG_TAB).toBe(stringConstant("cloud-run/translate/loaders.js", "PROCESSING_LOG_TAB_NAME"));
  });

  test("Orchestrator statuses that carry Submitted By exist in the Orchestrator", () => {
    const src = read("apps-script/orchestrator/orchestrator.js");
    expect(rules.ORCHESTRATOR_STATUSES).toEqual([
      src.match(/\bTRIGGERED: "([^"]+)"/)[1],
      src.match(/PL_EVAL_TRIGGERED: "([^"]+)"/)[1],
    ]);
  });

  test("refinement log tabs and headers match Capture Feedback", () => {
    expect(rules.REFINEMENT_LOG_HEADERS).toEqual(REFINEMENT_LOG_HEADERS);
    expect(rules.REFINEMENT_LOG_TABS).toEqual([TAB_REVIEWED, TAB_MODEL_FLAGGED, TAB_OTHER_CHANGES]);
  });

  test("eval results tab and headers match Eval Quality", () => {
    const src = read("cloud-run/eval/quality/quality_loaders.py");
    expect(rules.EVAL_RESULTS_TAB).toBe(stringConstant("cloud-run/eval/quality/quality_loaders.py", "EVAL_RESULTS_SHEET_NAME"));
    const block = src.match(/EVAL_RESULTS_HEADERS = \[([\s\S]*?)\]/)[1];
    const headers = [...block.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
    expect(rules.EVAL_RESULTS_HEADERS).toEqual(headers);
  });

  test("statutes default prefix and file types match Translate", () => {
    const src = read("cloud-run/translate/loaders.js");
    expect(src).toContain(`process.env.STATUTES_GCS_PREFIX || "${rules.DEFAULT_STATUTES_PREFIX}"`);
    for (const ext of rules.STATUTE_FILE_EXTENSIONS) expect(src).toContain(`f.endsWith("${ext}")`);
  });

  test("Pub/Sub topic setting matches Extract", () => {
    expect(rules.PUBSUB_TOPIC_ENV).toBe(stringConstant("cloud-run/extract/main.py", "PUBSUB_TOPIC_ENV_VAR"));
  });

  test("required env vars are ones the services actually read", () => {
    const sources = {
      extract: ["cloud-run/extract/main.py", "cloud-run/extract/loaders.py"],
      translate: ["cloud-run/translate/index.js", "cloud-run/translate/loaders.js",
        "cloud-run/translate/prompt-assembly.js", "cloud-run/translate/notifier.js"],
      "plain-language-eval": ["cloud-run/plain-language-eval/index.js", "cloud-run/plain-language-eval/loaders.js"],
      "eval-quality": ["cloud-run/eval/quality/main.py", "cloud-run/eval/quality/quality_loaders.py"],
      "capture-feedback": ["cloud-run/capture-feedback/index.js", "cloud-run/capture-feedback/glossary-writer.js",
        "cloud-run/capture-feedback/loaders.js"],
    };
    for (const [service, envVars] of Object.entries(rules.SERVICES)) {
      const code = sources[service].map(read).join("\n");
      for (const envVar of envVars) {
        expect({ service, envVar, found: code.includes(envVar) }).toEqual({ service, envVar, found: true });
      }
    }
  });
});
