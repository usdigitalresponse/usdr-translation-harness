---
name: cloud-run-functions
description: Set up, run, test, and deploy Cloud Run functions for local development. Handles dependency installation and Functions Framework serving. Use when asked to run, test, or set up Cloud Run functions.
---

# Cloud Run Functions

Skill for working with the Cloud Run functions in this repo. Covers local setup, running functions, and testing. **This skill must never run `gcloud` commands or deploy anything to Cloud Run — only the user does that.**

## What you can ask

Here are things you can say to use this skill. You don't need exact phrasing — these are just examples.

**Getting started:**
- "Help me set up the Cloud Run functions locally"
- "I just cloned the repo, what do I need to install?"
- "Check if my environment is ready to run functions"

**Running functions:**
- "Run the extract function locally"
- "Start the translate function so I can test it"
- "How do I hit the capture-feedback endpoint?"

**Testing:**
- "Run the tests"
- "Run just the Python tests"
- "Run just the JS tests"

**Testing prompts against LLMs:**
- "Test a translation prompt against Claude"
- "Run a prompt against Gemini"
- "Compare Claude and Gemini on this translation"

**Understanding the project:**
- "What functions do we have and what do they do?"
- "What port does translate run on?"
- "How does the pipeline flow work?"

## Project structure

```
cloud-run/
  extract/              Python — extracts text blocks from PDFs via LLM (pdfplumber + vision)
  translate/            JS — translates extracted content via LLM
  capture-feedback/     JS — diffs reviewer edits, writes glossary updates
  eval/
    quality/            Python — LLM-as-judge quality scoring
    drift/              Python — BLEU/ROUGE + LLM-as-judge regression detection
  tests/                Unit tests
```

JS functions run on Node with @google-cloud/functions-framework.
Python functions run with functions-framework (pip).

Each function is self-contained and independently deployable to Cloud Run. LLM client code and loaders live inside each function's directory. When building a new function, refer to existing functions (e.g. `extract/llm.py`) for patterns to keep consistent.

## Pipeline flow

```
[Drive folder] → Orchestrator (Apps Script, time trigger)
                      │
                      ▼
              Extract (Cloud Run, HTTP)        → port 8081
                      │ publishes to Pub/Sub
                      ▼
              Translate (Cloud Run, Eventarc)   → port 8082
                      │ creates output Google Doc(s)
                      ▼
              [Reviewer edits doc]
                      │ clicks "Submit Review"
                      ▼
              Capture Feedback (Cloud Run, HTTP) → port 8083
                      │ writes to Glossary Sheet

Evals run independently:
  Eval: Quality  → port 8084  (LLM-as-judge, ad hoc or per-translation)
  Eval: Drift    → port 8085  (BLEU/ROUGE + LLM-as-judge, weekly cadence)
```

## Environment

There is a single `.env` file at the repo root (copied from `.env.example`). It holds API keys and all Google Workspace asset IDs. Both Cloud Run functions and Apps Script config reference these values. Do not create a separate `.env` inside `cloud-run/` — one file, one place to update.

## Task: First-time setup

When the user needs to set up their local environment, walk them through these steps one at a time. Check each step before moving to the next — don't dump everything at once.

### Step 1: Prerequisites

Check what's already installed:
```sh
node --version    # need 18+
python3 --version # need 3.10+
```
If missing, tell them: `brew install node python@3.11`

### Step 2: Environment file

```sh
cp .env.example .env
```

The `.env.example` file is organized by section and lists every variable. Help the user fill in values for the function(s) they want to run — see the function-specific sections below for which variables each function needs.

For API keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`): ask Laurel. For Google Doc/Sheet IDs: ask Laurel for the links — the ID is the long string in the URL between `/d/` and `/edit`.

### Step 3: Install dependencies

```sh
cd cloud-run
make install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Each Cloud Run function also has its own `requirements.txt` (Python) or `package.json` (JS). Install the ones for the function(s) you want to run:

