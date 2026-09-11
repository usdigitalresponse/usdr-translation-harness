# Eval: Quality

LLM-as-judge quality evaluation of translations. Scores translations against a five-dimension rubric and returns per-block evaluations with strengths, issues, and recommendations.

## How it works

1. Receives either a translation JSON URL or inline blocks
2. Builds an evaluation prompt using the rubric (dimensions and weights are defined in the prompt Google Doc)
3. Calls the LLM for evaluation
4. Validates the output against a JSON schema
5. Returns scored evaluations

## HTTP interface

Two input modes:

```
POST { translationJsonUrl }
→ 200 with evaluations (scores the stored translation JSON)

POST { blocks, documentId?, metadata? }
→ 200 with evaluations (scores the provided blocks directly)
```

The Editor Add-on uses the second mode to evaluate the reviewer's current doc content (post-edits), not the stored JSON.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, prompt building, response parsing |
| `quality_llm.py` | LLM provider calls (Anthropic, Google AI) |
| `quality_loaders.py` | Google Drive and config I/O |
| `eval-schema-*.json` | JSON schemas for validating LLM output |
| `requirements.txt` | Python dependencies |

## Dependencies

- **anthropic** / **google-generativeai** — LLM provider SDKs
- **jsonschema** — validates LLM output structure
- **googleapis / google-auth** — Google Drive API access
