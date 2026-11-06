---
name: usdr-web-strings-translation
description: Part of USDR's translation toolkit, for Claude Code. Translates a web app's interface text (Django gettext .po files) from English into Spanish using the team's live translation prompt and glossary. Reads each page in context, settles terms once for the whole site, writes drafts marked fuzzy so nothing unreviewed goes live, checks placeholders, plurals and HTML, and produces a review packet (a spreadsheet and a guide) that a non-technical Spanish reviewer can fill in and that the skill applies back. Use when someone asks what needs translating in a web project, to translate .po files, a page or specific strings, or to apply a translation review.
---

# Web strings translation (English → Spanish, Django `.po`)

Translate a web app's interface text into Spanish. Do it the way a careful translator would: page by page, with the same terms everywhere. You write **drafts**. Every new translation is marked fuzzy, which means "not confirmed". Django doesn't show fuzzy text on the site, so nothing reaches the public until a person approves it. You also hand that person exactly what they need to review it.

This skill needs **Claude Code**, because it reads and edits files in the project and runs Python. It also needs `polib` (`pip install polib`; install it if it's missing, after telling the user). `msgfmt` (GNU gettext) and Django are optional extra checks.

Read `references/materials.md` first: it lists the materials and how to open them. Then read `references/po-files.md`, unless you already know the `.po` format well.

**Never edit a `.po` file by hand.** All reads and writes go through `scripts/po_tool.py`, which keeps plural forms, whitespace, placeholders and HTML intact and refuses anything that would break them. Run `python3 <this skill>/scripts/po_tool.py --help` for the commands.

## 0. Work out what's being asked

People ask in different ways. Handle each one:

| They say | You do |
|---|---|
| "What needs translating?" / "status" | `po_tool.py find <project>`. Report per file and per page: untranslated, fuzzy (drafts waiting for review), done. Ask what to work on. |
| "Translate what's missing" | Every untranslated entry in every Spanish `.po` file. |
| A file ("translate djangojs.po") | That file only. |
| A page or feature ("the renewal page") | `scan --page <path fragment>`: only entries whose references point there. |
| Specific strings ("retranslate 'Apply' on the filters") | `scan --msgid <text>`, then just those. Ask before replacing a translation that isn't fuzzy (`--overwrite`). |
| "Apply this review" (with a filled-in sheet) | Go to step 9. |

The materials are for **Spanish**. If they ask for another language, give the toolkit's standard warning: no materials exist for that language, the result would be close to an unguided AI translation, and a qualified reviewer must check all of it. Continue only if they confirm. A `.po` file for another language lives in `locale/<code>/`; the tool's commands work the same way.

Strings that aren't in Django `.po` files (Rails YAML, JSON for i18next, XLIFF): see `references/other-formats.md`. The skill's tooling doesn't cover them yet. Say so before doing anything.

## 1. Load materials and project settings

1. The **translation prompt** and the **glossary** or glossaries, fresh, per `references/materials.md` and `references/glossary-access.md`. Tell the user how many terms loaded and the date. If one can't be loaded, say which and stop, unless they say to continue; then label everything "not checked against the team's <material>".
2. The project's `docs/translation/` folder:
   - `translation-settings.md`: the project's choices.
   - `translation-terms.md`: the **term ledger** and style decisions.
   - `reports/`: earlier runs. Read the latest report's open items.

**First run (no settings file):** walk through the six settings **one at a time**, using `references/settings-template.md` (it has the opening wording; the always-reviewed rule isn't a setting, so don't count it or ask about it). For each one, say in a short paragraph what it controls, what goes wrong either way, the default and why, then ask whether to keep or change it. Offer "use the defaults for now" up front. Then write `docs/translation/translation-settings.md` from the template, with their answers and today's date. Also create `translation-terms.md` from `references/term-ledger.md` if it's missing.

Each run gets a folder: `docs/translation/reports/<YYYY-MM-DD>/`. Add `-2`, `-3` if that date already has one. Call this the **run folder** below.

## 2. Scan and map the site

`po_tool.py scan <po files> [--include untranslated|fuzzy|all]` lists the entries to work on, **grouped by page**:
- the **shared layout** (templates other pages extend: navigation, footer) first;
- then one group per template, or per Python or JS file;
- then strings used on several pages.

Each entry has an `id` (use it with `apply`), its context (`msgctxt`), the developer's comment, file:line references, placeholders, HTML tags, leading/trailing spaces, and plural forms. On a big project, summarize the groups for the user (names and counts) rather than dumping the scan.

## 3. Read each page as a page

For each group, open the template (or use `po_tool.py context <project> <file:line>...`) and read the strings **in the order they appear**, with the markup around them. Decide each string's **role** (button, link, navigation, tab, heading, form label, placeholder, error, help text, body text, status message, email, page title) and **where it sits on the page**, in plain words ("Main button at the bottom of the form"). The scan's `role_guess` is only a first guess; check it. `references/ui-roles.md` gives word-form and length guidance per role.

Strings from Python views and JavaScript usually show up on a template that view renders or that script runs on. Find it, so they're translated with that page in mind.

Translate each page so it reads as **one coherent page**: the button does what the heading promised, labels and instructions use the same terms, and the tone holds. A string used on several pages is translated once, with each page in view. If one translation can't serve all of them, flag it and suggest the developer split it with `pgettext`.

## 4. Fit check and terms, before translating

1. Run the **fit check** (`references/fit-check.md`): what this site is (programs, audience, stakes) versus what each material covers, including each glossary's **scope**. Tell the user in 5–10 lines.
2. Collect the **recurring terms** across all groups (program names, benefits and legal terms, repeated UI words like "apply", "submit", "report") and settle each one **once**, per `references/term-ledger.md`:
   - use the ledger's existing entry if there is one (a "Team decision" is never changed by you);
   - otherwise use the glossary whose scope fits. When a glossary has the word but for **a different meaning or program**, don't apply it; mark it **Contested**;
   - otherwise propose a translation (**AI draft**).
   Write new and changed entries to `translation-terms.md` as you go.

## 5. Translate, page by page

Shared layout first, then each page, in chunks of about 40 entries that keep a section together. Follow the translation prompt's criteria in its priority order (accuracy first), the ledger's style decisions and terms, and the settings. Also:
- **Keep every placeholder exactly** (`%(name)s`, `%s`, `{0}`), every HTML tag and attribute, every leading/trailing space and line break. Never translate what's inside a placeholder.
- **Plurals:** give every form (Spanish has two: `msgstr_plural: [singular, plural]`).
- **`msgctxt` separates meanings.** Two "Apply" entries with different contexts usually need different Spanish.
- **Placeholders that change the grammar.** For example, `Welcome, %(first_name)s` could be anyone: prefer wording that works for everyone ("Le damos la bienvenida") and say so in the reasoning.
- **Never change meaning to be shorter or simpler.** Deadlines, amounts and conditions stay exact. "Renew by <date>" means *on or before*; "antes del" would move the deadline a day earlier.
- **Mark high-stakes strings** (`"high_stakes": true`): anything about rights, benefits decisions, money, deadlines, eligibility or legal matters. They always stay fuzzy, whatever the settings say.

Write each chunk as JSON (see `po_tool.py --help`, TRANSLATION INPUT) to a file in the run folder. Every item has `id`, the Spanish, and the fields that make the review packet and audit log useful:
- `page` and `place_on_page`, in plain words;
- `role`;
- `priority` (Critical / High / Medium / Low; see `references/review-and-escalation.md`);
- `flags`: the reviewer-facing reasons to look at it, in plain words;
- `reasoning`: why this wording, briefly;
- `alternatives`, when there was a real choice;
- `ledger_terms`.

Then:

    python3 <skill>/scripts/po_tool.py apply <po file> <chunk.json> --run-dir <run folder>

`apply` writes the drafts, marks them fuzzy and adds the comment `# AI draft (usdr-web-strings-translation, <date>): needs human review`. It also appends every decision to `<run folder>/decisions.jsonl`, which is the audit log. If it refuses anything, fix it and apply again; never work around it. It never replaces a non-fuzzy translation unless you pass `--overwrite`, and you only do that when the user asked.

`"fuzzy": false` is allowed only for roles the settings list under "Roles that skip review". It is never allowed for high-stakes strings.

## 6. Check

After each page group, and again at the end:

    python3 <skill>/scripts/po_tool.py check <po files> --run-dir <run folder> --glossary <glossary.json>

- **Errors** (placeholders, HTML, plural forms, whitespace, `msgfmt -c`) must be fixed.
- **Warnings** need judgment. Look at each one, fix it, or flag it for the reviewer:
  - long buttons or menu items;
  - the same English translated two ways;
  - two different English strings sharing one Spanish;
  - forbidden glossary terms.
- If the project has Django, `python manage.py compilemessages` is a good final check. It skips fuzzy entries, which is expected.

**Independent check (recommended when you can start a subagent):** give a fresh subagent only the English, the Spanish, the roles and the ledger for the high-stakes strings and a sample of the rest, and ask it to find mistranslations. Put its findings in the report. Otherwise, suggest the user run **usdr-translation-quality-review** in a new conversation. Don't use subagents to translate: one agent that has settled the terms and read the pages translates more consistently. On a very large project you may *suggest* parallel page groups, but only after the terms are settled.

## 7. The review packet

1. `po_tool.py export-review <po files> --run-dir <run folder>` writes `review-sheet.csv`. It has every fuzzy entry in page order, with plain-language columns and empty "Reviewer:" columns. It opens in Google Sheets or Excel with accents intact.
2. Write `<run folder>/review-guide.md` for the reviewer, in plain language, from the template in `references/review-and-escalation.md`. It covers what they're reviewing, how to fill in the sheet, the style decisions, and the **terms for discussion**.
3. Write `<run folder>/report.md` for the person running the skill (format in `references/review-and-escalation.md`):
   - what was done, plus the fit note and any non-default settings;
   - **Needs human review**, most important first;
   - **Terms for discussion** and **proposed glossary entries**;
   - **suggestions for developers** (strings that need a `pgettext` context, a `Translators:` comment, or a named placeholder);
   - what was skipped or refused.

## 8. Tell the user

Keep it short:
- what changed (files, counts);
- the top review items;
- where the packet is;
- the reminder that **fuzzy entries show in English on the site until someone approves them**. Mention that a test environment can preview drafts with `compilemessages --use-fuzzy`, depending on how they deploy.

Point them to the reviewer guide to send with the sheet. Don't commit anything; leave that to them.

## 9. Apply a review

When they bring back a filled-in `review-sheet.csv`:

    python3 <skill>/scripts/po_tool.py import-review <po files> <filled sheet> --run-dir <that run's folder> --reviewer "<name>"

- **Approve = yes:** fuzzy and the AI comment are removed, so the translation goes live at the next deploy.
- **Change to:** the reviewer's Spanish is checked like any other translation, then written and approved. The tool restores leading and trailing spaces automatically.
- **Comment only:** the entry stays fuzzy. List the comment as an open item.
- **Refused corrections** (for example, a renamed placeholder): explain each one in plain words, propose a fixed version that keeps the reviewer's wording, and ask the user to confirm it with the reviewer. Don't approve it yourself.

Then:
- **update the ledger:** terms the reviewer settled or corrected become **Team decision** (with their name and date). If a correction changes a ledger term, find the other strings that use that term and list them for the user to retranslate or confirm;
- **add a "Review applied" section** to that run's `report.md`: counts, corrections, open comments, refusals;
- **run `check` again.**
