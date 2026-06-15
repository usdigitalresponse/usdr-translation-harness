# USDR × Maryland AI Translation Infrastructure

> **Work in progress.** This project is in early development. Functionality is limited and things may change significantly.

This repository contains the prototype infrastructure for AI-assisted translation of Maryland government benefits content.

## Repository Structure

```
apps-script/
├── orchestrator/       # Watches Drive for new PDFs, triggers extraction
└── editor-addon/       # "Submit Review" Editor Add-on for translation output docs

cloud-run/
├── extract/            # Extracts text blocks from source PDFs (structured JSON)
├── translate/          # Translates extracted content, creates output Google Docs
├── capture-feedback/   # Diffs reviewer edits, writes terminology decisions to glossary
└── eval/
    ├── drift/          # Automated regression evals against golden translation set
    └── quality/        # On-demand LLM-as-judge quality eval

mcp-server/             # Claude Desktop MCP server (evaluation tooling)

docs/
└── handoff/            # Maryland-facing guides and product documentation
```


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
