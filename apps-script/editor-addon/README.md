# Editor Add-on

Adds a "Submit Review" menu to translation output Google Docs. Checks for the `usdr_translation_review` document property set by the Translate Cloud Run function — if present, shows the review option.

## Configuration notes

**Timezone:** Set to `America/Los_Angeles` for development. Update to `America/New_York` in `appsscript.json` when deploying for Maryland.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console → Logging → Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings → Google Cloud Platform Project. Centralizes logs alongside Cloud Run function logs and supports log-based alerts.

**OAuth scopes:**
- `auth/documents.currentonly` — read the currently open doc
- `auth/script.container.ui` — add menus to the Docs UI
- `auth/drive.readonly` — read Drive file properties set by the Cloud Run translate function

**Advanced Services:**
- Drive API v3 — enabled in `appsscript.json` to read the `usdr_translation_review` property from the Drive file. This is a Drive file property (set via the Drive API), NOT an Apps Script document property (PropertiesService) — those are separate storage systems.

## Required Script Properties

Set these in the Script Editor under Project Settings → Script Properties:

| Property | Description |
|---|---|
| `CAPTURE_FEEDBACK_FUNCTION_URL` | Deployed Capture Feedback Cloud Run function URL |

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. **Before `clasp push`:** Replace `<GCP_PROJECT_NUMBER>` in `appsscript.json`'s `urlFetchWhitelist` with the actual GCP project number. Do not commit the real value.
5. Run `clasp push` to deploy
6. Publish as an internal Workspace Marketplace add-on (see App Configuration in the Marketplace SDK)
