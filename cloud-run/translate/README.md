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
7. Sets a `usdr_translation_review` Drive file property on the output doc so the Editor Add-on can find the translation JSON
8. Writes the full translation JSON to Drive
9. Sends an email notification to the submitter

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
| `notifier.js` | Email notifications via Gmail API |
| `retry.js` | Retry wrapper for transient failures |
| `translation-schema-*.json` | JSON schemas for validating LLM output |
| `extraction-context.md` | Prompt fragment: instructions for handling extracted text blocks |
| `prompt-statute-additions.md` | Prompt fragment: statute reference instructions |

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
- **googleapis** — Google Drive, Docs, Sheets, Gmail APIs
- **@google-cloud/storage** — Cloud Storage access
- **http-status-codes** — standard HTTP status constants
