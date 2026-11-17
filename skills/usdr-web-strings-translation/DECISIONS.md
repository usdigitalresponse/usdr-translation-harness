# Design decisions

Why the skill works the way it does, so a team changing it (or a setting) knows what it's trading off. Project-level choices live in the project's `docs/translation/translation-settings.md`; this file explains the defaults.

## Drafts are fuzzy by default

**Choice:** every new translation is written with the `fuzzy` flag and a `# AI draft (...)` comment. Rights, benefits decisions, money, deadlines, eligibility and legal text are always fuzzy.

**Why:**
- Django's `compilemessages` skips fuzzy entries, so a draft can sit in the project without reaching the public.
- Government guidance strongly discourages publishing machine translation without review by a qualified person, especially health, financial and legal content ([Digital.gov](https://digital.gov/resources/top-10-best-practices-for-multilingual-websites)).
- Federal health-program rules require human review of machine translation when the text is critical to rights, benefits or meaningful access, when accuracy is essential, or when the language is complex or technical ([45 CFR 92.201(c)(3)](https://www.law.cornell.edu/cfr/text/45/92.201)).
- Login.gov moved from machine to human translation because of missing context and inaccuracies ([Digital.gov](https://digital.gov/2024/12/17/approaching-language-translations-to-provide-a-better-user-experience)).

**Trade-off:** until review, the live site shows English for those strings, so pages can be mixed. Settings allow low-stakes roles to skip review. A test site can preview drafts with `compilemessages --use-fuzzy`.

**Why a plain `#` comment:** `#.` comments are regenerated from the code by `makemessages` and would be lost; `#` translator comments survive.

## One agent translates; subagents only check

Consistency is the hard part of UI translation: the same term everywhere, and pages that read as a whole. One agent that has read the pages and settled the terms does that better than several working in parallel. A fresh subagent is useful for an **independent check** at the end, for the same reason the toolkit suggests a quality review in a new conversation. Parallel translation by page group is only suggested for very large projects, after terms are settled.

## Page by page, terms first

Tools that translate `.po` entries in arbitrary batches lose context. Short strings like "Apply" or "Report" are ambiguous without knowing where they appear. Weblate and Crowdin both give the model per-string context, glossary matches and placeholders. This skill goes further: it reads the template around each string and translates each page as a unit.

## A tool for every write

The known failures of AI `.po` translation are mechanical:
- dropped plural forms;
- lost leading and trailing whitespace;
- broken placeholders;
- comments breaking the parser.

python-gpt-po's open issues cover several of these ([#73 plurals](https://github.com/pescheckit/python-gpt-po/issues/73), [#62 whitespace](https://github.com/pescheckit/python-gpt-po/issues/62)). `po_tool.py` (built on `polib`) makes them impossible: it refuses writes that would break them, and it writes the decision log on every apply, so the log can't be skipped.

## Spanish conventions

| Default | Source |
|---|---|
| **Usted** | The team's translation prompt requires it; US government Spanish sites use it (USAGov en Español, CuidadoDeSalud.gov). Microsoft's US Spanish guide uses tú, which is why this isn't left to model defaults. |
| **Buttons, menus, tabs in the infinitive** ("Guardar") | Microsoft's US Spanish style guide; CuidadoDeSalud.gov uses infinitive buttons ("Solicitar cobertura"). Sources disagree, and some sites mix forms. This is a reasoned default for the content team to confirm, not a rule. |
| **Instructions and in-sentence links in the usted command form** ("Inicie sesión") | CuidadoDeSalud.gov's links; follows from usted. |
| **Sentence case, ¿ ¡, numbers and dates per the prompt** | [Digital.gov Spanish style guide](https://digital.gov/resources/spanish-language-style-guide-and-grammar) and the translation prompt. |
| **Gender-neutral phrasing, no "o/a"** | Microsoft's US Spanish guide: rephrase rather than use slashes or brackets. |
| **Length flag at 2× for short UI strings** | Strings of about 10 characters grow 200–300% in European languages, versus about 130% for long text ([W3C](https://www.w3.org/International/articles/article-text-size)). |

## The review packet is a spreadsheet

The reviewer is likely a Spanish speaker, not an engineer. A CSV in page order (UTF-8 with a byte-order mark, so Excel shows accents) needs no tools and no `.po` knowledge. `import-review` checks a reviewer's correction as strictly as an AI draft: a renamed placeholder is sent back, not shipped. Poedit is mentioned as an option for reviewers who want a `.po` editor.

## Files live in the project

`docs/translation/` holds the settings, the term ledger and each run's report, sheet and decision log, committed with the code. The next run, and the next person, start from the same decisions. Each run's report is the run log.

## Assumption: one person runs it at a time

The ledger and `.po` files assume one person translating a project at a time. Two people running the skill at once would get merge conflicts in the `.po` files and could settle the same term two ways. If that becomes common, split work by page with one owner each, and merge ledger changes through code review. Not solved here.

## Not done yet

- Formats other than Django `.po` (see `references/other-formats.md`).
- Translation memory beyond the ledger, such as reusing approved strings from other projects.
- Screenshots as context.
