// Reads each pipeline service's live configuration from the Cloud Run Admin API
// (https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/get),
// so the checks test what's actually deployed rather than a copy of the IDs.

const { STATUS_CODES } = require("http");

const HTTP_NOT_FOUND = 404;
// Env vars set from Secret Manager have no readable value here; they count as set
const FROM_SECRET = "(from Secret Manager)";

/**
 * Short revision name from a full resource name
 * ("projects/p/locations/r/services/s/revisions/s-00012-abc" -> "s-00012-abc").
 */
function shortName(resourceName) {
  return (resourceName || "").split("/").pop();
}

/**
 * Env vars of a service's first container, as { NAME: value }.
 */
function envOf(service) {
  const container = ((service.template || {}).containers || [])[0] || {};
  const env = {};
  for (const v of container.env || []) {
    env[v.name] = v.valueSource ? FROM_SECRET : (v.value ?? "");
  }
  return env;
}

/**
 * Load the deployed configuration of each named service.
 *
 * @param {Object} run - googleapis Cloud Run v2 client
 * @param {string} project - GCP project ID
 * @param {string} region - Cloud Run region
 * @param {string[]} serviceNames
 * @returns {Promise<Object<string, {found: boolean, error?: string, errorStatus?: number,
 *   env?: Object<string,string>, latestCreatedRevision?: string,
 *   latestReadyRevision?: string, trafficStatuses?: Object[]}>>}
 */
async function loadServiceSettings(run, project, region, serviceNames) {
  const settings = {};
  for (const svc of serviceNames) {
    const name = `projects/${project}/locations/${region}/services/${svc}`;
    try {
      const { data } = await run.projects.locations.services.get({ name });
      settings[svc] = {
        found: true,
        env: envOf(data),
        latestCreatedRevision: shortName(data.latestCreatedRevision),
        latestReadyRevision: shortName(data.latestReadyRevision),
        trafficStatuses: data.trafficStatuses || [],
      };
    } catch (err) {
      const status = err.code || (err.response && err.response.status);
      settings[svc] = {
        found: status !== HTTP_NOT_FOUND,
        errorStatus: status,
        error: `${status ? `${status} ${STATUS_CODES[status] ?? ""}`.trim() + ": " : ""}${err.message}`,
      };
    }
  }
  return settings;
}

/**
 * Collect the value of one env var across services, skipping services where it
 * isn't set.
 *
 * @returns {Array<{service: string, value: string}>}
 */
function valuesOf(settings, envName) {
  return Object.entries(settings)
    .filter(([, s]) => s.env && s.env[envName])
    .map(([service, s]) => ({ service, value: s.env[envName] }));
}

module.exports = { loadServiceSettings, valuesOf, shortName, FROM_SECRET };
