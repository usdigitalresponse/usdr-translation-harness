---
name: update-setup-skill
description: Use when changes to the Translation Harness server may need to be reflected in the volunteer-facing setup skill, or when asked to update or repackage the setup skill.
---

# Update Setup Skill

## File map: what affects the setup skill

When any of these files change, check whether the setup skill needs updating:

| Changed file | Likely skill impact | Skill file to update |
|---|---|---|
| `src/translation_harness/server.py` | New env vars, config changes | `references/setup.md` and `references/setup-windows.md` |
| `pyproject.toml` | New dependencies (uv sync step) | `references/setup.md` and `references/setup-windows.md` |
| Claude Desktop config format | Config snippet in setup | `references/setup.md` and `references/setup-windows.md` |
| New failure modes discovered | Troubleshooting steps | `skills/translation-harness-assistant/references/troubleshooting.md` |
| Update workflow changes | Update steps | `skills/translation-harness-assistant/references/update.md` |

## When server changes are made

1. Read the changed file(s) and identify what a volunteer setting up fresh would need to do differently
2. Update the relevant file(s) in `skills/translation-harness-assistant/references/`
3. Repackage the skill:

```bash
python ~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/skill-creator/scripts/package_skill.py skills/translation-harness-assistant skills/
```

4. Commit both the updated reference files and the new `skills/translation-harness.skill`

## Key things volunteers need to know about

- Any new environment variables → add to the `.env` step in `setup.md`
- Any new dependencies → the `uv sync` step covers these automatically, no change needed unless there's a prerequisite (e.g. a system package)
- Changes to the Claude Desktop config format → update the JSON snippet in `setup.md`
