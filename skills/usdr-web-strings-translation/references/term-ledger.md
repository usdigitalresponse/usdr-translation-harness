# Term ledger and style decisions

The ledger is how the whole site uses the same Spanish for the same thing, across pages, runs and people. It lives in the project, `docs/translation/translation-terms.md`, so it's committed with the code.

Its columns are **the glossary's columns**, so settled terms can go straight to the content team's glossary, plus four tracking columns.

## Template (for a new project)

```markdown
# Translation terms and style

Decisions for translating this site into Spanish. The translation skill reads this file every run.
Only people set **Team decision**. The skill proposes (**AI draft**) and flags (**Contested**).

## Style decisions

| Decision | Choice | Decided by / date |
|---|---|---|
| Form of address | usted (from the translation prompt) | translation prompt |
| Buttons, menu items, tabs | infinitive ("Guardar") | default, to confirm |
| Instructions and links in sentences | usted imperative ("Inicie sesión") | default, to confirm |
| Capitalization | sentence case; ¿ ¡ | translation prompt |
| Numbers, money, dates | per the translation prompt | translation prompt |
| Gender | neutral phrasing where natural ("Le damos la bienvenida"), no "o/a" | default, to confirm |
| Program and agency names | <keep English / official Spanish name / translate> | to decide |

## Terms

| English Term | Approved Spanish | Forbidden Terms | Definition/Context | Example English | Example Spanish | Notes | Status | Source | Where used | Run |
|---|---|---|---|---|---|---|---|---|---|---|
```

## Statuses

| Status | Meaning | Who sets it |
|---|---|---|
| **Glossary** | Taken from an official glossary whose scope fits. Source names the glossary. | The skill |
| **Team decision** | A person decided (a reviewer's correction or approval of the term, or the team). Source names them. Never changed by the skill. | People (via an applied review, or by editing the file) |
| **AI draft** | Proposed by the skill. Needs a person to confirm. | The skill |
| **Contested** | Needs discussion: a glossary term in a different sense or program, two reasonable options, or a reviewer comment that disagrees. Approved Spanish may be empty. | The skill |

## Settling a term (per run, before translating)

1. **Already in the ledger** → use it. If it's AI draft or Contested, keep using it consistently and list it under "Terms for discussion" again if it's still open.
2. **In a glossary whose scope fits** → use the approved Spanish; status Glossary. Respect its Forbidden Terms.
3. **In a glossary, but a different meaning or program** → don't apply it. Example: a paid-leave glossary's "licencia" (leave) versus a driver's license (licencia de conducir), or a business license. Status Contested, with the glossary's term in Notes.
4. **Nowhere** → propose (AI draft), and add it to "Proposed glossary entries" in the report if it's used often or matters.

Fill **Where used** with a count and the pages ("12 strings: Apply, Renew, Status"), and **Run** with the run date.

## After a review

- A reviewer's correction that changes a term → update **Approved Spanish**, status **Team decision**, Source "<reviewer>, <date>". Then find the other strings that use the old wording and list them in the report to retranslate or confirm.
- A reviewer's comment about a term → Contested, with the comment in Notes.
- Never delete a row; mark replaced terms in Notes ("was 'X' until <date>").
