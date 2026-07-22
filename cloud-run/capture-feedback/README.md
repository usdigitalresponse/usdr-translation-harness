# Capture Feedback

Receives a Google Doc ID after a reviewer submits their review, diffs the reviewer's edits against the original AI translation, classifies each change with a review signal, and writes terminology decisions to a derived glossary sheet. Also stores full feedback JSON in Drive and emits structured logs for Cloud Logging dashboards.

## How it works

The function runs as a single HTTP request with ten sequential steps:

1. **Read document properties** — looks up the `usdr_translation_review` Drive file property on the submitted doc to find the translation JSON file ID (set by the Translate function when creating the doc).

2. **Fetch translation JSON** — downloads the stored AI output from Drive. This contains the original extraction blocks, translated text, and per-block metadata (alternative translations, flagged terms, glossary cross-checks).

3. **Read the Google Doc** — uses the Docs API to read the two-column table (Original Text / Translated Text) from the reviewer-edited document.

4. **Diff blocks** — compares each AI-translated block against the reviewer's version using word-level diffing (via the `diff` library) and computes character-level and word-level Levenshtein edit distances.

5. **Classify sidebar state** — the request includes `sidebarChecks` and `sidebarOrphans` from the editor add-on. `sidebarChecks` captures what the reviewer did in the sidebar: which items they accepted, used an alternative for, or fixed manually (`status`), and which items they flagged as needing work (`flagged`). `sidebarOrphans` captures which items' text no longer appears in the document, meaning the reviewer edited it directly. These are keyed by `"section::flatIndex"` (e.g. `"alt_translations::0"`). The function uses `buildSidebarKeyToBlockMap()` to map these flat keys back to block IDs so each block gets only its own sidebar signals.

6. **Extract decisions** — pairs up removed/added word spans from the diff into terminology decisions (aiTerm -> reviewerTerm). Each decision is classified with a review signal (derived from the sidebar state in step 5) and routed to a glossary tab.

7. **Compute metrics** — calculates acceptance rate, edit distances (total and normalized), and time-to-approve (seconds between sidebar open and submit).

8. **Emit structured log** — writes a JSON log line to stdout with all metrics, picked up by Cloud Logging for dashboards.

9. **Write to derived glossary** — appends terminology decisions to the appropriate tabs in the derived glossary Google Sheet.

10. **Store feedback JSON** — saves the full feedback result (metrics, decisions, diffs) as a JSON file in a Drive folder for archival.

## Request format

```
POST { documentId, sidebarChecks, sidebarOrphans, sidebarOpenedAt }
```

- `documentId` (required) — Google Doc ID of the reviewed translation
- `sidebarChecks` — `{ status: { "section::index": "accepted"|"alternative"|"fixed" }, flagged: { "section::index": true } }` persisted by the sidebar
- `sidebarOrphans` — `{ "section::index": true }` for items whose original text no longer appears in the doc (indicating the reviewer edited it)
- `sidebarOpenedAt` — ISO timestamp of when the reviewer first opened the sidebar

The editor add-on constructs and sends this payload from `submitReview()`.

## Review signals

Each block gets classified with the strongest signal from the reviewer's sidebar interactions. Signals are ranked by priority (strongest first):

| Signal | Meaning | How it's determined |
|---|---|---|
| `used_alternative` | Reviewer chose the AI's suggested alternative | Sidebar status is "alternative" |
| `fixed_manually` | Reviewer marked it as manually fixed | Sidebar status is "fixed" |
| `accepted_then_changed` | Accepted in sidebar, then edited the doc text | Status is "accepted" + text is an orphan |
| `needs_work` | Reviewer flagged the item | Flagged in sidebar |
| `accepted` | Reviewer accepted with no changes | Status is "accepted", text unchanged |
| `changed_without_review` | Text was edited but reviewer didn't use sidebar | Orphan with no sidebar status |
| `no_sidebar_interaction` | No sidebar data for this block | Fallback |

## Glossary tab routing

Terminology decisions are routed to one of three tabs in the derived glossary sheet:

- **Reviewed** — reviewer interacted with the sidebar for this block (highest confidence signals)
- **ModelFlagged** — the changed text overlaps with a phrase the model flagged (alternative translations, clarification terms, etc.)
- **OtherChanges** — everything else (grammar fixes, short words, incidental edits)

Each tab has columns: timestamp, aiTerm, reviewerTerm, blockId, reviewSignal, docUrl, translationJsonUrl.

## Sidebar key mapping

The sidebar uses flat keys like `alt_translations::0`, `terms_flagged_for_clarification::3` to identify items. `buildSidebarKeyToBlockMap()` replays the same flattening logic as the add-on's `getSidebarData()` to map these keys back to block IDs. This lets `classifyBlockSignal()` only consider sidebar items that belong to the block being classified.

## Files

| File | Purpose |
|---|---|
| `index.js` | HTTP handler — orchestrates the nine steps, returns response |
| `decisions.js` | Signal classification, tab routing, sidebar key mapping |
| `differ.js` | Word-level diffing and Levenshtein edit distance |
| `doc-reader.js` | Reads the two-column translation table from a Google Doc via the Docs API |
| `loaders.js` | Drive operations — read translation JSON, store feedback JSON |
| `glossary-writer.js` | Appends decisions to the derived glossary sheet via Sheets API |
| `metrics.js` | Acceptance rate, edit distances, time-to-approve |

## Environment variables

| Variable | Description |
|---|---|
| `DERIVED_GLOSSARY_SHEET_ID` | Google Sheet ID for the derived glossary (terminology decisions are written here) |
| `DRIVE_FEEDBACK_FOLDER_ID` | Drive folder ID where feedback JSON files are stored |
