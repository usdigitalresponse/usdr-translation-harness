const { runChecks } = require("../health-check/run-checks");
const { formatReport } = require("../health-check/report");
const { WHAT_TO_DO } = require("../health-check/runbook");
const { cellTime } = require("../health-check/checks/sheets");
const rules = require("../health-check/rules");

const PROJECT = "proj";
const REGION = "us-central1";
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const toSerial = (ms) => (ms - SHEETS_EPOCH_MS) / MS_PER_DAY;

const IDS = {
  extractPrompt: "doc-extract",
  translatePrompt: "doc-translate",
  plPrompt: "doc-pl",
  rubric: "doc-rubric",
  glossary: "sheet-glossary",
  modelConfig: "sheet-config",
  processingLog: "sheet-log",
  refinementLog: "sheet-refine",
};

// ── Fakes ────────────────────────────────────────────────────────────────

function baseEnv() {
  return {
    extract: {
      EXTRACTION_PROMPT_DOC_ID: IDS.extractPrompt, DRIVE_EXTRACTION_JSON_FOLDER_ID: "f1",
      MODEL_CONFIG_SHEET_ID: IDS.modelConfig, PROCESSING_LOG_SHEET_ID: IDS.processingLog,
      PUBSUB_TOPIC_EXTRACTION_COMPLETE: "projects/proj/topics/extraction-complete",
    },
    translate: {
      TRANSLATION_PROMPT_DOC_ID: IDS.translatePrompt, GLOSSARY_SHEET_ID: IDS.glossary,
      DRIVE_TRANSLATION_JSON_FOLDER_ID: "f2", DRIVE_TRANSLATION_DOC_STAGING_FOLDER_ID: "f3",
      DRIVE_TRANSLATION_DOC_FOLDER_ID: "f4", MODEL_CONFIG_SHEET_ID: IDS.modelConfig,
      PROCESSING_LOG_SHEET_ID: IDS.processingLog, STATUTES_GCS_BUCKET: "bucket",
      GOOGLE_CHAT_WEBHOOK_URL: { secret: true },
    },
    "plain-language-eval": {
      PLAIN_LANGUAGE_EVAL_PROMPT_DOC_ID: IDS.plPrompt, MODEL_CONFIG_SHEET_ID: IDS.modelConfig,
      PROCESSING_LOG_SHEET_ID: IDS.processingLog, DRIVE_PLAIN_LANGUAGE_EVAL_FOLDER_ID: "f5",
    },
    "eval-quality": {
      EVALUATION_RUBRIC_DOC_ID: IDS.rubric, MODEL_CONFIG_SHEET_ID: IDS.modelConfig,
      DRIVE_EVAL_RESULTS_FOLDER_ID: "f6", EVAL_QUALITY_RESULTS_SHEET_ID: "sheet-evals",
    },
    "capture-feedback": { DERIVED_GLOSSARY_SHEET_ID: IDS.refinementLog, DRIVE_FEEDBACK_FOLDER_ID: "f7" },
  };
}

function serviceResource(env, overrides = {}) {
  return {
    latestCreatedRevision: "projects/proj/locations/r/services/s/revisions/rev-2",
    latestReadyRevision: "projects/proj/locations/r/services/s/revisions/rev-2",
    trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
    template: {
      containers: [{
        env: Object.entries(env).map(([name, value]) =>
          value && value.secret
            ? { name, valueSource: { secretKeyRef: { secret: name, version: "latest" } } }
            : { name, value }),
      }],
    },
    ...overrides,
  };
}

const textDoc = (title, text) => ({
  title, body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] },
});
const tableOnlyDoc = (title, text) => ({
  title,
  body: { content: [{ table: { tableRows: [{ tableCells: [{ content: textDoc("", text).body.content }] }] } }] },
});

function baseSheets() {
  const glossaryHeader = ["English Term", "Acronym or Abbreviation", "Approved Spanish", "Forbidden Terms",
    "Definition/Context", "Example English", "Example Spanish", "Notes", "Status"];
  return {
    [`${IDS.glossary}|'FAMLI Spanish Glossary'!A:I`]: [glossaryHeader, ["leave", "", "licencia", "permiso"]],
    [`${IDS.modelConfig}|Config!A:F`]: [
      ["role", "provider", "model", "active"],
      ["extract", "anthropic", "claude-x", "YES"],
      ["translate", "anthropic", "claude-x", "yes"],
      ["plain-language-eval", "google", "gemini-x", "YES"],
      ["eval", "anthropic", "claude-x", "YES"],
    ],
    [`${IDS.processingLog}|'ProcessingLog'!A:L`]: [
      rules.PROCESSING_LOG_HEADERS,
      ["id1", "flyer.pdf", toSerial(NOW - 3600 * 1000), "triggered", 100, "", "", "", "", "a@md.gov"],
    ],
    ...Object.fromEntries(rules.REFINEMENT_LOG_TABS.map((tab) =>
      [`${IDS.refinementLog}|'${tab}'!1:1`, [rules.REFINEMENT_LOG_HEADERS]])),
    ["sheet-evals|'EvalQuality'!1:1"]: [rules.EVAL_RESULTS_HEADERS],
  };
}

