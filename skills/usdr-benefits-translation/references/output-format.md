# Output format

Use readable formatting (headings, tables, bullets). Keep notes proportionate: a two-sentence translation doesn't need five sections of notes, but always include the forbidden-terms result and anything that needs review.

## 1. Fit note and materials

The fit report (see `fit-check.md`), plus one line on what was loaded:

> Loaded: translation prompt (Drive, today), glossary "FAMLI Spanish Glossary" (108 terms, last updated 2026-06-24), extraction prompt (flyer).

## 2. Translation

**Documents (flyers, PDFs, web pages):** a table in reading order, one row per block. Keep the column headers exactly `# | English | Spanish | Note`: the **usdr-translation-quality-review** skill reads this table directly.

| # | English | Spanish | Note |
|---|---|---|---|
| 1 | Get to know your Family and Medical Leave Insurance (FAMLI) | Conozca su Seguro de Licencia Familiar y Médica (FAMLI, sigla en inglés) | Title. Approved glossary name |
| 2 | Call 1-877-238-4373 | Llame al 1-877-238-4373 | Phone number unchanged |

Use the Note column only for short pointers (role, constraint, "see note 3"). Mark space-constrained blocks and give a shorter option if the Spanish may not fit.

**Short text:** just the Spanish, with the English above it if that helps.

Offer the other format, and (in claude.ai) a downloadable file, if the user needs one.

**Non-translatable elements** (flyers/PDFs): list them below the table (phone numbers, URLs, emails, form numbers, logo text) so a designer knows to keep them as they are.

## 3. Translator notes

As the translation prompt's final instruction asks, each grounded in verbatim quotes:
- **Alternative translations** considered and why you chose as you did.
- **Terms flagged for clarification**, where the context was insufficient or the meaning could go more than one way.
- **Back-translations** into English of key or high-stakes phrases, so a reviewer who reads less Spanish can check the meaning.
- **Glossary cross-check:** which glossary terms were used, and where you diverged from the glossary or the examples, and why.
- **Forbidden terms:** the result of `check_forbidden.py` ("No forbidden terms found", or each hit, and whether it was fixed or is a different meaning).
- **Legal references:** only if the content cites laws or regulations. Note that statutes weren't available and these need review.

## 4. Proposed glossary entries

Only for gap terms that are likely to recur:

| English Term | Approved Spanish (proposed) | Definition/Context | Example English | Example Spanish | Notes |
|---|---|---|---|---|---|
| crisis grant | subvención de emergencia | A one-time payment to prevent a utility shutoff | "You may qualify for a crisis grant." | "Es posible que reúna los requisitos para una subvención de emergencia." | From the energy assistance web page; not yet reviewed |

## 5. Needs human review

A numbered list, most important first: anything that could change meaning, legal or program terms without a glossary entry, amounts, dates and deadlines, flagged ambiguities, space-constrained text. For each: what to check and why.

Close with: "This is an AI-assisted draft. Have a qualified Spanish reviewer check it, especially the items above, before it's published."
