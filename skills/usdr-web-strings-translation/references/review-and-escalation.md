# Review, escalation and the review packet

Everything this skill writes is a **draft**. Government guidance discourages publishing machine translation without review by a qualified person, especially for health, financial and legal content ([Digital.gov](https://digital.gov/resources/top-10-best-practices-for-multilingual-websites)). The skill's job is to make that review fast and well aimed.

## Priority (for `priority` and the report)

| Priority | What | Examples |
|---|---|---|
| **Critical** (always `high_stakes`, always fuzzy) | Rights, decisions about benefits, money, deadlines, eligibility, legal or appeal information | Denial notices, income limits, "renew by <date>", appeal rights, penalties |
| **High** | Meaning uncertain | Short strings with no context, a placeholder whose content affects grammar, a term with no glossary entry, a Contested term, a string shared by pages that need different Spanish |
| **Medium** | Fit and conventions | Buttons or menus much longer than the English, agency or program names, close calls between two good options |
| **Low** | Routine | Common UI words with a clear role ("Guardar", "Siguiente") |

The always-review list follows the criteria US federal rules use for when a human must review machine translation in health programs: content critical to rights, benefits or meaningful access, where accuracy is essential, or with complex or technical language ([45 CFR 92.201(c)(3)](https://www.law.cornell.edu/cfr/text/45/92.201)). That rule doesn't bind every program, but it's a sensible line.

`flags` are the reasons in plain words, for the reviewer: "Deadline: always reviewed", "Button is about 3x the English length: check it fits", "'by' a date = 'a más tardar el', not 'antes del'". No file paths and no jargon ("msgctxt", "fuzzy").

## `report.md` (for the person running the skill)

```markdown
# Translation run <date>

**What was done:** <n> strings translated in <files> (<pages>). <n> skipped (<why>). <n> refused by the tool and fixed / still open.
**Materials:** translation prompt; glossary "<name>" (<n> terms, updated <date>). <fit note, 5-10 lines>
**Settings:** defaults, except <non-default settings>.
**Live on the site:** nothing yet. All new translations are drafts (fuzzy) until approved.

## Needs human review (most important first)
1. **Critical:** <page>: "<English>" → "<Spanish>": <why>
...

## Terms for discussion
- **No glossary entry, used often:** <term> (<n> strings, <pages>) → proposed "<Spanish>"
- **Glossary term used in a different sense:** <term>: the <glossary> glossary says "<Spanish>" for <its meaning>; here it means <...>
- **Close calls:** <term>: "<option A>" vs "<option B>": <trade-off>; chose <A> because <...>
- **Translated more than one way before this run:** <term>: <versions>; used <...>

## Proposed glossary entries
| English Term | Approved Spanish (proposed) | Definition/Context | Example English | Example Spanish | Notes |

## Suggestions for developers
- `<file:line>` "<English>": <add pgettext("<context>", ...) / a Translators: comment / a named placeholder>, because <...>

## Checks
<check summary: errors fixed, warnings and what was done about each, msgfmt / compilemessages result>
<independent check findings, if run>
```

When a review is applied, add a **Review applied (<date>, <reviewer>)** section: counts approved, corrected, comment-only, refused (with the reason in plain words), ledger changes, and strings to revisit because a term changed.

## `review-guide.md` (for the reviewer)

Plain language, one page, ready to paste into an email or a document. Template:

```markdown
# Reviewing the Spanish for <site name>

Thank you for reviewing. These are **AI-drafted** Spanish translations of the text on <site> (buttons, menus, headings, messages). None of them are on the live site yet; each one goes live only after you approve it.

## What to do
Open **review-sheet.csv** in Google Sheets or Excel. Each row is one piece of text, in the order it appears on the site. For each row, fill in **one** of:
- **Reviewer: Approve?** → `yes` if the Spanish is right as it is.
- **Reviewer: Change to** → your corrected Spanish. Keep anything that looks like `%(name)s`, `%s` or `<a href="...">` exactly as it is: those are filled in by the site (a name, a number, a link). For rows with `||`, the left side is for one ("1 file") and the right side for more than one ("2 files"); keep the `||`.
- **Reviewer: Comment** → a question or concern, if you're not sure. That row stays unapproved until it's settled.

Start with the rows marked **Critical** (rights, deadlines, money, eligibility).
**The ID column** (for example `django:feb192bc71`) is a label that lets the tool match your answer back to the right text on the site. Don't change it. You can sort, filter or hide rows, or delete rows you aren't reviewing; the IDs keep everything matched.

## Style used
- "Usted" throughout.
- Buttons and menu items use the infinitive ("Guardar", "Solicitar beneficios"); instructions use the usted command form ("Inicie sesión").
- <other style decisions from the ledger>

## Terms we'd like your opinion on
<the Terms for discussion list, in plain words, with room to answer>

If you prefer a translation tool, Poedit (free) opens the project's .po files directly, but the spreadsheet is all you need.
```

## The review sheet's ID column

Each row's **ID**, such as `django:feb192bc71`, is how `import-review` finds the string a reviewer's answer belongs to. It has two parts:
- **`django`**: the `.po` file the string is in (`django.po`; `djangojs` for `djangojs.po`).
- **`feb192bc71`**: a short fingerprint of the string's English text and its context (`msgctxt`). The two "Apply" strings have the same English but different contexts, so they get different IDs.

It isn't a line number, so a row still matches after the developers run `makemessages` or add other strings. The same string has the same ID in every run, so an older sheet can still be applied. It only stops matching if the English or the context changes. `import-review` then reports that row as "not in these .po files" and applies nothing for it. Because the ID is all it needs, reviewers can sort, filter or delete rows freely. The ID is also the `id` in `decisions.jsonl` and the one `scan` and `apply` use, so a sheet row can be traced to its reasoning.

## The round trip

1. The skill writes drafts (fuzzy) and the packet.
2. The reviewer fills in the sheet and sends it back.
3. "Apply this review": `import-review` approves, corrects (after checking) or leaves fuzzy. The skill updates the ledger and the report.
4. The developer deploys. Approved strings show in Spanish; the rest stay English until their next review.