const FOLDER = "application/vnd.google-apps.folder";
function baseFolders() {
  return Object.fromEntries(["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((id) =>
    [id, { id, name: `Folder ${id}`, mimeType: FOLDER, trashed: false, capabilities: { canAddChildren: true } }]));
}

const TOPIC = "projects/proj/topics/extraction-complete";
const SUBSCRIPTION = "projects/proj/subscriptions/eventarc-us-central1-extraction-to-translate-sub-123";
function basePubSub() {
  return { topics: { [TOPIC]: [SUBSCRIPTION] }, subscriptions: { [SUBSCRIPTION]: { ackDeadlineSeconds: 600 } } };
}

const badRange = (range) => Object.assign(new Error(`Unable to parse range: ${range}`), { code: 400 });

function fakeClients({
  env = baseEnv(), services = {}, docs, sheets = baseSheets(), runError = {},
  folders = baseFolders(), statuteFiles = ["statutes/md-labor-emply-t8.3/8.3-101.txt"],
  pubsub = basePubSub(), logEntries = [],
} = {}) {
  const docMap = docs || {
    [IDS.extractPrompt]: textDoc("Extract prompt", "Extract the text."),
    [IDS.translatePrompt]: textDoc("Translate prompt", "Translate it."),
    [IDS.plPrompt]: textDoc("PL prompt", "Evaluate it."),
    [IDS.rubric]: tableOnlyDoc("Rubric", "Score 1-5."),
  };
  return {
    run: {
      projects: { locations: { services: { get: jest.fn(async ({ name }) => {
        const svc = name.split("/").pop();
        if (runError[svc]) throw runError[svc];
        if (!env[svc]) throw Object.assign(new Error("not found"), { code: 404 });
        return { data: serviceResource(env[svc], services[svc]) };
      }) } } },
    },
    docs: { documents: { get: jest.fn(async ({ documentId }) => {
      if (!docMap[documentId]) throw new Error("Requested entity was not found.");
      return { data: docMap[documentId] };
    }) } },
    sheets: { spreadsheets: { values: { get: jest.fn(async ({ spreadsheetId, range }) => {
      const key = `${spreadsheetId}|${range}`;
      if (!(key in sheets)) throw badRange(range);
      return { data: { values: sheets[key] } };
    }) } } },
    drive: { files: { get: jest.fn(async ({ fileId }) => {
      if (!folders[fileId]) throw new Error("File not found");
      return { data: folders[fileId] };
    }) } },
    storage: { objects: { list: jest.fn(async ({ prefix }) => ({
      data: { items: statuteFiles.filter((n) => n.startsWith(prefix)).map((name) => ({ name })) },
    })) } },
    pubsub: { projects: {
      topics: {
        get: jest.fn(async ({ topic }) => {
          if (!pubsub.topics[topic]) throw new Error("Resource not found");
          return { data: { name: topic } };
        }),
        subscriptions: { list: jest.fn(async ({ topic }) => ({ data: { subscriptions: pubsub.topics[topic] } })) },
      },
      subscriptions: { get: jest.fn(async ({ subscription }) => ({ data: pubsub.subscriptions[subscription] })) },
    } },
    logging: { entries: { list: jest.fn(async ({ requestBody }) => ({
      data: { entries: logEntries.filter((e) => e.matches(requestBody.filter)) },
    })) } },
  };
}

async function run(opts) {
  return runChecks({ project: PROJECT, region: REGION, clients: fakeClients(opts) });
}

const codes = (outcome) => outcome.problems.map((p) => p.code);

// Fix "now" so the Processing Log 24-hour window is deterministic
beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => jest.restoreAllMocks());

// ── Tests ────────────────────────────────────────────────────────────────

