# Editor Add-on

Adds a "Submit Review" menu to translation output Google Docs. Checks for the `usdr_translation_review` document property set by the Translate Cloud Run function — if present, shows the review option.

## Configuration notes

**Timezone:** Set to `America/Los_Angeles` for development. Update to `America/New_York` in `appsscript.json` when deploying for Maryland.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console → Logging → Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings → Google Cloud Platform Project. Centralizes logs alongside Cloud Run function logs and supports log-based alerts.

**OAuth scopes:**
- `auth/documents.currentonly` — read and check properties on the currently open doc only (more restrictive than `auth/documents`, which would grant access to all docs)
- `auth/script.container.ui` — add menus to the Docs UI

## Required Script Properties

Set these in the Script Editor under Project Settings → Script Properties:

| Property | Description |
|---|---|
| `CAPTURE_FEEDBACK_FUNCTION_URL` | Deployed Capture Feedback Cloud Run function URL |

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. Run `clasp push` to deploy
5. Publish as an Editor Add-on and push-install to reviewer accounts via Workspace Admin
