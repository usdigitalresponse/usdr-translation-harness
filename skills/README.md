# USDR translation toolkit (Claude skills)

Claude skills that bring the translation pipeline's materials (plain-language rubric, translation prompt, glossary, evaluation rubric) to people working directly in **claude.ai** or **Claude Code**, without the pipeline.

| Skill | Status | What it does |
|---|---|---|
| `usdr-plain-language-review` | Ready | Reviews English content against the plain-language rubric, with scores and prioritized fixes |
| `usdr-benefits-translation` | Ready | Translates English → Spanish with the live prompt and glossary, a fit check, translator notes and a human-review list |
| `usdr-translation-quality-review` | Ready | Scores a translation against the evaluation rubric |
| `usdr-web-strings-translation` | Skeleton, for testing | Translates a web app's interface text (Django `.po` files) page by page, for Claude Code: drafts marked for review, a term ledger, and a review spreadsheet for a non-technical reviewer that it applies back |

## How the skills get their materials

The skills don't contain the team's rules. Each one reads the **live** materials from Google Drive every time it runs (so the content team's edits apply right away), using the Google Drive connector. The links aren't in git: the source and the released packages have `{{…}}` placeholders, which you replace with your own links (see below).

## Install a skill

`release/` has ready-to-upload packages with **placeholder** links.

- **claude.ai:** Settings → Capabilities → Skills → upload the `.skill` file. Turn on code execution and the Google Drive connector.
- **Claude Code:** unzip the `.skill` file (it's a zip) into `~/.claude/skills/` or a project's `.claude/skills/`.

## Point it at your materials

Each skill lists its materials in `references/materials.md`, with `{{…}}` placeholders. Replace them with your team's links (and the glossary tab name), and save:
- **claude.ai:** Customize → Skills → the skill → `references/materials.md` → edit.
- **Claude Code:** edit `references/materials.md` in the skill's folder.

If you skip this, the skill asks for the links (or pasted materials) when it runs.

## For maintainers: the build script

`build.py` fills in links automatically and packages the skills. Optional; you only need Python for this.

1. Copy `materials.example.json` to `materials.local.json` (gitignored) and fill in your links and glossary tab name.
2. `python3 skills/build.py` builds every skill into `dist/` (gitignored) as `.skill` and `.zip` files with your links, and installs them into this repo's `.claude/skills/` for testing (also gitignored). `--user` also installs into `~/.claude/skills/`; `--no-project` skips installing.
3. Start a new Claude Code session, or upload from `dist/` to claude.ai.

`python3 skills/build.py --release <skill-name>` writes the placeholder package to `release/` for committing, and refuses if a real Drive link would be included.

## Layout

- `usdr-*/`: one folder per skill (`SKILL.md`, its own `references/` and `scripts/`, and `skill-build.json` listing the materials it uses).
- `_shared/materials.json` + `materials-template.md`: the catalog of materials and the template each skill's `references/materials.md` is built from (only the skill's own materials are included).
- `_shared/glossary/`: glossary loading instructions and scripts, added only to skills that use the glossary.
- `_shared/elements/`, `_shared/fit/`: the element comparison script and the fit check, added to skills that list them under `"shared"`.
- `tests/`: unit tests for the scripts.

## Tests

The scripts have unit tests. From the repo root, with the repo's `.venv`:

    .venv/bin/pip install -r skills/requirements-dev.txt
    .venv/bin/python -m pytest skills/tests

The `.po` tests run against copies of the web strings skill's sample project (`usdr-web-strings-translation/examples/`). The `msgfmt` check is skipped if GNU gettext isn't installed.

## Feedback

Found a gap, a rule that doesn't fit your content, or a better way to handle something? Open an issue or a pull request in this repo, or tell the USDR team. Improvements to the skills (and suggested changes to the materials themselves) are welcome.
