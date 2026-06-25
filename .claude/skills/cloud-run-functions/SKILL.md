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

Then help them fill in the values they need. For running extract locally, the required variables are:

| Variable | Where to get it | Required for |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | Extract (Claude) |
| `GEMINI_API_KEY` | aistudio.google.com → API Keys | Extract (Gemini) |
| `EXTRACTION_PROMPT_DOC_ID` | Ask Laurel for the Google Doc link — the ID is the long string in the URL between `/d/` and `/edit` | Extract |
| `LOCAL_PDF_PATH` | Absolute path to any PDF on their machine for local testing, e.g. `/Users/you/Downloads/sample.pdf` | Extract (local) |

They only need one API key (Anthropic or Gemini) depending on which model is active in the config. Anthropic is the default.

### Step 3: Install dependencies

```sh
cd cloud-run
make install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pip install -r extract/requirements.txt
```

### Step 4: Verify everything

```sh
cd cloud-run
source .venv/bin/activate
make check
```

This checks: node/python versions, venv active, `.env` exists, API keys set, Python/JS deps installed, config fixture present, and extract-specific variables. No LLM calls — free to run. Walk through any failures with the user.

### Step 5: Run extract end-to-end

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

They should see log output showing: PDF loaded → pdfplumber text extracted → LLM called → response received → extraction validated → JSON saved. The output lands in `cloud-run/extract/fixtures/output/`.

### Step 6: View results

```sh
python3 .claude/skills/cloud-run-functions/view_latest.py
```

Opens a side-by-side viewer with the PDF and extraction JSON.

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

### Function-specific curl tests

**Extract (port 8081):**
```sh
# Should return 400
curl -s -X POST http://localhost:8081 -H "Content-Type: application/json" -d '{}'

# Should return 202
curl -s -X POST http://localhost:8081 -H "Content-Type: application/json" \
  -d '{"fileId":"<drive-file-id>","fileName":"test.pdf"}'
```

**Translate (port 8082):**
```sh
# Should return 400
curl -s -X POST http://localhost:8082 -H "Content-Type: application/json" -d '{}'

# Should return 200
curl -s -X POST http://localhost:8082 -H "Content-Type: application/json" \
  -d '{"extractionJsonUrl":"<url-to-extraction-json>"}'
```

**Capture Feedback (port 8083):**
```sh
# Should return 400
curl -s -X POST http://localhost:8083 -H "Content-Type: application/json" -d '{}'

# Should return 200
curl -s -X POST http://localhost:8083 -H "Content-Type: application/json" \
  -d '{"documentId":"<google-doc-id>"}'
```

## Task: Run tests

```sh
cd cloud-run
make test        # all tests
make test-js     # JS only
make test-py     # Python only (activate venv first)
```

## Task: Switch the active model

Model config for local dev lives in each function's `fixtures/config.json` (e.g. `cloud-run/extract/fixtures/config.json`). Each entry has `role`, `provider`, `model`, and `active` fields.

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

## Task: View extraction results

Use the viewer to inspect extraction JSON side-by-side with the source PDF. The viewer is at `.claude/skills/cloud-run-functions/viewer.html`. Extraction output lives in `cloud-run/extract/fixtures/output/`.

When the user asks to view results (e.g. "show me the latest extraction", "open the viewer"):

```sh
python3 .claude/skills/cloud-run-functions/view_latest.py
```

This finds the latest extraction JSON in `cloud-run/extract/fixtures/output/`, reads the PDF from `LOCAL_PDF_PATH` in `.env`, and opens a self-contained viewer with both pre-loaded. The manual file-picker viewer is also available at `.claude/skills/cloud-run-functions/viewer.html`.

## Task: Test prompt quality

Make sure `.env` has API keys filled in, then from `cloud-run/`:

```sh
# Python (using extract's LLM client as an example)
source .venv/bin/activate
python3 -c "
from extract.llm import call_claude
print(call_claude('Translate to Spanish: Hello, how can I help you today?'))
"
```
