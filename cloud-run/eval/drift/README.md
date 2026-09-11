# Eval: Drift

Regression detection for translation quality. Compares new translations against a golden translation set using NLP metrics (BLEU, ROUGE) and LLM-as-judge evaluation to flag quality drift.

## How it works

1. Triggered via HTTP POST
2. Loads the golden translation set from Google Drive
3. Computes BLEU and ROUGE scores comparing current translations against the golden set
4. Runs an LLM-as-judge evaluation on segments where metric scores indicate potential drift
5. Validates the output against a JSON schema
6. Returns drift analysis results

## HTTP interface

```
POST { trigger? }
→ 202 Accepted
```

Fire-and-forget: runs the drift analysis on a background thread.

## Files

| File | Purpose |
|---|---|
| `main.py` | HTTP entrypoint, metric computation, LLM judging |
| `drift_llm.py` | LLM provider calls (Anthropic, Google AI) |
| `drift_loaders.py` | Golden translation set and config I/O |
| `drift-schema-*.json` | JSON schemas for validating LLM output |
| `requirements.txt` | Python dependencies |

## Dependencies

- **sacrebleu** — BLEU score computation
- **rouge-score** — ROUGE score computation
- **anthropic** / **google-generativeai** — LLM provider SDKs
- **jsonschema** — validates LLM output structure
