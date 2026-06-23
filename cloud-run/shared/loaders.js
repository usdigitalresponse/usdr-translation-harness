require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const fs = require("fs");
const path = require("path");
const { parse: parseCsv } = require("csv-parse/sync");

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

async function loadDoc(envVar) {
  const docId = process.env[envVar];
  if (!docId) throw new Error(`${envVar} not set in .env`);

  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${envVar} (${res.status})`);
  return res.text();
}

async function loadSheet(envVar, { sheet = 0 } = {}) {
  const sheetId = process.env[envVar];
  if (!sheetId) throw new Error(`${envVar} not set in .env`);

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheet}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${envVar} (${res.status})`);
  return parseCsv(await res.text(), { columns: true, skip_empty_lines: true, trim: true });
}

// Config is private — loads from local fixture file for local dev.
function loadConfig() {
  const fixturePath = path.join(FIXTURES_DIR, "config.json");
  return JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
}

// Write results to local CSV for local dev testing.
function writeLocalCsv(filename, rows) {
  const outDir = path.join(FIXTURES_DIR, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const header = Object.keys(rows[0]).join(",");
  const quote = (v) => (String(v).includes(",") ? `"${v}"` : String(v));
  const lines = rows.map((r) => Object.values(r).map(quote).join(","));
  fs.writeFileSync(path.join(outDir, filename), [header, ...lines].join("\n"));
}

module.exports = { loadDoc, loadSheet, loadConfig, writeLocalCsv };
