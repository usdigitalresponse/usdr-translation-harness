# Orchestrator

Watches a Google Drive input folder for new PDFs and calls the Extract Cloud Run function.

## Configuration notes

**Timezone:** Set to `America/Los_Angeles` for development. Update to `America/New_York` in `appsscript.json` when deploying for Maryland.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console → Logging → Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings → Google Cloud Platform Project. Centralizes logs alongside Cloud Run function logs and supports log-based alerts.

**OAuth scopes:**
- `auth/drive` — read PDFs and watch the input folder
- `auth/spreadsheets` — read/write the processing log Google Sheet
- `auth/script.external_request` — call the Extract Cloud Run function via `UrlFetchApp`

## Required Script Properties

Set these in the Script Editor under Project Settings → Script Properties:

| Property | Description |
|---|---|
| `INPUT_FOLDER_ID` | Google Drive folder ID the orchestrator watches for new PDFs |
| `EXTRACT_FUNCTION_URL` | Deployed Extract Cloud Run function URL |
| `PROCESSING_LOG_SHEET_ID` | Google Sheet ID for the processing log (must have a tab named `ProcessingLog` with headers: `fileId`, `fileName`, `processedAt`, `status`) |

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. Run `clasp push` to deploy
