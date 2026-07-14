# Orchestrator

Watches a Google Drive input folder for new files and calls the Extract Cloud Run function. Supports PDFs, Google Docs, and DOCX files.

## Configuration notes

**Timezone:** Set to `America/New_York` in `appsscript.json` for the Maryland deployment.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console → Logging → Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings → Google Cloud Platform Project. Centralizes logs alongside Cloud Run function logs and supports log-based alerts.

**OAuth scopes:**
- `auth/drive` — read files and watch the input folder
- `auth/spreadsheets` — read/write the processing log Google Sheet
- `auth/script.external_request` — call the Extract Cloud Run function via `UrlFetchApp`
- `auth/script.scriptapp` — create and manage time-based triggers
- `openid` + `auth/userinfo.email` — generate an identity token for authenticated Cloud Run invocation

## Required Script Properties

Set these in the Script Editor under Project Settings → Script Properties:

| Property | Description |
|---|---|
| `INPUT_FOLDER_ID` | Google Drive folder ID the orchestrator watches for new files (PDFs, Google Docs, DOCX) |
| `EXTRACT_FUNCTION_URL` | Deployed Extract Cloud Run function URL |
| `PROCESSING_LOG_SHEET_ID` | Google Sheet ID for the processing log (must have a tab named `ProcessingLog` with headers: `fileId`, `fileName`, `processedAt`, `status`, `durationMs`, `errorDetail`, `extractionFileId`, `provider`, `model`). Share with the Cloud Run service account as Editor so Extract can write back to it. |

## Processing log statuses

| Status | Written by | Meaning |
|---|---|---|
| `triggered` | Orchestrator | Extract function was called; processing in background |
| `complete` | Extract | Orchestrator's row updated after all extractions finish |
| `extracted` | Extract | One row per model extraction with the output file ID |
| `failed` | Orchestrator | Extract function call returned an error |

When multiple extract models are active, a single PDF produces multiple `extracted` rows (one per model). Google Docs and DOCX files produce a single `extracted` row with `provider: passthrough` / `model: text` since no LLM is needed. A saved filter view sorted by `fileId` then `processedAt` groups related rows together.

## Retry behavior

Files that failed extraction are automatically retried on subsequent trigger runs. The orchestrator skips any file that has at least one non-`failed` log entry — files that only have `failed` entries (or no log entry at all) will be re-processed.

To stop retrying a specific file, manually edit its status in the ProcessingLog sheet to `complete`. To stop retrying all failed files, filter the sheet for `failed` rows and bulk-update them to `complete`.

> **TODO (confirm with Maryland):** Verify this automatic retry behavior is acceptable, or whether they'd prefer a manual retry workflow.

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. Run `clasp push` to deploy
