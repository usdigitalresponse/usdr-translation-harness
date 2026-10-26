const mockSheetsAppend = jest.fn();
const mockSheetsGet = jest.fn();
jest.mock("../capture-feedback/node_modules/googleapis", () => ({
  google: {
    sheets: () => ({ spreadsheets: { values: { append: mockSheetsAppend, get: mockSheetsGet } } }),
  },
}));

const { writeDecisions, recordDecisions, REFINEMENT_LOG_HEADERS } = require("../capture-feedback/glossary-writer");

// Every tab has the expected header row unless a test says otherwise
function headersOk() {
  mockSheetsGet.mockReset().mockResolvedValue({ data: { values: [REFINEMENT_LOG_HEADERS] } });
}
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
  beforeEach(() => {
    mockSheetsAppend.mockReset();
    headersOk();
  });

  test("writes each tab's rows to that tab", async () => {
    mockSheetsAppend.mockResolvedValue({});

    await writeDecisions(DECISIONS, SHEET_ID, {});

    const ranges = mockSheetsAppend.mock.calls.map((c) => c[0].range);
    expect(ranges).toEqual([`${TAB_REVIEWED}!A:L`, `${TAB_OTHER_CHANGES}!A:L`]);
  });

  test("writes English Source (K) and Reviewer Sentence (L)", async () => {
    mockSheetsAppend.mockResolvedValue({});

    await writeDecisions([{
      tab: TAB_REVIEWED, aiTerm: "sueldo", reviewerTerm: "salario", blockId: "b01",
      sourceText: "Recibirá su sueldo.", englishSource: "You'll get your wages.",
      reviewerSentence: "Recibirá su salario.",
    }], SHEET_ID, {});

    const row = mockSheetsAppend.mock.calls[0][0].requestBody.values[0];
    expect(row).toHaveLength(REFINEMENT_LOG_HEADERS.length);
    expect(row[6]).toBe("Recibirá su sueldo.");
    expect(row[10]).toBe("You'll get your wages.");
    expect(row[11]).toBe("Recibirá su salario.");
  });

  test("skips a tab whose header row doesn't match, still writes the others", async () => {
    mockSheetsAppend.mockResolvedValue({});
    mockSheetsGet.mockImplementation(({ range }) => Promise.resolve({ data: { values: [
      range.startsWith(TAB_REVIEWED)
        ? REFINEMENT_LOG_HEADERS.map((h) => (h === "AI Sentence" ? "Source Text" : h))
        : REFINEMENT_LOG_HEADERS,
    ] } }));

    const error = await writeDecisions(DECISIONS, SHEET_ID, {}).catch((e) => e);

    expect(mockSheetsAppend.mock.calls.map((c) => c[0].range)).toEqual([`${TAB_OTHER_CHANGES}!A:L`]);
    expect(error.message).toContain("Reviewed tab: header row doesn't match");
    expect(error.message).toContain("Found: Timestamp, Reviewer Email, AI Term, Reviewer Term, Block ID, Review Signal, Source Text");
    expect(error.failedTabs).toEqual([{ tab: TAB_REVIEWED, rows: 1 }]);
  });

  test("accepts headers in any case, with extra columns after L", async () => {
    mockSheetsAppend.mockResolvedValue({});
    mockSheetsGet.mockResolvedValue({ data: { values: [
      REFINEMENT_LOG_HEADERS.map((h) => h.toUpperCase()).concat(["Notes"]),
    ] } });

    await writeDecisions(DECISIONS, SHEET_ID, {});

    expect(mockSheetsAppend).toHaveBeenCalledTimes(2);
  });

  test("still writes the other tabs when one fails, and names the failed tab", async () => {
    mockSheetsAppend.mockImplementation(({ range }) =>
      range.startsWith(TAB_REVIEWED)
        ? Promise.reject(new Error("Unable to parse range: Reviewed!A:L"))
        : Promise.resolve({})
    );

    const error = await writeDecisions(DECISIONS, SHEET_ID, {}).catch((e) => e);

    expect(mockSheetsAppend).toHaveBeenCalledTimes(2);
    expect(error.message).toBe("Reviewed tab: Unable to parse range: Reviewed!A:L");
    expect(error.failedTabs).toEqual([{ tab: TAB_REVIEWED, rows: 1 }]);
  });
});

describe("recordDecisions", () => {
  let savedKService;
  let logSpy;

  beforeEach(() => {
    mockSheetsAppend.mockReset().mockResolvedValue({});
    headersOk();
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
        ? Promise.reject(new Error("Unable to parse range: Reviewed!A:L"))
        : Promise.resolve({})
    );

    const warning = await recordDecisions(DECISIONS, SHEET_ID, {});

    expect(warning).toContain("Reviewed tab: Unable to parse range");
    const [problem] = inputProblems(logSpy);
    expect(problem.failed_tabs).toEqual([{ tab: TAB_REVIEWED, rows: 1 }]);
    expect(problem.message).toContain("Reviewed / ModelFlagged / OtherChanges");
  });
});
