---
name: usdr-translation-quality-review
description: Part of USDR's translation toolkit. Reviews an existing English → Spanish translation of public-benefits content against the team's translation evaluation rubric and glossary, scoring accuracy, clarity, cultural fit, voice and tone, and consistency, with a weighted overall score, a priority, and specific "change X to Y" fixes. Also checks forbidden glossary terms and that numbers, dates, amounts, URLs and phone numbers survived. Use when someone asks to review, score, evaluate, QA or check a Spanish translation.
---

# Translation quality review (English → Spanish)

Score a translation against the team's **evaluation rubric**, check it against the **glossary**, and give the person a short list of specific, actionable fixes. You review; you don't retranslate the whole thing unless asked.

Read `references/materials.md` first: it lists the materials and how to open them.

## 1. Get the source and the translation

You need **both** the English source and the Spanish translation. They may come as:
- **output from the usdr-benefits-translation skill**: a table with the columns `# | English | Spanish | Note`, usually followed by translator notes. Each row is already one source block and its translation, so review row by row;
- the pipeline's output Google Docs: a two- or three-column table (Block ID | English | Spanish, or just English | Spanish);
- two documents or files, or two pasted texts;
- a translation from earlier in this conversation.

For anything not already in rows, line the source and translation up block by block (heading with heading, paragraph with paragraph) before reviewing. If the structure doesn't match, note where.

If the input includes the translator's notes (alternatives, flagged terms, back-translations, glossary cross-check), **score the translation on its own first**, so the translator's reasoning doesn't sway your judgment. Then use the notes: say where you agree with a flag, where a back-translation shows a meaning problem, and where a stated choice still needs a human decision.

**No English source?** Ask for it. If it isn't available, review only what doesn't depend on it (clarity, tone, consistency, style, glossary and forbidden terms), don't score Accuracy, and say so at the top of the review.

**Not Spanish?** The rubric and glossary are for Spanish. For another language, say there are no materials for it, and only do a best-effort review if the user still wants one, clearly labeled.

**Translated in this same conversation?** Say that the review isn't independent: the same conversation that produced the translation tends to agree with it. Suggest starting a new conversation with just the source and translation for a fairer review, and continue if they prefer.

## 2. Load the materials

Load, fresh:
1. the **translation evaluation rubric**;
2. the **glossary**, following `references/glossary-access.md` exactly (download as Excel, run `scripts/load_glossary.py`; report the term count and last-updated date).

If either can't be loaded, say which. Without the rubric, don't produce scores; offer a general review labeled "not checked against the team's rubric". Without the glossary, score terminology by consistency only, and say so.

From the rubric, take the **criteria, weights, scoring descriptions, priority levels** and its instructions for **recommendations** (for example: list every instance, quote the exact phrase and the replacement, start with an action verb).

## 3. Check the fit

In two or three lines before the review:
- what the rubric and glossary were written for (programs, state, content type) and what this content is;
- how you're adapting the rubric to this content. For example, the tone criterion depends on content type (a web page or UI text isn't a flyer), and terms from a program the glossary doesn't cover are judged for accuracy and consistency, not against that program's glossary;
- anything in the rubric you're ignoring because it's an instruction for the team's automated pipeline (see `references/materials.md`), and any inconsistency in the rubric itself.

## 4. Run the automatic checks

Save the source and translation as text files, then:
- **Forbidden terms:** `python scripts/check_forbidden.py translation.txt glossary.json`. Review every hit in context; the hit shows which glossary entry forbids the word and for what meaning.
- **Preserved elements:** `python scripts/compare_elements.py source.txt translation.txt`. Lists URLs, emails, phone numbers, dollar amounts, percentages and other numbers that are missing or added. Some differences are expected (small numbers spelled out, dates reformatted); check each one.

Also look up the source's key terms in `glossary.json` and check that the translation uses the **Approved Spanish** for each (exactly, including capitalization).

If you can't run code, do these checks by reading, and say they were manual.

## 5. Score

For each rubric criterion, using the rubric's own scoring descriptions:
- **Score** (1–5).
- **Recommendations:** every instance that would raise the score, as the rubric asks: quote the exact Spanish (and the English when it matters), say what to change it to, and start with an action verb. "Change 'trabajadores independientes' to 'personas que trabajan por cuenta propia' (block 4) to match the glossary." No general commentary, and nothing that's already true. "None" is a fine answer.
- **Priority** (the rubric's levels): the most serious issue in that criterion.

Accuracy issues come first in importance: a meaning change, a missing step, deadline or amount, or a wrong legal or program term is **Critical** even if the Spanish reads well. Put the automatic check results in the criterion they affect (forbidden or non-glossary terms under Accuracy or Cultural Sensitivity, per the rubric; changed numbers or URLs under Accuracy or Consistency).

Then compute the **overall weighted score** yourself with the rubric's weights, and show the arithmetic in one line (don't rely on any example total in the rubric). The **overall priority** is the most serious priority across criteria. If the rubric calls certain scores "unusable", say plainly when a criterion falls there.

## 6. Present it

1. **Summary** (3–5 lines): overall score and priority, the verdict in plain words (e.g. "usable after the three Critical fixes", "not usable yet: meaning changed in two places"), and the most important fixes.
2. **Scores table:** criterion | weight | score | priority.
3. **Recommendations** by criterion, numbered, each with the exact text and the replacement, and where it is (block or quote).
4. **Checks:** glossary terms (followed / not followed), forbidden terms, preserved elements: each with its result.
5. **Fit notes:** how you adapted the rubric, what you ignored, rubric inconsistencies.
6. **For the human reviewer:** anything you couldn't judge (a legal nuance, a program-specific term with no glossary entry, a cultural question), so a qualified Spanish reviewer knows where to look.

Offer next steps: apply the fixes and produce a revised translation (then suggest re-reviewing it in a new conversation), or propose glossary entries for recurring terms that aren't in the glossary (in the glossary's columns, for the content team).

Use readable formatting (a table, numbered lists). Keep it proportionate: a short text doesn't need a long report.