describe("health check: everything configured", () => {
  test("no problems, and an all-clear message", async () => {
    const outcome = await run();
    expect(outcome.problems).toEqual([]);
    expect(formatReport(outcome, "USDR")).toMatch(/all clear/);
  });

  test("every problem code a check can produce has runbook text", () => {
    const source = require("fs").readdirSync(require("path").join(__dirname, "../health-check/checks"))
      .map((f) => require("fs").readFileSync(require("path").join(__dirname, "../health-check/checks", f), "utf-8"))
      .join("\n");
    const used = [...source.matchAll(/problem\([^)]*?"([a-z_]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const code of used) expect(WHAT_TO_DO).toHaveProperty(code);
  });
});

describe("Services check", () => {
  test("missing required env var", async () => {
    const env = baseEnv();
    delete env.translate.GOOGLE_CHAT_WEBHOOK_URL;
    const outcome = await run({ env });
    expect(codes(outcome)).toEqual(["env_var_missing"]);
    expect(outcome.problems[0].detail).toContain("GOOGLE_CHAT_WEBHOOK_URL");
  });

  test("service not deployed", async () => {
    const env = baseEnv();
    delete env["capture-feedback"];
    const outcome = await run({ env });
    expect(codes(outcome)).toContain("service_missing");
  });

  test("can't read settings (no Cloud Run Viewer role)", async () => {
    const outcome = await run({ runError: { extract: Object.assign(new Error("denied"), { code: 403 }) } });
    expect(codes(outcome)).toContain("settings_unreadable");
  });

  test("latest deploy never became ready, and traffic pinned to an old revision", async () => {
    const outcome = await run({ services: { translate: {
      latestCreatedRevision: "x/revisions/rev-3",
      trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "rev-1", percent: 100 }],
    } } });
    expect(codes(outcome)).toEqual(["service_not_ready", "traffic_not_latest"]);
  });

  test("traffic pinned to the latest revision by name counts as serving latest", async () => {
    const outcome = await run({ services: { translate: {
      trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "rev-2", percent: 100 }],
    } } });
    expect(outcome.problems).toEqual([]);
  });

  test("services pointing at different Model Config sheets", async () => {
    const env = baseEnv();
    env.extract.MODEL_CONFIG_SHEET_ID = "sheet-other";
    const sheets = { ...baseSheets(), "sheet-other|Config!A:F": baseSheets()[`${IDS.modelConfig}|Config!A:F`] };
    const outcome = await run({ env, sheets });
    expect(codes(outcome)).toEqual(["setting_mismatch"]);
  });
});

describe("Prompt and rubric docs check", () => {
  test("doc the service account can't open", async () => {
    const outcome = await run({ docs: {
      [IDS.translatePrompt]: textDoc("T", "x"), [IDS.plPrompt]: textDoc("P", "x"),
      [IDS.rubric]: textDoc("R", "x"),
    } });
    expect(codes(outcome)).toEqual(["doc_unreadable"]);
    expect(outcome.problems[0].resource).toContain("EXTRACTION_PROMPT_DOC_ID");
  });

  test("prompt whose text is only inside a table counts as empty; a rubric's doesn't", async () => {
    const outcome = await run({ docs: {
      [IDS.extractPrompt]: textDoc("E", "x"), [IDS.translatePrompt]: tableOnlyDoc("T", "x"),
      [IDS.plPrompt]: textDoc("P", "x"), [IDS.rubric]: tableOnlyDoc("R", "x"),
    } });
    expect(codes(outcome)).toEqual(["doc_empty"]);
    expect(outcome.problems[0].resource).toContain("'T'");
  });

  test("a new prompt env var (e.g. a second content type) is checked without code changes", async () => {
    const env = baseEnv();
    env.translate.TRANSLATION_PROMPT_DOC_ID_CONTENT_TYPE_TWO = "doc-type-two";
    const outcome = await run({ env });
    expect(codes(outcome)).toEqual(["doc_unreadable"]);
    expect(outcome.problems[0].resource).toContain("TRANSLATION_PROMPT_DOC_ID_CONTENT_TYPE_TWO");
  });
});

describe("Glossary check", () => {
  test("missing column", async () => {
    const sheets = baseSheets();
    sheets[`${IDS.glossary}|'FAMLI Spanish Glossary'!A:I`] = [["English Term", "Approved Spanish"], ["a", "b"]];
    const outcome = await run({ sheets });
    expect(codes(outcome)).toEqual(["glossary_missing_columns"]);
    expect(outcome.problems[0].detail).toContain("forbidden terms");
  });

  test("no entries", async () => {
    const sheets = baseSheets();
    const key = `${IDS.glossary}|'FAMLI Spanish Glossary'!A:I`;
    sheets[key] = [sheets[key][0]];
    expect(codes(await run({ sheets }))).toEqual(["glossary_empty"]);
  });

  test("uses GLOSSARY_SHEET_TAB when set", async () => {
    const env = baseEnv();
    env.translate.GLOSSARY_SHEET_TAB = "Medicaid Glossary";
    const outcome = await run({ env });
    expect(codes(outcome)).toEqual(["glossary_unreadable"]);
    expect(outcome.problems[0].resource).toContain("Medicaid Glossary");
  });
});

