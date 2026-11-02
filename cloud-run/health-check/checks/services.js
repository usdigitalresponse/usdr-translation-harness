const { SERVICES, MODEL_CONFIG_SHEET_ENV, PROCESSING_LOG_SHEET_ENV } = require("../rules");
const { ok, problem } = require("../results");
const { valuesOf } = require("../settings");

const CHECK = "Services";
const HTTP_FORBIDDEN = 403;
const FULL_TRAFFIC = 100;
const TRAFFIC_LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
// Settings several services share; they must all point at the same resource
const SHARED_SETTINGS = [MODEL_CONFIG_SHEET_ENV, PROCESSING_LOG_SHEET_ENV];

/**
 * True when all traffic goes to the latest ready revision, either through the
 * "latest" target or by naming that revision.
 */
function servesLatest(s) {
  return s.trafficStatuses.some(
    (t) => t.percent === FULL_TRAFFIC &&
      (t.type === TRAFFIC_LATEST || t.revision === s.latestReadyRevision)
  );
}

/**
 * Check 1: each service is deployed, its latest deploy started, it gets all
 * the traffic, and its required settings are set. Also that services sharing a
 * sheet point at the same one.
 *
 * @param {{settings: Object}} ctx
 * @returns {Promise<Object[]>} results
 */
async function checkServices({ settings }) {
  const results = [];

  for (const [svc, requiredEnv] of Object.entries(SERVICES)) {
    const s = settings[svc];
    const resource = `${svc} service`;

    if (s.errorStatus === HTTP_FORBIDDEN) {
      results.push(problem(CHECK, resource, "settings_unreadable", `Can't read the service's settings (${s.error}).`));
      continue;
    }
    if (!s.found) {
      results.push(problem(CHECK, resource, "service_missing", "No Cloud Run service with this name in this project and region."));
      continue;
    }
    if (s.error) {
      results.push(problem(CHECK, resource, "settings_unreadable", `Can't read the service's settings (${s.error}).`));
      continue;
    }

    const found = [];
    if (s.latestCreatedRevision !== s.latestReadyRevision) {
      found.push(problem(CHECK, resource, "service_not_ready",
        `The newest revision (${s.latestCreatedRevision}) never became ready; still running ${s.latestReadyRevision}.`));
    }
    if (!servesLatest(s)) {
      found.push(problem(CHECK, resource, "traffic_not_latest",
        `Traffic isn't all going to the latest revision (${s.latestReadyRevision}).`));
    }
    for (const name of requiredEnv) {
      if (!s.env[name]) {
        found.push(problem(CHECK, resource, "env_var_missing", `${name} isn't set.`));
      }
    }
    results.push(...(found.length ? found : [ok(CHECK, resource, `serving ${s.latestReadyRevision}`)]));
  }

  for (const envName of SHARED_SETTINGS) {
    const values = valuesOf(settings, envName);
    const distinct = new Set(values.map((v) => v.value));
    if (distinct.size > 1) {
      const list = values.map((v) => `${v.service}: ${v.value}`).join("; ");
      results.push(problem(CHECK, envName, "setting_mismatch", `Services point at different sheets (${list}).`));
    }
  }

  return results;
}

module.exports = { checkServices };