```sh
# Python functions
pip install -r extract/requirements.txt

# JS functions (already handled by make install, but individually:)
cd translate && npm install && cd ..
cd capture-feedback && npm install && cd ..
```

### Step 4: Verify everything

```sh
cd cloud-run
source .venv/bin/activate
make check
```

This checks: node/python versions, venv active, `.env` exists, API keys set, Python/JS deps installed, config fixture present, and function-specific variables. No LLM calls — free to run. Walk through any failures with the user.

## Task: Run a function locally

Run from the `cloud-run/` directory:

```sh
# JS functions
make translate         # or capture-feedback
# Python functions (activate venv first)
source .venv/bin/activate
make extract           # or eval-quality, eval-drift
```

Test with curl:
```sh
curl -X POST http://localhost:<port> -H "Content-Type: application/json" -d '<payload>'
```

See the function-specific sections below for ports, payloads, and required env vars.

---

## Function: Extract

**Language:** Python | **Port:** 8081 | **Entry point:** `cloud-run/extract/main.py`

Accepts a PDF (from Drive or local), runs it through an LLM with structured output schema enforcement, and produces extraction JSON with every text block on the page.

There are two extraction schemas — one per provider — because Claude and Gemini have different structured output requirements:
- `extraction-schema-claude.json` — standard JSON Schema (uses `additionalProperties`, `{"type": ["string", "null"]}` for nullable fields)
- `extraction-schema-gemini.json` — Gemini-compatible (no `additionalProperties`, uses `{"nullable": true}` instead)

Both define the same fields and structure. When updating the extraction output format, update both files.

### Required env vars

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | LLM API key — only need one, depending on which model is active in config |
| `EXTRACTION_PROMPT_DOC_ID` | Google Doc ID for the extraction prompt |
| `LOCAL_PDF_PATH` | Absolute path to a PDF on your machine (skips Drive fetch) |

### Run locally

```sh
cd cloud-run/extract
source ../.venv/bin/activate
functions-framework --target=extract --port=8081 --debug
```

In another terminal:
```sh
curl -s -X POST http://localhost:8081 -H "Content-Type: application/json" \
  -d '{"fileId":"ignored-locally","fileName":"test.pdf"}'
```

Log output shows: PDF loaded, pdfplumber text extracted, LLM called, response received, extraction validated, JSON saved. Output lands in `cloud-run/extract/fixtures/output/`.

### Cloud I/O mode (optional)

By default, extract reads config from `fixtures/config.json`, loads the PDF from `LOCAL_PDF_PATH`, and writes output to `fixtures/output/`. To test with the same cloud services used in production:

1. Get a service account key from GCP Console > IAM & Admin > Service Accounts > (the pipeline service account) > Keys > Add Key > JSON
2. Store it outside the repo at `~/.gcp/translation-pipeline-key.json`
3. Add these to `.env`:

| Variable | What it is |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key (e.g. `/Users/you/.gcp/translation-pipeline-key.json`) |
| `MODEL_CONFIG_SHEET_ID` | Google Sheet ID — reads config from Sheet instead of `fixtures/config.json` |
| `DRIVE_EXTRACTION_JSON_FOLDER_ID` | Drive folder ID — writes output to Drive instead of local disk |

The service account must have Viewer access on the config sheet and extraction prompt doc, and Content Manager access on the output Shared Drive.

With these set, running locally behaves identically to the deployed Cloud Run function. You can still use `LOCAL_PDF_PATH` to skip the Drive fetch for the input PDF.

### View results

```sh
python3 .claude/skills/cloud-run-functions/scripts/view_latest.py
```

Opens a side-by-side viewer with the PDF and extraction JSON. The manual file-picker viewer is also available at `.claude/skills/cloud-run-functions/assets/viewer.html`.

---

## Function: Translate

**Language:** JS | **Port:** 8082 | **Entry point:** `cloud-run/translate/index.js`

