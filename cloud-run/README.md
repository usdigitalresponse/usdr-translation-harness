# Cloud Run Functions

Backend functions for the translation pipeline. Each function is self-contained and deployable independently from its own directory.

## Pipeline functions

These run in sequence for each submitted document:

| Function | Language | Trigger | Description |
|---|---|---|---|
| [`extract/`](./extract/) | Python | HTTP POST from Orchestrator | Extracts structured text blocks from source documents |
| [`translate/`](./translate/) | JavaScript | Pub/Sub push from Extract | Translates extracted content, creates output Google Docs |
| [`capture-feedback/`](./capture-feedback/) | JavaScript | HTTP POST from Editor Add-on | Diffs reviewer edits against LLM output, writes terminology decisions to glossary |

## Evaluation functions

These run independently and do not modify the pipeline:

| Function | Language | Description |
|---|---|---|
| [`eval/quality/`](./eval/quality/) | Python | LLM-as-judge quality scoring against a rubric |
| [`eval/drift/`](./eval/drift/) | Python | Regression detection using BLEU/ROUGE + LLM-as-judge against golden translations |
| [`plain-language-eval/`](./plain-language-eval/) | JavaScript | Evaluates source document readability (triggered by Orchestrator alongside Extract) |

## Testing

JavaScript tests (Jest):
```bash
npm test
```

Python tests (pytest):
```bash
python -m pytest
```

## Language split

Cloud Run functions default to JavaScript — Maryland stakeholders are more familiar with JS. Extract and the eval functions are Python because they depend on libraries that don't have JS equivalents (pdfplumber, sacrebleu, rouge-score).
