// Every input problem shares this message prefix and the input_problem field,
// so one log-based alert can catch them all. These entries deliberately have no
// pipeline_stage field: the pipeline_stage_status metric counts every entry
// that has one as a stage execution.
const INPUT_PROBLEM_PREFIX = "Capture feedback input problem";

const INPUT_REFINEMENT_LOG = "refinement_log";

/**
 * Log a problem with a resource the pipeline depends on (the refinement log
 * sheet) as a structured ERROR. Feedback capture continues without it, so this
 * log is the only signal that reviewer decisions weren't recorded.
 *
 * @param {string} input - Which resource (one of the INPUT_* constants)
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
  INPUT_REFINEMENT_LOG,
};
