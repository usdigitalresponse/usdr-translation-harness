# Translate

Translates extracted content using an LLM and creates output Google Docs with a two-column English/Spanish table.

## How it works

1. Receives a Pub/Sub push message (or direct HTTP POST) with the extraction JSON location
2. Downloads the extraction JSON from Google Drive
3. Assembles the translation prompt from:
   - A system prompt (stored as a Google Doc)
   - The glossary (read from a Google Sheet)
   - Relevant statute references (if the content type includes them)
   - The extracted text blocks
4. Calls the LLM for translation
5. Validates the output against a JSON schema
6. Creates a Google Doc in the output Drive folder with the translated content in a two-column table (English source | Spanish translation)

   Processing Log rows: a `translated` (or `failed`) row as soon as each model's translation JSON is saved (translation JSON ID in `outputJsonId`), then a second row once its doc step finishes: `doc-created` with the doc's URL in `outputDocUrl` (clickable in the sheet), or `doc-failed` with the error. Both are appended (the sheet is never edited in place), so a doc failure or a timeout during the doc build still leaves the `translated` row. The doc step is also logged as a structured entry with `pipeline_stage: "translate_doc"` (`status`, `docId`, `translationFileId`, `duration_ms`).
7. Sets a `usdr_translation_review` Drive file property on the output doc so the Editor Add-on can find the translation JSON
8. Writes the full translation JSON to Drive
9. Posts a "translation ready" (or doc-creation failure) message to a Google Chat space via an incoming webhook (`GOOGLE_CHAT_WEBHOOK_URL`); skipped if unset

## HTTP interface

Accepts either a Pub/Sub push envelope or a direct POST:

```
POST { extractionFileId, sourceFileName, sourceFileId?, contentType?, submittedByEmail? }
→ 200 with translation results JSON
```

Synchronous — the function returns after the output doc is created.

## Files

| File | Purpose |
|---|---|
| `index.js` | HTTP entrypoint, orchestration |
| `prompt-assembly.js` | Builds the full prompt: system prompt + glossary + statutes + extraction context |
| `llm.js` | LLM provider calls (Claude, Gemini) via Vertex AI or the direct APIs |
| `doc-writer.js` | Creates the output Google Doc with the two-column translation table |
| `loaders.js` | Google Drive and config I/O, output writing |
| `notifier.js` | Google Chat notifications via an incoming webhook |
| `retry.js` | Retry wrapper for transient failures |
| `translation-schema-*.json` | JSON schemas for validating LLM output |
| `extraction-context.md` | Prompt fragment: instructions for handling extracted text blocks |
| `prompt-statute-additions.md` | Prompt fragment: statute reference instructions |

## Glossary

Read from the `GLOSSARY_SHEET_TAB` tab (default `FAMLI Spanish Glossary`) of `GLOSSARY_SHEET_ID`, columns A:I. **Row 1 must be the header row**, with these column names (case-insensitive): English Term, Acronym or Abbreviation, Approved Spanish, Forbidden Terms, Definition/Context, Example English, Example Spanish, Notes. Status is in the sheet but not read (it's currently unused; draft and approved entries are treated the same). Rows without an English Term are skipped.

Each translation logs `Glossary: N entries included in the prompt (…with forbidden terms; …rows skipped; …rows read)`, and the structured log line includes `glossary_entries` and `glossary_entries_with_forbidden`.

If the glossary can't be used as expected, Translate continues without it (or without the missing fields) and logs a structured **ERROR** with an `input_problem: "glossary"` field and a message starting `Translation input problem (glossary):`. All input problems (glossary, statutes, Model Config) share the `input_problem` field, so one log-based alert on `jsonPayload.input_problem:*` catches them. This happens when:
- the tab can't be read (e.g. renamed tab, missing access)
- expected columns are missing from row 1 (e.g. a row above the headers, or a renamed column); the log lists `missing_columns` and `found_headers`
- no entries made it into the prompt

## Statutes

Statute files are read from `STATUTES_GCS_BUCKET` under `STATUTES_GCS_PREFIX` (default `statutes/md-labor-emply-t8.3/`). Each translation logs `Statutes: N sections included in the prompt`. If the files can't be read or none are found, Translate continues without statutes and logs a structured **ERROR** with `input_problem: "statutes"` (the bucket and prefix are in `statutes_bucket` / `statutes_prefix`).

## Model Config sheet

Models come from the `Config!A:F` range of the Model Config sheet (`MODEL_CONFIG_SHEET_ID`). **Row 1 must be the header row** and include `Role`, `Provider`, `Model`, and `Active` (case-insensitive). Without `MODEL_CONFIG_SHEET_ID`, the service uses `fixtures/config.json` for local development, but **on Cloud Run a missing `MODEL_CONFIG_SHEET_ID` is an error** so a deploy that loses its env vars can't run on test models.

Config problems (missing env var on Cloud Run, missing columns, no data rows) stop the run and log a structured **ERROR** with `input_problem: "model_config"` and a message starting `Translation input problem (model_config):`. Missing columns are listed in `missing_columns`, with the headers found in `found_headers`.

## LLM backends (Vertex AI migration in progress)

`callLlm` in `llm.js` can reach each provider two ways:

- **Vertex AI** — authenticates as the Cloud Run service account (`roles/aiplatform.user`); no API keys. Claude uses `AnthropicVertex` from `@anthropic-ai/vertex-sdk`; Gemini uses `@google/genai` with `vertexai: true`.
- **Direct** — the Anthropic API and Gemini Developer API, using `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

| Env var | Default | Meaning |
|---|---|---|
| `LLM_BACKEND` | `vertex-first` | `vertex-first` (fall back to direct), `vertex-only`, or `direct-only` |
| `VERTEX_PROJECT_ID` | — | GCP project for Vertex calls. If unset, `vertex-first` goes straight to direct |
| `VERTEX_LOCATION` | `us` | Vertex location (`us`, `global`, or a region) |

With `vertex-first`, a Vertex failure falls back to direct **only** for errors raised before generation: 401/403 (auth), 404 (model not enabled or not offered in the location), 429 (quota), missing default credentials, or missing `VERTEX_PROJECT_ID`. Timeouts, 5xx, and invalid output are raised as-is. Every successful call logs `llm_backend` (`vertex` / `direct`) and, after a fallback, `llm_fallback_reason` in the structured log entry. Tests: `cloud-run/tests/test_llm_backends.js`.

Model IDs in the Model Config sheet are the same for both backends.

## Dependencies

- **@anthropic-ai/sdk** / **@anthropic-ai/vertex-sdk** / **@google/genai** — LLM provider SDKs (the Vertex SDK adds Claude-on-Vertex auth)
- **googleapis** — Google Drive, Docs, Sheets APIs
- **@google-cloud/storage** — Cloud Storage access
- **http-status-codes** — standard HTTP status constants
