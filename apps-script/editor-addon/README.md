# Editor Add-on

Google Docs editor add-on for reviewing AI-generated translations. When a reviewer opens a translation output doc, the add-on provides a sidebar for reviewing AI suggestions (alternative translations, flagged terms, glossary cross-checks), a plain language evaluation sidebar, and a "Submit Review" menu item that sends the reviewer's edits to the Capture Feedback Cloud Run function.

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
  flagged: { "terms_flagged_for_clarification::0": true, ... },
  altScope: { "alt_translations::1": { "b01": "original cell text...", "b02": "..." }, ... }
}
```

`altScope` stores pre-replacement cell text snapshots for items where "Use alternative" was applied. These snapshots enable safe revert — see section 5.

Keys are `section_name::flat_index` where the flat index comes from iterating all blocks' items for that section in order. This is the same flattening that `getSidebarData()` performs when building the sidebar's item list, and the Capture Feedback function's `buildSidebarKeyToBlockMap()` replays it to map keys back to block IDs.

### 4. Highlighting

Clicking a review card or reference row highlights the corresponding text in the document table. The add-on searches the two-column table (English / Spanish) for the original phrase and translation, and sets a gold background color. Highlights are cleared when the sidebar closes or when the reviewer moves to another item.

### 5. Use Alternative and Revert

When the reviewer clicks "Use alternative" on an alt_translations card, the sidebar calls `replaceTranslationInDoc(currentText, altText, blockId, replaceAll)`. This finds the text in the document's translation table by block ID and replaces it using Apps Script's `replaceText()`.

If the phrase appears in multiple blocks, the reviewer chooses between "Use in this block" (single block ID) and "Use everywhere" (all rows containing the phrase).

Before replacing, the server captures a snapshot of each affected cell's text. These snapshots are stored in the sidebar state (`altScope`) so that revert can restore the original text exactly, without a reverse find-and-replace that could corrupt other instances of the replacement text in the same cell.

**Revert:** When the reviewer clicks the undo arrow or "Review again" on a reviewed alternative item, the sidebar calls `revertAlternativeInDoc(snapshots)`, which restores each affected cell to its pre-replacement text using `setText()`. If no snapshots are available (e.g., the alternative was accepted before snapshot tracking was added) or the block can't be found in the table, the UI shows a "Could not revert" indicator instead of the undo arrow.

### 6. Time-to-approve tracking

The first time `showReviewPanel()` opens the sidebar, it records an ISO timestamp in document properties (`SIDEBAR_OPENED_AT` key). This timestamp is included in the submit payload so the Capture Feedback function can compute seconds elapsed between first sidebar open and review submission.

### 7. Plain Language Eval sidebar

Selecting "View Plain Language Eval" opens a sidebar displaying the plain language evaluation for the document's source file. The eval is produced by the `plain-language-eval` Cloud Run function, which runs independently alongside extraction when a document is submitted.

**Lookup strategy:** The sidebar calls `getPlainLanguageEvalData()`, which:

1. Reads the `sourceFileId` from the translation JSON (set during translation)
2. Resolves the source filename via `Drive.Files.get()`
3. Searches the plain-language-eval Drive folder (`1Sa5r8G4YMo0Hn02rCjyClixN0jCgbQ5U`) for files matching the base filename and containing `plain-language-eval` in the name
4. Returns the most recent match (ordered by `modifiedTime desc`)

No doc property links the translated doc to the eval JSON because the two services run in parallel with no guaranteed ordering. If no eval is found, the sidebar shows a "No evaluation found" message.

The sidebar displays:
- Overall weighted score (/5) and fix priority rating
- Overall summary
- Per-dimension scores and priorities for: Accuracy & Relevance (30%), Clarity/Simplicity/Accessibility (25%), Structure for Action (20%), Active Voice & Tone (15%), Consistency & Style (10%)
- Strengths, issues, recommendations, and examples for each dimension
- A "View source" link to preview the source PDF
- Debug section with the full evaluation JSON

### 8. Submit Review

Selecting "Submit Review" from the menu:

1. Confirms with the reviewer via a dialog
2. Reads the sidebar state (status + flagged) and orphan checks from document properties
3. Reads the `SIDEBAR_OPENED_AT` timestamp
4. Sends the payload to the Capture Feedback Cloud Run function via `UrlFetchApp.fetch()`, authenticated with an identity token
5. Displays the result (number of terminology decisions captured, any warnings)

### 9. Orphan detection

`checkItemsExist()` checks whether each reviewable item's original phrase and translation still appear in the document text. Items whose text is missing are "orphans" — this means the reviewer edited the text directly in the doc. Orphan status is sent to Capture Feedback and used to distinguish signals like `accepted_then_changed` (accepted in sidebar but text was edited) vs. `accepted` (accepted and left unchanged).

## Files

| File | Purpose |
|---|---|
| `addon.js` | All server-side logic: menu, sidebar data, highlighting, text replacement, submit |
| `Sidebar.html` | Sidebar UI — card-based review flow, status tracking, highlight interaction |
| `Evaluationsidebar.html` | Evaluation sidebar (separate feature, not part of the review flow) |
| `PlainLanguageEvalSidebar.html` | Plain language eval sidebar — displays rubric-based eval results for the source document |
| `test-helpers.js` | Utility functions used by the sidebar for local/manual testing |
| `appsscript.json` | Manifest — scopes, add-on config, URL whitelist |

## Evaluation 

Evaluation is its own process: it scores a translation with an LLM-as-judge and writes nothing back to the pipeline.

`showEvaluationPanel` opens `Evaluationsidebar.html`, which scores **the reviewer's current doc content** rather than the stored translation JSON, so re-running after edits reflects those edits.

```
Evaluationsidebar.html
  └─ evaluateTranslationFromSidebar()
       ├─ extractDocBlocks_()   reads the English/Spanish table (col 0 / col 1)
       ├─ POST { documentId, blocks, metadata } → Eval Quality Cloud Run function
       └─ caches the result in document properties (EVAL_RESULT)
  └─ getEvalData()              reads the cached result back on open
