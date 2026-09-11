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
| `llm.js` | LLM provider calls (Anthropic, Google AI) |
| `doc-writer.js` | Creates the output Google Doc with the two-column translation table |
| `loaders.js` | Google Drive and config I/O, output writing |
| `notifier.js` | Email notifications via Gmail API |
| `retry.js` | Retry wrapper for transient failures |
| `translation-schema-*.json` | JSON schemas for validating LLM output |
| `extraction-context.md` | Prompt fragment: instructions for handling extracted text blocks |
| `prompt-statute-additions.md` | Prompt fragment: statute reference instructions |

## Dependencies

- **@anthropic-ai/sdk** / **@google/genai** — LLM provider SDKs
- **googleapis** — Google Drive, Docs, Sheets, Gmail APIs
- **@google-cloud/storage** — Cloud Storage access
- **http-status-codes** — standard HTTP status constants
