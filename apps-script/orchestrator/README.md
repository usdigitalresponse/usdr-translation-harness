# Orchestrator (Apps Script)

Standalone Apps Script project that drives the pipeline's entry point and one of
its automated eval triggers.

Two responsibilities:

1. **Drive folder watcher** — on a 5-minute time trigger, `watchForNewFiles`
   scans the input folder(s) for PDFs / Google Docs / DOCX and fires the Extract
   and Plain-Language Eval Cloud Run functions (fire-and-forget, `202`), logging
   each attempt to the Processing Log sheet.
2. **Model-change detection** — an installable `onEdit` trigger on the model
   config sheet (`onConfigEdit`) fires the **Drift eval** whenever an edit
   changes the active model(s) it depends on.
3. **Weekly drift cadence** — a weekly time trigger (`runWeeklyDrift`) fires the
   same Drift eval on a schedule, and backstops config changes made outside the
   Sheet UI (which the `onEdit` trigger can't see).

## Script Properties

Set under Project Settings → Script Properties (values come from the repo `.env`).

| Property | Used by | Description |
|---|---|---|
| `INPUT_FOLDER_ID` | watcher | Drive folder watched for incoming files |
| `INPUT_FOLDER_ID_CONTENT_TYPE_TWO` | watcher | Optional second input folder (different content type) |
| `EXTRACT_FUNCTION_URL` | watcher | Extract Cloud Run URL |
| `PLAIN_LANGUAGE_EVAL_FUNCTION_URL` | watcher | Plain-Language Eval Cloud Run URL |
| `PROCESSING_LOG_SHEET_ID` | watcher | Processing Log sheet (tab `ProcessingLog`) |
| `MODEL_CONFIG_SHEET_ID` | model-change | The model config spreadsheet (tab `Config`) to watch |
| `EVAL_DRIFT_FUNCTION_URL` | model-change, weekly | Drift eval Cloud Run URL to POST |
| `LAST_ACTIVE_MODEL_SIGNATURE` | model-change | Managed automatically — the last-seen active-model fingerprint (do not set by hand) |

## Setup

Push the code (`clasp push`), then from the Apps Script editor run each setup
function once and approve the OAuth consent:

- **`createTimeTrigger`** — installs the 5-minute `watchForNewFiles` trigger.
- **`createConfigTrigger`** — installs the `onConfigEdit` trigger on
  `MODEL_CONFIG_SHEET_ID` and seeds the baseline signature. Requires the
  installing account to have access to the config sheet; the trigger then fires
  on edits by anyone and runs as that account. Prefer a shared/service account
  over a personal one so it survives staff changes.
- **`createDriftWeeklyTrigger`** — installs the weekly `runWeeklyDrift` time
  trigger (Mondays ~09:00, script timezone).

Each `create…Trigger` removes any existing trigger for its handler before
creating a new one, so re-running them won't stack duplicates.

## How model-change detection works

`onConfigEdit` doesn't inspect the edited cell. On any edit to the config sheet
it recomputes a **signature** of the active models in the `translate` and `eval`
roles (the only roles the drift eval exercises) — a sorted
`role:provider:model` join — and compares it to the stored
`LAST_ACTIVE_MODEL_SIGNATURE`:

- **unchanged** → no-op (unrelated edits and multi-cell edits are ignored);
- **changed** → POST `{ "trigger": "model_change" }` to the drift function with a
  Cloud Run identity token, and record the new signature **only on success** so a
  transient failure retries on the next edit.

Only human edits made in the Sheet UI fire an installable `onEdit`; a config
change made programmatically via the Sheets API would **not** trigger it (the
weekly scheduled drift run is the backstop for that case).

## Cross-component interfaces

| Caller | Callee | Contract |
|---|---|---|
| Orchestrator | Extract | `POST { fileId, fileName, mimeType }` → `202` |
| Orchestrator | Plain-Language Eval | `POST { fileId, fileName, mimeType, contentType }` → `202` |
| Orchestrator | Eval: Drift | `POST { trigger: "model_change" \| "weekly" }` → `202` (fire-and-forget) |

## Testing

Pure logic (config parsing, dedup sets, the model signature) is covered by Jest:

```sh
cd apps-script && npm test
```

Manual/integration functions live in `test-helpers.js` (run from the Apps Script
editor against real Google services).
