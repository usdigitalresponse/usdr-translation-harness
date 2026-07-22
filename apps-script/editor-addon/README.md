# Editor Add-on

Google Docs editor add-on for reviewing AI-generated translations. When a reviewer opens a translation output doc, the add-on provides a sidebar for reviewing AI suggestions (alternative translations, flagged terms, glossary cross-checks) and a "Submit Review" menu item that sends the reviewer's edits to the Capture Feedback Cloud Run function.

## How the review flow works

### 1. Document detection

When a translation output doc is opened, the add-on's `onOpen` trigger adds the "Translation Review" menu. The Translate Cloud Run function sets a `usdr_translation_review` Drive file property on each output doc, pointing to the stored translation JSON. The add-on reads this property via the Drive API v3 Advanced Service to determine whether the doc is a translation.

### 2. Sidebar

Selecting "Show AI Suggestions" opens a sidebar that displays reviewable items from the translation JSON. Items are organized into sections:

- **Alt Translations** — the model generated a primary and an alternative translation for a phrase. The reviewer can accept, use the alternative (which replaces text in the doc), or mark it as manually fixed.
- **Terms Flagged for Clarification** — the model flagged a term as potentially ambiguous. The reviewer can accept or mark it as "needs work."
- **Glossary Cross-Check** (reference only) — terms the model checked against the glossary. Displayed for context, not reviewable.
- **Back Translation of Key Phrases** (reference only) — the model's back-translation of key phrases for verification.

Each reviewable item becomes a card. The reviewer works through items one at a time, and their status is persisted to document properties (`SIDEBAR_CHECKS` key) as they go, so progress survives closing and reopening the sidebar.

### 3. Sidebar state shape

The sidebar persists reviewer decisions as:

```
{
  status: { "alt_translations::0": "accepted", "alt_translations::1": "alternative", ... },
  flagged: { "terms_flagged_for_clarification::0": true, ... }
}
```

Keys are `section_name::flat_index` where the flat index comes from iterating all blocks' items for that section in order. This is the same flattening that `getSidebarData()` performs when building the sidebar's item list, and the Capture Feedback function's `buildSidebarKeyToBlockMap()` replays it to map keys back to block IDs.

### 4. Highlighting

Clicking a review card or reference row highlights the corresponding text in the document table. The add-on searches the two-column table (English / Spanish) for the original phrase and translation, and sets a gold background color. Highlights are cleared when the sidebar closes or when the reviewer moves to another item.

### 5. Use Alternative

When the reviewer clicks "Use alternative" on an alt_translations card, the sidebar calls `replaceTranslationInDoc(currentText, altText, blockIndex)`. This finds the text in the document's translation table — first trying the exact row via `blockIndex`, then falling back to searching all rows — and replaces it using Apps Script's `replaceText()`.

### 6. Time-to-approve tracking

The first time `showReviewPanel()` opens the sidebar, it records an ISO timestamp in document properties (`SIDEBAR_OPENED_AT` key). This timestamp is included in the submit payload so the Capture Feedback function can compute seconds elapsed between first sidebar open and review submission.

### 7. Submit Review

Selecting "Submit Review" from the menu:

1. Confirms with the reviewer via a dialog
2. Reads the sidebar state (status + flagged) and orphan checks from document properties
3. Reads the `SIDEBAR_OPENED_AT` timestamp
4. Sends the payload to the Capture Feedback Cloud Run function via `UrlFetchApp.fetch()`, authenticated with an identity token
5. Displays the result (number of terminology decisions captured, any warnings)

### 8. Orphan detection

`checkItemsExist()` checks whether each reviewable item's original phrase and translation still appear in the document text. Items whose text is missing are "orphans" — this means the reviewer edited the text directly in the doc. Orphan status is sent to Capture Feedback and used to distinguish signals like `accepted_then_changed` (accepted in sidebar but text was edited) vs. `accepted` (accepted and left unchanged).

## Files

| File | Purpose |
|---|---|
| `addon.js` | All server-side logic: menu, sidebar data, highlighting, text replacement, submit |
| `Sidebar.html` | Sidebar UI — card-based review flow, status tracking, highlight interaction |
| `Evaluationsidebar.html` | Evaluation sidebar (separate feature, not part of the review flow) |
| `appsscript.json` | Manifest — scopes, add-on config, URL whitelist |

## Configuration notes

**Timezone:** Set to `America/New_York` in `appsscript.json` for Maryland deployment.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console -> Logging -> Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings -> Google Cloud Platform Project.

**OAuth scopes:**
- `auth/documents.currentonly` — read the currently open doc and its body/table
- `auth/script.container.ui` — add menus and show the sidebar
- `auth/drive.readonly` — read Drive file properties and fetch translation JSON
- `auth/script.external_request` — call the Capture Feedback Cloud Run function
- `openid` + `auth/userinfo.email` — generate an identity token for Cloud Run IAM authentication

**Advanced Services:**
- Drive API v3 — reads the `usdr_translation_review` property from the Drive file. This is a Drive file property (set via the Drive API), NOT an Apps Script document property (PropertiesService) — those are separate storage systems.

## Required Script Properties

Set these in the Script Editor under Project Settings -> Script Properties:

| Property | Description |
|---|---|
| `CAPTURE_FEEDBACK_FUNCTION_URL` | Deployed Capture Feedback Cloud Run function URL |

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. **Before `clasp push`:** Replace `<GCP_PROJECT_NUMBER>` in `appsscript.json`'s `urlFetchWhitelist` with the actual GCP project number. Do not commit the real value.
5. Run `clasp push --force` to deploy
6. Create a versioned deployment with `clasp deploy -i <DEPLOYMENT_ID>` (run `clasp deployments` to find the ID)
7. Update the version number in GCP Console -> Marketplace SDK -> App Configuration
8. Publish from Store Listing in the Marketplace SDK
