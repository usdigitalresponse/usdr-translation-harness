---
name: cloud-run-functions
description: Set up, run, test, and package Cloud Run functions for local development. Handles dependency installation, Functions Framework serving, and bundling shared code for deploy. Use when asked to run, test, set up, or package Cloud Run functions. This skill does NOT deploy — it only packages.
---

# Cloud Run Functions

Skill for working with the Cloud Run functions in this repo. Covers local setup, running functions, testing, and packaging for deploy. **This skill must never run `gcloud` commands or deploy anything to Cloud Run — only the user does that.**

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

**Packaging for deploy:**
- "Package the extract function for deploy"
- "Bundle shared code into translate so I can deploy it"
- "Package all functions"

**Understanding the project:**
- "What functions do we have and what do they do?"
- "What port does translate run on?"
- "How does the pipeline flow work?"

## Project structure

```
cloud-run/
  extract/              JS — extracts text blocks from PDFs via LLM
  translate/            JS — translates extracted content via LLM
  capture-feedback/     JS — diffs reviewer edits, writes glossary updates
  eval/
    quality/            Python — LLM-as-judge quality scoring
    drift/              Python — BLEU/ROUGE + LLM-as-judge regression detection
  shared/               Shared LLM client helpers (JS + Python) — local dev only
  tests/                Unit tests
```

JS functions run on Node with @google-cloud/functions-framework.
Python functions run with functions-framework (pip).

Each function is independently deployable to Cloud Run. The `shared/` directory is for local dev convenience — the package script handles copying shared code into each function's directory so it's ready for deploy.

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

When the user needs to set up their local environment:

1. Check prerequisites:
   - `node --version` (need 18+)
   - `python3 --version` (need 3.10+)
   - If missing, tell them to `brew install node python@3.11`

2. Check for `.env` file at the repo root:
   - If missing, tell them to `cp .env.example .env` and fill in API keys
   - They need `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` at minimum

3. Install dependencies:
   ```sh
   cd cloud-run
   cd extract && npm install && cd ..
   cd translate && npm install && cd ..
   cd capture-feedback && npm install && cd ..
   npm install
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements-dev.txt
   ```

4. Run the smoke test to verify everything:
   ```sh
   cd cloud-run
   make check
   ```
   This checks: node/python versions, venv active, `.env` exists, API keys set, JS/Python deps installed, config fixture present, and doc IDs configured. No LLM calls — free to run.

## Task: Run a function locally

Run from the `cloud-run/` directory:

```sh
# JS functions
make extract           # or translate, capture-feedback
# Python functions (activate venv first)
source .venv/bin/activate
make eval-quality      # or eval-drift
```

Test with curl:
```sh
curl -X POST http://localhost:<port> -H "Content-Type: application/json" -d '<payload>'
```

## Task: Run tests

```sh
cd cloud-run
make test        # all tests
make test-js     # JS only
make test-py     # Python only (activate venv first)
```

## Task: Package a function for deploy

Use the package script at `.claude/skills/cloud-run-functions/scripts/package.sh`. It copies shared code into the function's directory so it's self-contained and ready for the user to deploy manually.

```sh
.claude/skills/cloud-run-functions/scripts/package.sh <function-name>
```

Examples:
```sh
.claude/skills/cloud-run-functions/scripts/package.sh extract
.claude/skills/cloud-run-functions/scripts/package.sh capture-feedback
.claude/skills/cloud-run-functions/scripts/package.sh eval/quality
```

The script auto-detects language (JS vs Python) and copies shared code in. To undo packaging (remove the bundled shared code), run:
```sh
.claude/skills/cloud-run-functions/scripts/package.sh <function-name> --clean
```

**Do not deploy from this skill.** After packaging, tell the user the function is ready and where it is. The user handles `gcloud` deployment themselves.

## Task: Test prompt quality

Make sure `.env` has API keys filled in, then from `cloud-run/`:

```sh
# Python
source .venv/bin/activate
python3 -c "
from shared.llm import call_claude
print(call_claude('Translate to Spanish: Hello, how can I help you today?'))
"

# JavaScript
node -e "
const { callClaude } = require('./shared/llm.js');
callClaude('Translate to Spanish: Hello, how can I help you today?').then(console.log);
"
```
