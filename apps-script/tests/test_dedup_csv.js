const fs = require("fs");
const path = require("path");

const CSV_PATH = path.resolve(
  __dirname,
  "../../docs/internal/Files_Processed_Tracker - ProcessingLog.csv"
);

// Constants copied exactly from orchestrator.js
var HEADER_ROWS = 1;
var STATUS = {
  TRIGGERED: "triggered",
  COMPLETE: "complete",
  EXTRACTED: "extracted",
  FAILED: "failed",
};
var COL = {
  FILE_ID: 0,
  FILE_NAME: 1,
  PROCESSED_AT: 2,
  STATUS: 3,
  DURATION_MS: 4,
  ERROR_DETAIL: 5,
  EXTRACTION_FILE_ID: 6,
  PROVIDER: 7,
  MODEL: 8,
};

function parseCsvRows(csvText) {
  return csvText
    .trim()
    .split("\n")
    .map(function (line) { return line.split(","); });
}

// Exact replica of getProcessedFileIds logic (minus the Sheets API call)
function getProcessedFileIds(data) {
  return new Set(
    data.slice(HEADER_ROWS)
      .filter(function (row) { return row[COL.STATUS] !== STATUS.FAILED; })
      .map(function (row) { return row[COL.FILE_ID]; })
  );
}

const TARGET_FILE_ID = "1842dvPE5itfplA7b6J27DgsRIHXVjZ1Q";

describe("getProcessedFileIds against real CSV", () => {
  let data;

  beforeAll(() => {
    const csvText = fs.readFileSync(CSV_PATH, "utf-8");
    data = parseCsvRows(csvText);
  });

  test("CSV has expected header row", () => {
    expect(data[0][COL.FILE_ID]).toBe("fileId");
    expect(data[0][COL.STATUS]).toBe("status");
  });

  test("CSV has the repeated file", () => {
    const rows = data.slice(HEADER_ROWS).filter(
      (row) => row[COL.FILE_ID] === TARGET_FILE_ID
    );
    expect(rows.length).toBeGreaterThan(1);
  });

  test("processed Set contains the repeated file ID", () => {
    const processed = getProcessedFileIds(data);
    expect(processed.has(TARGET_FILE_ID)).toBe(true);
  });

  test("processed Set contains the repeated file at every stage of the CSV", () => {
    // Simulate the orchestrator reading the sheet at each point in time.
    // After each row is written, does the Set contain the file?
    const failures = [];

    for (let i = HEADER_ROWS + 1; i <= data.length; i++) {
      const partialData = data.slice(0, i);
      const processed = getProcessedFileIds(partialData);
      const lastRow = partialData[partialData.length - 1];

      if (lastRow[COL.FILE_ID] === TARGET_FILE_ID && !processed.has(TARGET_FILE_ID)) {
        failures.push({
          rowIndex: i,
          status: lastRow[COL.STATUS],
          fileId: lastRow[COL.FILE_ID],
        });
      }
    }

    expect(failures).toEqual([]);
  });

  test("all non-failed statuses in CSV are recognized", () => {
    const statuses = new Set(
      data.slice(HEADER_ROWS).map((row) => row[COL.STATUS])
    );
    // Every status should be one we expect
    for (const s of statuses) {
      expect(
        [STATUS.TRIGGERED, STATUS.COMPLETE, STATUS.EXTRACTED, STATUS.FAILED].includes(s)
      ).toBe(true);
    }
  });

  test("Set.has works with strict string equality on these IDs", () => {
    const set = new Set([TARGET_FILE_ID]);
    const fromCsv = data[5][COL.FILE_ID]; // first "complete" row
    expect(typeof fromCsv).toBe("string");
    expect(typeof TARGET_FILE_ID).toBe("string");
    expect(fromCsv).toBe(TARGET_FILE_ID);
    expect(set.has(fromCsv)).toBe(true);
  });
});
