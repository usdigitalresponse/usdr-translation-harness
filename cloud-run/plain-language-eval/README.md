# Plain Language Eval

Evaluates source documents for readability and plain language compliance using an LLM-as-judge. Runs alongside extraction when a document is submitted — it evaluates the *source* content, not the translation.

## How it works

1. Receives a document reference from the Orchestrator (same trigger as Extract)
2. Downloads and reads the source document from Google Drive
3. Sends the content to an LLM for plain language evaluation
4. Validates the output against a JSON schema
5. Writes the evaluation JSON to a dedicated Drive folder, tagged with a `plainLanguageEvalSourceFileId` Drive property set to the source file's ID

The Editor Add-on's plain language eval sidebar finds the result by querying for that property, using the `sourceFileId` from the translation JSON. Because it's a property query, not a folder search, results are still found after the archive sweep moves them. If the LLM returns invalid JSON, the raw output is still saved for debugging but is not tagged, so the sidebar never loads it.

## HTTP interface

```
POST { fileId, fileName, mimeType? }
→ 202 Accepted
```

Fire-and-forget: returns immediately and runs the evaluation on a background thread.

## Files

| File | Purpose |
|---|---|
| `index.js` | HTTP entrypoint, orchestration |
| `llm.js` | LLM provider calls (Anthropic, Google AI) |
| `loaders.js` | Google Drive and config I/O |
| `plain-language-schema-*.json` | JSON schemas for validating LLM output |

## Dependencies

- **@anthropic-ai/sdk** / **@google/genai** — LLM provider SDKs
- **googleapis** — Google Drive API access
- **http-status-codes** — standard HTTP status constants