describe("Model Config check", () => {
  test("a role with no active model", async () => {
    const sheets = baseSheets();
    sheets[`${IDS.modelConfig}|Config!A:F`][4][3] = "NO";
    const outcome = await run({ sheets });
    expect(codes(outcome)).toEqual(["model_config_no_active_model"]);
    expect(outcome.problems[0].resource).toBe("role 'eval'");
  });

  test("role matched exactly, as the services do", async () => {
    const sheets = baseSheets();
    sheets[`${IDS.modelConfig}|Config!A:F`][2][0] = "Translate";
    expect(codes(await run({ sheets }))).toEqual(["model_config_no_active_model"]);
  });

  test("missing columns", async () => {
    const sheets = baseSheets();
    sheets[`${IDS.modelConfig}|Config!A:F`][0] = ["role", "provider", "model"];
    expect(codes(await run({ sheets }))).toEqual(["model_config_missing_columns"]);
  });
});

describe("Processing Log check", () => {
  test("header row changed", async () => {
    const sheets = baseSheets();
    const key = `${IDS.processingLog}|'ProcessingLog'!A:L`;
    sheets[key][0] = [...rules.PROCESSING_LOG_HEADERS];
    sheets[key][0][9] = "Submitted By";
    const outcome = await run({ sheets });
    expect(codes(outcome)).toEqual(["processing_log_headers"]);
    expect(outcome.problems[0].detail).toContain("column J");
  });

  test("blank Submitted By in the last 24 hours, but not older rows", async () => {
    const sheets = baseSheets();
    const key = `${IDS.processingLog}|'ProcessingLog'!A:L`;
    sheets[key].push(
      ["id2", "new.pdf", toSerial(NOW - 2 * 3600 * 1000), "triggered", 1, "", "", "", "", ""],
      ["id3", "old.pdf", toSerial(NOW - 3 * MS_PER_DAY), "triggered", 1, "", "", "", "", ""],
      ["id4", "new.pdf", toSerial(NOW - 3600 * 1000), "extracted", 1, "", "", "", "", ""],
    );
    const outcome = await run({ sheets });
    expect(codes(outcome)).toEqual(["processing_log_blank_submitter"]);
    expect(outcome.problems[0].detail).toMatch(/^1 of 2 rows/);
    expect(outcome.problems[0].detail).toContain("new.pdf");
  });

  test("cellTime reads serial dates and date strings", () => {
    expect(cellTime(toSerial(NOW))).toBeCloseTo(NOW, -3);
    expect(cellTime("2026-10-28T12:00:00Z")).toBe(NOW);
    expect(cellTime("")).toBeNaN();
  });
});

describe("Refinement log check", () => {
  test("a tab whose header row changed, and a missing tab", async () => {
    const sheets = baseSheets();
    sheets[`${IDS.refinementLog}|'ModelFlagged'!1:1`] = [["Timestamp", "Source Text"]];
    delete sheets[`${IDS.refinementLog}|'OtherChanges'!1:1`];
    const outcome = await run({ sheets });
    expect(codes(outcome)).toEqual(["refinement_log_headers", "refinement_log_unreadable"]);
  });
});

describe("Eval results check", () => {
  test("tab not created yet is fine", async () => {
    const sheets = baseSheets();
    delete sheets["sheet-evals|'EvalQuality'!1:1"];
    expect((await run({ sheets })).problems).toEqual([]);
  });

  test("header row changed", async () => {
    const sheets = baseSheets();
    sheets["sheet-evals|'EvalQuality'!1:1"] = [["Timestamp", "Translation File ID"]];
    expect(codes(await run({ sheets }))).toEqual(["eval_results_headers"]);
  });
});

describe("Drive folders check", () => {
  test("missing, trashed, read-only, and a file instead of a folder", async () => {
    const folders = baseFolders();
    delete folders.f1;
    folders.f2.trashed = true;
    folders.f3.capabilities.canAddChildren = false;
    folders.f4.mimeType = "application/pdf";
    const outcome = await run({ folders });
    expect(codes(outcome)).toEqual([
      "drive_folder_unreadable", "drive_folder_trashed", "drive_folder_read_only", "drive_folder_not_folder",
    ]);
    expect(outcome.problems[0].resource).toContain("DRIVE_EXTRACTION_JSON_FOLDER_ID");
  });
});

