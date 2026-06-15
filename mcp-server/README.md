# Translation Harness MCP Server

An MCP server for Claude Desktop providing evaluation tools for Spanish SNAP/benefits translations. Includes:

- `get_rubric` — fetches the Spanish translation evaluation rubric
- `get_glossary` — fetches approved SNAP terminology (English + Spanish)
- `ping` — health check

## Skills

Two Claude skills live in `skills/`:

- **`translation-harness-assistant`** — walks volunteers through setup, update, and troubleshooting
- **`translation-evaluator`** — structured evaluation workflow that calls the MCP tools and scores translations against the rubric

## Volunteer Setup

1. Find `skills/translation-harness-assistant.skill` in this folder
2. Open Claude Desktop → **Settings → Customize → Skills** and upload it
3. Open a new chat and say: *"Help me set up the translation harness."*

Once set up, verify it's working:

> "Can you call the ping tool from the translation harness?"

Expected: `Translation harness MCP server is running!`

To use the evaluation skill, upload `skills/translation-evaluator.skill` the same way.

### Updating

*"Help me update the translation harness."*

### Troubleshooting

*"The translation harness isn't working, can you help me troubleshoot?"*


## Local Development

**Install dependencies:**

```bash
uv sync
```

**Environment** — create `.env` in this folder (gitignored):

```
HONEYCOMB_API_KEY=your-key-here      # routes traces to Honeycomb; omit for local stderr
ANTHROPIC_API_KEY=your-key-here      # only needed if enabling token estimation middleware

# Data source overrides (defaults are baked into sources.py)
# PROMPTS_DOC_ID=...
# GLOSSARY_SHEET_ID=...
# GLOSSARY_SHEET_GID=...

GLOSSARY_STRATEGY=naive
```

**Test the tools** (from Claude Desktop after connecting the server):

```
"Can you call the ping tool from the translation harness?"
→ Translation harness MCP server is running!

"Can you call get_glossary and tell me the approved Spanish term for 'Allotment'?"
"Can you call get_rubric?"
```

**Test the evaluation skill** — install `skills/translation-evaluator.skill`, then:

```
"Please evaluate this Spanish translation: [paste translation here]"
```

**Repackage the setup skill** after editing its reference files:

```bash
python ~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/skill-creator/scripts/package_skill.py mcp-server/skills/translation-harness-assistant mcp-server/skills/
```

Commit both the updated reference files and the new `.skill` bundle. A Claude Code skill in `.claude/skills/update-setup-skill/` can help keep this in sync.
