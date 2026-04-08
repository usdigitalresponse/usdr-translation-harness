# Translation Harness MCP Server

> **Work in progress.** This project is in early development. Functionality is limited and things may change significantly.

This MCP server connects to Claude Desktop and provides curated translation tools for government use cases.


## Getting Started: Testing Locally

Install the **Translation Harness** Claude skill (see below), then ask Claude to help you get set up. It will walk you through the process step by step.

### Install the skill

1. Find `translation-harness-assistant.skill` in the `skills/` folder of this repository
2. Open Claude Desktop → **Settings → Customize → Skills**
3. Upload the file

Once installed, open a new chat and say: *"Help me set up the translation harness."*


## Verify it's working

Once set up, look for plus icon near the text input in Claude Desktop, and click it > then view "Connectors" and make sure the harness shows up. 
Start a new conversation and ask:

> "Can you call the ping tool from the translation harness?"

Expected response: `Translation harness MCP server is running!`


## Updating

When the team ships changes, ask Claude: *"Help me update the translation harness."*

## Troubleshooting

Something not working? Ask Claude: *"The translation harness isn't working, can you help me troubleshoot?"*

If you're stuck, share any error messages with the team.


## Developing Locally

Follow the volunteer setup steps above to get the server running in Claude Desktop. Additional notes for contributors:

**Dependencies**

```bash
uv sync
```

Run this after pulling changes or modifying `pyproject.toml`.

**Environment**

Create a `.env` file in the project root (gitignored):

```
HONEYCOMB_API_KEY=your-key-here
ANTHROPIC_API_KEY=your-key-here
```

`HONEYCOMB_API_KEY` routes traces to Honeycomb — omit it and traces print to stderr locally. `ANTHROPIC_API_KEY` is only needed if enabling the token estimation middleware in `server.py`.

**Dev tooling**

A Claude Code skill (`update-setup-skill`) is included in `.claude/skills/`. When working in this project with Claude Code, it helps keep the volunteer-facing setup skill in sync when server changes are made. After updating skill content, repackage with:

```bash
python ~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/skill-creator/scripts/package_skill.py skills/translation-harness-assistant skills/
```

Commit both the updated reference files and the new `skills/translation-harness-assistant.skill`.


## Code of Conduct

This repository falls under [U.S. Digital Response’s Code of Conduct](./CODE_OF_CONDUCT.md), and we will hold all participants in issues, pull requests, discussions, and other spaces related to this project to that Code of Conduct. Please see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for the full code.


## Contributing

This project wouldn’t exist without the hard work of many people. Thanks to the following for all their contributions! Please see [`CONTRIBUTING.md`](./CONTRIBUTING.md) to find out how you can help.

**Lead Maintainer:** [@lkorwin-usdr](https://github.com/lkorwin-usdr)


## License & Copyright

Copyright (C) 2026 U.S. Digital Response (USDR)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this software except in compliance with the License. You may obtain a copy of the License at:

[`LICENSE`](./LICENSE) in this repository or http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