describe("Statutes check", () => {
  test("no statute files under the prefix", async () => {
    expect(codes(await run({ statuteFiles: ["statutes/md-labor-emply-t8.3/readme.pdf"] }))).toEqual(["statutes_empty"]);
  });

  test("uses STATUTES_GCS_PREFIX when set", async () => {
    const env = baseEnv();
    env.translate.STATUTES_GCS_PREFIX = "statutes/other/";
    const outcome = await run({ env });
    expect(codes(outcome)).toEqual(["statutes_empty"]);
    expect(outcome.problems[0].resource).toContain("statutes/other/");
  });
});

describe("Extract → Translate hand-off check", () => {
  test("topic missing", async () => {
    expect(codes(await run({ pubsub: { topics: {}, subscriptions: {} } }))).toEqual(["pubsub_topic_missing"]);
  });

  test("no subscription", async () => {
    expect(codes(await run({ pubsub: { topics: { [TOPIC]: [] }, subscriptions: {} } }))).toEqual(["pubsub_no_subscription"]);
  });

  test("ack deadline too short", async () => {
    const pubsub = basePubSub();
    pubsub.subscriptions[SUBSCRIPTION].ackDeadlineSeconds = 10;
    const outcome = await run({ pubsub });
    expect(codes(outcome)).toEqual(["pubsub_ack_deadline_short"]);
    expect(outcome.problems[0].detail).toContain("10s");
  });
});

describe("Logged problems check", () => {
  const inputProblem = (service, input, message) => ({
    matches: (f) => f.includes("input_problem"),
    resource: { labels: { service_name: service } },
    jsonPayload: { input_problem: input, message },
  });
  const webhookError = (message) => ({
    matches: (f) => f.includes("Chat webhook"),
    resource: { labels: { service_name: "translate" } },
    textPayload: message,
  });

  test("groups input problems by service and input, newest message first", async () => {
    const outcome = await run({ logEntries: [
      inputProblem("translate", "glossary", "newest"),
      inputProblem("translate", "glossary", "older"),
      inputProblem("extract", "model_config", "config gone"),
      webhookError("Chat webhook rejected with 403 Forbidden"),
    ] });
    expect(codes(outcome)).toEqual(["logged_input_problem", "logged_input_problem", "logged_chat_webhook_error"]);
    expect(outcome.problems[0].resource).toBe("translate: glossary");
    expect(outcome.problems[0].detail).toBe("2 times in the last 24 hours. Latest: newest");
  });

  test("filters to the last 24 hours and skips the health check's own logs", async () => {
    const clients = fakeClients();
    await runChecks({ project: PROJECT, region: REGION, clients });
    const filters = clients.logging.entries.list.mock.calls.map((c) => c[0].requestBody.filter);
    const since = new Date(NOW - MS_PER_DAY).toISOString();
    for (const f of filters) expect(f).toContain(`timestamp>="${since}"`);
    expect(filters[1]).toContain('resource.labels.service_name!="health-check"');
  });
});

describe("crash isolation and the message", () => {
  test("a check that throws becomes check_crashed and the others still run", async () => {
    jest.spyOn(console, "error").mockImplementation();
    const boom = { name: "Boom", run: async () => { throw new Error("kaboom"); } };
    const fine = { name: "Fine", run: async () => [{ check: "Fine", resource: "x", status: "ok" }] };
    const outcome = await runChecks({ project: PROJECT, region: REGION, clients: fakeClients(), checks: [boom, fine] });
    expect(codes(outcome)).toEqual(["check_crashed"]);
    expect(outcome.results).toHaveLength(2);
  });

  test("problem message names the resource, what's wrong and what to do", async () => {
    const env = baseEnv();
    delete env.translate.GOOGLE_CHAT_WEBHOOK_URL;
    const text = formatReport(await run({ env }), "USDR");
    expect(text).toContain("1 problem found");
    expect(text).toContain("translate service");
    expect(text).toContain("GOOGLE_CHAT_WEBHOOK_URL isn't set");
    expect(text).toContain(`What to do: ${WHAT_TO_DO.env_var_missing}`);
  });
});

describe("healthCheck handler", () => {
  const originalEnv = process.env;
  let res;

  beforeEach(() => {
    process.env = { ...originalEnv };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test("responds 500 and posts nothing when not configured", async () => {
    delete process.env.HEALTH_CHECK_REGION;
    delete process.env.HEALTH_CHECK_CHAT_WEBHOOK_URL;
    const { healthCheck } = require("../health-check/index");
    await healthCheck({}, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].error).toContain("HEALTH_CHECK_REGION");
    expect(fetch).not.toHaveBeenCalled();
  });
});
