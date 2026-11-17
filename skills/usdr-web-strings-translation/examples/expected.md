# What a correct run on the sample should do

The sample project (`sample-django/`) has no "correct Spanish" to compare against: no one has reviewed golden translations. Instead, check these **behaviors**. Work on a copy (see `sample-django/README.md`).

## "What needs translating?"
- [ ] Finds `django.po` and `djangojs.po`, with 44 untranslated, 1 fuzzy and 2 done in `django.po`, and 3 untranslated in `djangojs.po`.
- [ ] Reports by page, with the shared layout (navigation and footer) as its own group.
- [ ] Mentions the obsolete entry ("Apply now") only in passing, if at all, and doesn't translate it.

## First run
- [ ] Offers the settings walkthrough one setting at a time (or the defaults), and writes `docs/translation/translation-settings.md` and `translation-terms.md`.
- [ ] Gives a fit note: the materials' scope versus a benefits portal; glossary gaps such as "household", "proof of identity", "appeal".
- [ ] Notices that "driver's license" isn't the glossary's "leave" sense of "licencia", if the glossary has it.

## Translation
- [ ] Shared layout first, then page by page.
- [ ] The two "Apply" entries get different Spanish: the submit button (developer comment: submits the application) versus the filter (`msgctxt "filter"`).
- [ ] "Report" (noun) and "Report a change" (verb) are treated differently.
- [ ] Both plural forms filled for the three plural entries.
- [ ] Placeholders identical: `%(first_name)s`, `%(count)s`, `%(counter)s`, `%(date)s`, `%(miles)s`, `%(url)s`, `%(name)s`, `%(size)s`, `%s`.
- [ ] `<strong>` and `<a href="%(url)s">` kept.
- [ ] The trailing space in "Your application was saved. " and "Total: " kept. The email body keeps its blank line and final line break.
- [ ] The greeting avoids assuming gender ("Bienvenido").
- [ ] "Renew by <date>" isn't translated as "antes del" (that means *before*, moving the deadline).
- [ ] "Home" ("Inicio") and "Sign out" ("Cerrar sesión") are untouched; they're done.
- [ ] Every new entry is `#, fuzzy` with the `# AI draft (usdr-web-strings-translation, <date>)` comment.
- [ ] `docs/translation/reports/<date>/decisions.jsonl` has a line per translated string, with reasoning.

## Checks and packet
- [ ] `po_tool.py check` passes (no errors). Warnings are each addressed (for example, a long submit button).
- [ ] `review-sheet.csv` opens with accents intact, in page order, with no file paths in "Where on the page".
- [ ] Critical rows include: the denial notice, the income-limit reason, the appeal text, the renewal deadline, the income help text, and the confirmation email.
- [ ] `report.md` has Terms for discussion, proposed glossary entries, and developer suggestions (for example, `pgettext` for strings without context, or a single string instead of `"Total: " + amount`).
- [ ] The summary says fuzzy entries show in English on the site until approved.

## Applying the sample review
Use `sample-review/review-sheet-filled.csv` (see `sample-review/README.md`):
- [ ] 39 approved, 4 corrected, 2 comment-only (still fuzzy), 1 refused: the reviewer renamed `%(first_name)s`.
- [ ] The refused correction is explained in plain words, with a fixed version proposed.
- [ ] "Guardamos su solicitud." gets its trailing space back.
- [ ] The submit button becomes "Enviar"; the filter's "Aplicar" is unchanged.
- [ ] The ledger records the reviewer's term choices ("pendiente", "Comuníquese con nosotros") as Team decision.
- [ ] `report.md` gets a "Review applied" section.
