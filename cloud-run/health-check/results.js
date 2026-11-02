// Every check returns a list of results built with these helpers. A result
// names one specific resource (a sheet tab, a doc, a service), so messages stay
// clear when there are several of the same kind.

const STATUS_OK = "ok";
const STATUS_PROBLEM = "problem";

/**
 * @param {string} check - Check name, e.g. "Glossary"
 * @param {string} resource - The specific resource, e.g. "'FAMLI Spanish Glossary' tab"
 * @param {string} [detail] - What was found, for the log
 */
function ok(check, resource, detail = "") {
  return { check, resource, status: STATUS_OK, detail };
}

/**
 * @param {string} check - Check name
 * @param {string} resource - The specific resource
 * @param {string} code - Problem code, a key of WHAT_TO_DO in runbook.js
 * @param {string} detail - What's wrong, in words an operator can act on
 */
function problem(check, resource, code, detail) {
  return { check, resource, status: STATUS_PROBLEM, code, detail };
}

module.exports = { ok, problem, STATUS_OK, STATUS_PROBLEM };
