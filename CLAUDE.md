# CLAUDE.md

## Project overview

Translation harness for USDR (US Digital Response). Automates PDF translation via LLM, collects reviewer feedback, and builds a glossary over time. Built on Google Cloud (Cloud Run functions + Apps Script) with Google Workspace as the user-facing layer.

## Architecture — component boundaries

The system has two layers that communicate over HTTP:

```
Apps Script (Google Workspace)          Cloud Run (GCP)
─────────────────────────────           ───────────────
Orchestrator                            Extract
  watches Drive input folder              accepts fileId + mimeType
  for PDFs, Google Docs, DOCX             PDF: pdfplumber + LLM extraction
  calls Extract (fire-and-forget, 202)    Doc/DOCX: text passthrough (no LLM)
                                          publishes to Pub/Sub
                                              │
                                              ▼
                                        Translate
                                          loads prompt + glossary, calls LLM
                                          creates output Google Doc(s)
                                          sets usdr_translation_review doc property
                                              │
                                              ▼
Editor Add-on                           Capture Feedback
  shows "Submit Review" menu              accepts documentId
  on docs with the doc property           diffs reviewer edits against LLM output
  calls Capture Feedback                  writes terminology decisions to glossary
```

Evals (quality + drift) run independently and are not part of the core pipeline.

### Cross-component interfaces

When changing one component, check the other side of each interface it touches:

| Caller | Callee | Contract |
|---|---|---|
| Orchestrator | Extract | `POST { fileId, fileName, mimeType, contentType, submittedByEmail, submittedByName }` → `202 Accepted` |
| Editor Add-on | Capture Feedback | `POST { documentId }` → `200` with decisions |
| Extract | Translate | Pub/Sub message with extraction JSON location |
| Translate | Editor Add-on | `usdr_translation_review` document property on output docs |
| Plain Language Eval | Editor Add-on | `plainLanguageEvalSourceFileId` Drive property on eval JSON (source file ID; add-on queries by it) |

Update these docs when an interface changes:
- `scratch/architecture/cloud-run-architecture.md` — internal architecture working doc
- `apps-script/orchestrator/README.md`
- `apps-script/editor-addon/README.md`
- Cloud Run function entrypoints (`cloud-run/*/main.py` or `cloud-run/*/index.js`)

## Directory structure

- `apps-script/orchestrator/` — Apps Script project: Drive folder watcher, processing log
- `apps-script/editor-addon/` — Apps Script project: editor add-on for reviewer feedback
- `apps-script/design-system/` — Apps Script web app: reference site for the add-on's design system (not part of the pipeline; `.clasp.json` gitignored)
- `cloud-run/extract/` — Cloud Run function: PDF extraction via LLM (Python; uses pdfplumber for text pre-extraction)
- `cloud-run/translate/` — Cloud Run function: translation via LLM
- `cloud-run/capture-feedback/` — Cloud Run function: reviewer feedback capture
- `cloud-run/eval/quality/` — Eval function: LLM-as-judge scoring (Python)
- `cloud-run/eval/drift/` — Eval function: BLEU/ROUGE + LLM-as-judge (Python)
- `cloud-run/health-check/` — Daily check of pipeline resources (settings, prompt docs, sheets); posts to an ops Chat space. Not part of the pipeline
- `cloud-run/tests/` — Unit tests for Cloud Run functions
- `apps-script/tests/` — Unit tests for Apps Script projects

## Code style

- Default to JavaScript for Cloud Run functions — Maryland stakeholders are more familiar with JS
- Extract is Python because it needs pdfplumber for text pre-extraction. Scanned/image-based PDFs won't have an embedded text layer, so the LLM falls back to vision-only for those.
- Eval functions are Python (need sacrebleu/rouge-score)
- Extract magic numbers and string literals into named constants; prefer stdlib over hand-rolled (e.g. `http.HTTPStatus` in Python, `http.STATUS_CODES` in Node)
- When using external SDK methods (Google APIs, Anthropic SDK, etc.), verify against current documentation that the methods aren't deprecated. Standard library and stable frameworks don't need this check.
- Apps Script runs on V8 — ES6 features (Set, Map, const/let, arrow functions) are available

## Testing

- Cloud Run JS tests: `cd cloud-run && npm test` (Jest)
- Apps Script JS tests: `cd apps-script && npm test` (Jest)
- Python tests: `cd cloud-run && python -m pytest` (requires `.venv`)

## Verify assumptions about libraries and platforms

Code that depends on how an external library or platform behaves (error classes, defaults, dependencies) has broken in ways the tests didn't catch. Before relying on such behavior:

- **Check it against the installed code, at the version that deploys**, not memory or docs alone. Python services install the newest versions their `requirements.txt` allows, which can be newer than `.venv`: test Python changes in a fresh venv built from the service's requirements before deploying. (The Anthropic and Google GenAI Python SDKs switched from `httpx` to `httpx2`; an `import httpx` passed locally and crashed Extract on deploy.)
- **Test with real objects from the library**, not hand-built fakes. The JS Anthropic SDK's errors don't set `err.name`; tests with fake errors that set it hid a bug in error detection.
- **Check defaults for anything that repeats or costs money:** retries (SDK clients, Pub/Sub), dead-letter and retention, idle expiry, max instances, timeouts. Answer "what stops this repeating, and what does each attempt cost?" (see `scratch/notes/exposure-review.md` for the review that found these).
- **Cap major versions** of external dependencies so a breaking release can't land silently on deploy.
- In code review, ask: which library behaviors does this change assume, and where were they verified?

## Deployment

- Apps Script: `clasp push` from each `apps-script/` subdirectory
- Cloud Run: each function is self-contained and deployable directly from its directory
