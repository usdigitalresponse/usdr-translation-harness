// Every input problem shares this message prefix and the input_problem field,
// so one log-based alert can catch them all. These entries deliberately have no
// pipeline_stage field: the pipeline_stage_status metric counts every entry
// that has one as a stage execution.
const INPUT_PROBLEM_PREFIX = "Plain language eval input problem";

const INPUT_MODEL_CONFIG = "model_config";

/**
 * Log a problem with an input the pipeline depends on (Model Config sheet)
 * as a structured ERROR, with the input_problem field used for alerting.
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
  INPUT_MODEL_CONFIG,
};
