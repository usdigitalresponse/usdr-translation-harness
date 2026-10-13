// Every input problem shares this message prefix and the input_problem field,
// so one log-based alert can catch them all. These entries deliberately have no
// pipeline_stage field: the pipeline_stage_status metric counts every entry
// that has one as a stage execution.
const INPUT_PROBLEM_PREFIX = "Translation input problem";

const INPUT_GLOSSARY = "glossary";
const INPUT_STATUTES = "statutes";
const INPUT_MODEL_CONFIG = "model_config";

/**
 * Log a problem with an input the pipeline depends on (glossary, statutes,
 * Model Config sheet) as a structured ERROR. For optional inputs translation
 * continues without them, so this log is the only signal that the prompt is
 * missing something.
 *
 * @param {string} input - Which input (one of the INPUT_* constants)
 * @param {string} detail - What's wrong, in words an operator can act on
 * @param {Object} [fields] - Extra structured fields
 */
function logInputProblem(input, detail, fields = {}) {
  console.log(JSON.stringify({
    severity: "ERROR",
    message: `${INPUT_PROBLEM_PREFIX} (${input}): ${detail}`,
    input_problem: input,
    ...fields,
  }));
}

module.exports = {
  logInputProblem,
  INPUT_PROBLEM_PREFIX,
  INPUT_GLOSSARY,
  INPUT_STATUTES,
  INPUT_MODEL_CONFIG,
};
