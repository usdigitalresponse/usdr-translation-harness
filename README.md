# USDR × Maryland AI Translation Infrastructure

This repository contains the infrastructure for AI-assisted translation of Maryland government benefits content. It automates PDF-to-translated-document workflows, collects reviewer feedback, and builds a terminology glossary over time.

## Architecture

The system has two layers that communicate over HTTP:

- **Apps Script (Google Workspace)** — orchestrates the pipeline from Drive and provides the reviewer-facing UI inside Google Docs
- **Cloud Run (GCP)** — hosts the extraction, translation, evaluation, and feedback capture functions

```
Apps Script (Google Workspace)                Cloud Run (GCP)
──────────────────────────                    ──────────────

Orchestrator                                  Extract
  watches Drive for new documents               extracts structured text blocks from
  calls Extract (fire-and-forget)               PDFs, Google Docs, DOCX
                                                publishes to Pub/Sub
                                                    │
                                                    ▼
                                              Translate
                                                loads prompt + glossary, calls LLM
                                                creates output Google Doc
                                                    │
                                                    ▼
Editor Add-on                                 Capture Feedback
  review sidebar for AI suggestions,            diffs reviewer edits against LLM output
  alternatives, glossary cross-checks           writes terminology decisions to glossary
  calls Capture Feedback on submit

                                              Plain Language Eval
                                                evaluates source doc readability
                                                runs alongside extraction

                                              Eval: Quality
                                                LLM-as-judge translation scoring
                                                runs on demand from Editor Add-on

                                              Eval: Drift
                                                BLEU/ROUGE + LLM regression detection
                                                against golden translations
                                                runs on model/config change or on demand
```

## Repository Structure

```
apps-script/
├── orchestrator/       # Watches Drive for new documents, triggers extraction
└── editor-addon/       # Review sidebar and "Submit Review" for translation output docs

cloud-run/
├── extract/            # Extracts structured text blocks from source documents (Python)
├── translate/          # Translates extracted content, creates output Google Docs (JS)
├── capture-feedback/   # Diffs reviewer edits, writes terminology decisions to glossary (JS)
├── plain-language-eval/# Evaluates source document readability (JS)
├── eval/
│   ├── quality/        # LLM-as-judge quality scoring (Python)
│   └── drift/          # Regression detection against golden translations (Python)
├── monitoring/         # Cloud Monitoring dashboard configuration
└── tests/              # Shared test utilities
```

## Setup

```bash
cp .env.example .env
```

Fill in the values. If you're working in the USDR workspace prototype, ask [@lkorwin-usdr](https://github.com/lkorwin-usdr) for Google Workspace resource IDs and API keys.

## Code of Conduct

This repository falls under [U.S. Digital Response's Code of Conduct](./CODE_OF_CONDUCT.md). Please see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for the full code.

## Contributing

Please see [`CONTRIBUTING.md`](./CONTRIBUTING.md) to find out how you can help.

**Lead Maintainer:** [@lkorwin-usdr](https://github.com/lkorwin-usdr)

## License & Copyright

Copyright (C) 2026 U.S. Digital Response (USDR)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this software except in compliance with the License. You may obtain a copy of the License at:

[`LICENSE`](./LICENSE) in this repository or http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