```

The eval function accepts either `blocks` (this path) or `translationJsonUrl` (scores the stored JSON). Results are cached because each run costs an LLM call; reopening the sidebar does not re-evaluate.

Document properties cap values at 9KB. If an evaluation exceeds that, `source_text` and `translated_text` are dropped from the cache so the scores still survive.

## Configuration notes

**Timezone:** Set to `America/New_York` in `appsscript.json` for Maryland deployment.

**Exception logging:** `STACKDRIVER` routes Apps Script errors to Cloud Logging in the linked GCP project (viewable in GCP Console -> Logging -> Log Explorer). This requires the Apps Script project to be linked to a GCP project under Project Settings -> Google Cloud Platform Project.

**OAuth scopes:**
- `auth/documents` — read the currently open doc; create temp docs for DOCX export
- `auth/script.container.ui` — add menus and show the sidebar
- `auth/drive` — read Drive file properties, fetch translation JSON, export and trash temp docs
- `auth/script.external_request` — call the Capture Feedback Cloud Run function
- `openid` + `auth/userinfo.email` — generate an identity token for Cloud Run IAM authentication

**Advanced Services:**
- Drive API v3 — reads the `usdr_translation_review` property from the Drive file. This is a Drive file property (set via the Drive API), NOT an Apps Script document property (PropertiesService) — those are separate storage systems.

## Required Script Properties

Set these in the Script Editor under Project Settings -> Script Properties:

| Property | Description |
|---|---|
| `CAPTURE_FEEDBACK_FUNCTION_URL` | Deployed Capture Feedback Cloud Run function URL |
| `EVAL_QUALITY_FUNCTION_URL` | Deployed Eval Quality Cloud Run function URL |

## Setup

1. Create an Apps Script project at [script.google.com](https://script.google.com)
2. Link it to the GCP project under Project Settings
3. Update `.clasp.json` with the script ID
4. **Before `clasp push`:** Replace `<GCP_PROJECT_NUMBER>` in `appsscript.json`'s `urlFetchWhitelist` with the actual GCP project number. Do not commit the real value.
5. Run `clasp push --force` to deploy
6. Create a versioned deployment with `clasp deploy -i <DEPLOYMENT_ID>` (run `clasp deployments` to find the ID)
7. Update the version number in GCP Console -> Marketplace SDK -> App Configuration
8. Publish from Store Listing in the Marketplace SDK