Takes extraction JSON, loads the translation prompt and glossary, calls the LLM, and creates output Google Doc(s).

### Required env vars

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | LLM API key |
| `TRANSLATION_PROMPT_DOC_ID` | Google Doc ID for the translation prompt |
| `GLOSSARY_SHEET_ID` | Google Sheet ID for the glossary |

### Run locally

```sh
cd cloud-run
make translate
```

```sh
# Should return 400
curl -s -X POST http://localhost:8082 -H "Content-Type: application/json" -d '{}'

# Should return 200
curl -s -X POST http://localhost:8082 -H "Content-Type: application/json" \
  -d '{"extractionJsonUrl":"<url-to-extraction-json>"}'
```

---

## Function: Capture Feedback

**Language:** JS | **Port:** 8083 | **Entry point:** `cloud-run/capture-feedback/index.js`

Takes a Google Doc ID after a reviewer submits, diffs the edits against the LLM output, and writes terminology decisions to the glossary.

### Required env vars

| Variable | What it is |
|---|---|
| `GLOSSARY_SHEET_ID` | Google Sheet ID for the glossary |
| `DERIVED_GLOSSARY_SHEET_ID` | Google Sheet ID for the derived glossary |

### Run locally

```sh
cd cloud-run
make capture-feedback
```

```sh
# Should return 400
curl -s -X POST http://localhost:8083 -H "Content-Type: application/json" -d '{}'

# Should return 200
curl -s -X POST http://localhost:8083 -H "Content-Type: application/json" \
  -d '{"documentId":"<google-doc-id>"}'
```

---

## Function: Eval (Quality + Drift)

**Language:** Python | **Ports:** 8084 (quality), 8085 (drift)

Quality runs LLM-as-judge scoring. Drift runs BLEU/ROUGE + LLM-as-judge regression detection.

### Required env vars

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | LLM API key |
| `EVALUATION_RUBRIC_DOC_ID` | Google Doc ID for the eval rubric |
| `GOLDEN_SET_SHEET_ID` | Google Sheet ID for golden translation set (drift) |

### Run locally

```sh
cd cloud-run
source .venv/bin/activate
make eval-quality    # or eval-drift
```

## Task: Run tests

```sh
cd cloud-run
make test        # all tests
make test-js     # JS only
make test-py     # Python only (activate venv first)
```

## Task: Switch the active model

Model config for local dev lives in each function's `fixtures/config.json` (e.g. `cloud-run/extract/fixtures/config.json`). Each entry has `role`, `provider`, `model`, and `active` fields. When `MODEL_CONFIG_SHEET_ID` is set in `.env`, config is read from the Google Sheet instead — edit the Sheet to switch models in that mode.

When the user asks to switch models (e.g. "switch translate to Gemini", "use claude-opus-4-8 for eval"):

1. Read the function's `fixtures/config.json` (e.g. `cloud-run/extract/fixtures/config.json`)
2. Find the row(s) matching the requested role
3. Set `active: true` on the target provider/model and `active: false` on the other(s) for that role
4. To run multiple models in parallel for a role, set multiple entries to `active: true`
5. Write the updated JSON back

Available models are listed in the Models tab of the config Google Sheet. For quick reference:

**Anthropic:** claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
**Google:** gemini-3.5-flash, gemini-3.1-pro-preview, gemini-3.1-flash-lite

If the user requests a model not in the list, ask them to confirm before adding it.

Example prompts:
- "Switch extract to use Gemini"
- "Use claude-opus-4-8 for translate"
- "Run both Claude and Gemini for translate"
- "What model is active for eval?"

## Task: Test prompt quality

Make sure `.env` has API keys filled in, then from `cloud-run/`:

```sh
source .venv/bin/activate
python3 -c "
from extract.llm import call_claude
print(call_claude('Translate to Spanish: Hello, how can I help you today?'))
"
```
