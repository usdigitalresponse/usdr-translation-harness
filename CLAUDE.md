# CLAUDE.md

## Project overview

Translation harness for USDR (US Digital Response). Automates PDF translation via LLM, collects reviewer feedback, and builds a glossary over time. Built on Google Cloud (Cloud Run functions + Apps Script) with Google Workspace as the user-facing layer.

## Architecture — component boundaries

The system has two layers that communicate over HTTP:

```
Apps Script (Google Workspace)          Cloud Run (GCP)
─────────────────────────────           ───────────────
Orchestrator                            Extract
  watches Drive input folder              accepts fileId, fetches PDF from Drive
  calls Extract (fire-and-forget, 202)    sends PDF to LLM, stores extraction JSON
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
| Orchestrator | Extract | `POST { fileId, fileName }` → `202 Accepted` |
| Editor Add-on | Capture Feedback | `POST { documentId }` → `200` with decisions |
| Extract | Translate | Pub/Sub message with extraction JSON location |
| Translate | Editor Add-on | `usdr_translation_review` document property on output docs |

Update these docs when an interface changes:
- `scratch.cloud-run-architecture.md` — internal architecture working doc
- `apps-script/orchestrator/README.md`
- `apps-script/editor-addon/README.md`
- Cloud Run function stubs (`cloud-run/*/index.js`)

## Directory structure

- `apps-script/orchestrator/` — Apps Script project: Drive folder watcher, processing log
- `apps-script/editor-addon/` — Apps Script project: editor add-on for reviewer feedback
- `cloud-run/extract/` — Cloud Run function: PDF extraction via LLM
- `cloud-run/translate/` — Cloud Run function: translation via LLM
- `cloud-run/capture-feedback/` — Cloud Run function: reviewer feedback capture
- `cloud-run/eval/quality/` — Eval function: LLM-as-judge scoring (Python)
- `cloud-run/eval/drift/` — Eval function: BLEU/ROUGE + LLM-as-judge (Python)
- `cloud-run/shared/` — Local-dev-only shared code (LLM wrappers, loaders)
- `cloud-run/tests/` — Unit tests for all Cloud Run functions

## Code style

- Apps Script and Cloud Run core pipeline are JavaScript
- Eval functions are Python (need sacrebleu/rouge-score)
- Extract magic numbers and string literals into named constants
- Apps Script runs on V8 — ES6 features (Set, Map, const/let, arrow functions) are available

## Testing

- JS tests: `cd cloud-run && npm test` (Jest)
- Python tests: `cd cloud-run && python -m pytest` (requires `.venv`)

## Deployment

- Apps Script: `clasp push` from each `apps-script/` subdirectory
- Cloud Run: see `.claude/skills/cloud-run-functions/` for deploy recipes
- Shared code is bundled into function directories at deploy time, not deployed separately
