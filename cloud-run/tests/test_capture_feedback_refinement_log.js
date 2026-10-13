const mockSheetsAppend = jest.fn();
jest.mock("../capture-feedback/node_modules/googleapis", () => ({
  google: {
    sheets: () => ({ spreadsheets: { values: { append: mockSheetsAppend } } }),
  },
}));

const { writeDecisions, recordDecisions } = require("../capture-feedback/glossary-writer");
const { TAB_REVIEWED, TAB_OTHER_CHANGES } = require("../capture-feedback/decisions");

const SHEET_ID = "refinement-log-sheet";
const DECISIONS = [
  { tab: TAB_REVIEWED, aiTerm: "sueldo", reviewerTerm: "salario", blockId: "b01" },
  { tab: TAB_OTHER_CHANGES, aiTerm: "el", reviewerTerm: "la", blockId: "b02" },
];

/** Structured input-problem logs captured by a console.log spy. */
function inputProblems(spy) {
  return spy.mock.calls
    .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
    .filter((e) => e && e.input_problem);
}

describe("writeDecisions", () => {
  beforeEach(() => mockSheetsAppend.mockReset());

  test("writes each tab's rows to that tab", async () => {
    mockSheetsAppend.mockResolvedValue({});

    await writeDecisions(DECISIONS, SHEET_ID, {});

    const ranges = mockSheetsAppend.mock.calls.map((c) => c[0].range);
    expect(ranges).toEqual([`${TAB_REVIEWED}!A:J`, `${TAB_OTHER_CHANGES}!A:J`]);
  });

  test("still writes the other tabs when one fails, and names the failed tab", async () => {
    mockSheetsAppend.mockImplementation(({ range }) =>
      range.startsWith(TAB_REVIEWED)
        ? Promise.reject(new Error("Unable to parse range: Reviewed!A:J"))
        : Promise.resolve({})
    );

    const error = await writeDecisions(DECISIONS, SHEET_ID, {}).catch((e) => e);

    expect(mockSheetsAppend).toHaveBeenCalledTimes(2);
    expect(error.message).toBe("Reviewed tab: Unable to parse range: Reviewed!A:J");
    expect(error.failedTabs).toEqual([{ tab: TAB_REVIEWED, rows: 1 }]);
  });
});

describe("recordDecisions", () => {
  let savedKService;
  let logSpy;

  beforeEach(() => {
    mockSheetsAppend.mockReset().mockResolvedValue({});
    savedKService = process.env.K_SERVICE;
    logSpy = jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(() => {
    if (savedKService === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = savedKService;
    logSpy.mockRestore();
  });

  test("returns no warning on success", async () => {
    expect(await recordDecisions(DECISIONS, SHEET_ID, {})).toBeNull();
    expect(inputProblems(logSpy)).toEqual([]);
  });

  test("does nothing when there are no decisions", async () => {
    process.env.K_SERVICE = "capture-feedback";
    expect(await recordDecisions([], undefined, {})).toBeNull();
    expect(mockSheetsAppend).not.toHaveBeenCalled();
  });

  test("skips quietly without a sheet ID outside Cloud Run", async () => {
    delete process.env.K_SERVICE;
    expect(await recordDecisions(DECISIONS, undefined, {})).toBeNull();
    expect(inputProblems(logSpy)).toEqual([]);
  });

  test("logs an input problem without a sheet ID on Cloud Run", async () => {
    process.env.K_SERVICE = "capture-feedback";

    const warning = await recordDecisions(DECISIONS, undefined, {});

    expect(warning).toContain("DERIVED_GLOSSARY_SHEET_ID is not set");
    const [problem] = inputProblems(logSpy);
    expect(problem.severity).toBe("ERROR");
    expect(problem.input_problem).toBe("refinement_log");
    expect(problem).not.toHaveProperty("pipeline_stage");
  });

  test("logs an input problem naming the failed tab when a write fails", async () => {
    mockSheetsAppend.mockImplementation(({ range }) =>
      range.startsWith(TAB_REVIEWED)
        ? Promise.reject(new Error("Unable to parse range: Reviewed!A:J"))
        : Promise.resolve({})
    );

    const warning = await recordDecisions(DECISIONS, SHEET_ID, {});

    expect(warning).toContain("Reviewed tab: Unable to parse range");
    const [problem] = inputProblems(logSpy);
    expect(problem.failed_tabs).toEqual([{ tab: TAB_REVIEWED, rows: 1 }]);
    expect(problem.message).toContain("Reviewed / ModelFlagged / OtherChanges");
  });
});
