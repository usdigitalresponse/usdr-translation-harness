---
name: usdr-plain-language-review
description: Part of USDR's translation toolkit. Reviews English public-benefits content (flyers, web pages, letters, notices, forms) for plain language using the team's plain-language rubric, scoring accuracy, clarity, voice and tone, structure, and consistency, with specific, prioritized fixes. Use when someone asks to check, review, score, or improve the readability or plain language of English content, or before translating content so the source is clear first. Reviews only; it doesn't rewrite content unless asked.
---

# Plain-language review

Review English content against the team's **plain-language rubric** and give the writer a clear, prioritized list of what to fix. Plain language matters most before translation: unclear English produces unclear Spanish.

You review and recommend. You don't rewrite the content unless the user asks; then rewrite only what they asked for, and keep every fact, deadline and requirement.

## 1. Get the content

The user may paste text, attach a file (PDF, Word, text), share a Google Doc link, or point to files in a project. If it's long, confirm which part to review. If it's a PDF or flyer, read it in visual order (headings, then body, then call-outs) and note text you couldn't read.

Ask who the audience is only if it isn't clear and it would change the review (for example staff-facing vs. public-facing).

## 2. Load the rubric

Open the **plain-language rubric** listed in `references/materials.md`, following that file's instructions (Drive connector first, then local copies). Don't review without it: if you can't load it, say so and ask the user for it. If they want to go ahead anyway, use general plain-language principles (short sentences, common words, active voice, "you", clear steps) and label the review **"not checked against the team's rubric"**.

From the rubric, take:
- the **criteria** and their **weights** (use the scoring table; if the rubric's examples use different weights, follow the table and mention the mismatch),
- the **scoring descriptions** for each level,
- the **priority levels** and what each means.

## 3. Check the fit

The rubric was written for a particular program, state and use (for example, judging a plain-English *rewrite* of a more complex original). Compare that with the content in front of you, and tell the user in two or three lines before the review:
- what the rubric was written for, and what this content is (type, program, audience);
- how you're adapting the rubric to review this particular content. Usually: you're reviewing the content as written, rather than comparing a rewrite with an original. If the rubric mentions a specific program's policy or glossary and this content is about a different program, judge terminology for internal consistency and clarity, not against that program's terms.

Also ignore instructions in the rubric that were written for the team's automated pipeline rather than for a reviewer (for example "plain text only, no markdown", or a required output format), and say so once. `references/materials.md` explains what the pipeline is.

## 4. Measure what can be measured

Run `scripts/readability.py` on the text (pass a file path, or pipe the text in) for sentence lengths, long sentences, and an approximate grade level:

```
python scripts/readability.py content.txt
```

Use the numbers as evidence ("12 of 31 sentences are over 20 words; the longest is 46"), not as the score. Grade-level formulas are rough: they miss jargon, undefined terms and structure, which the rubric cares about. If you can't run code, estimate sentence lengths by reading, and say the numbers are estimates.

## 5. Review

For each rubric criterion:
- **Score** (1–5), using the rubric's descriptions.
- **Strengths:** what already works, briefly.
- **Issues:** each one tied to an **exact quote** from the content.
- **Recommendations:** concrete fixes. For High and Critical issues, show a before/after:
  - *Before:* "Benefits will be disbursed upon approval of the application."
  - *After:* "We'll send your payment after we approve your application."
- **Priority**, using the rubric's levels (Critical / High / Medium / Low).

Then compute the **weighted overall score** with the rubric's weights (show the arithmetic briefly) and give an **overall priority**: the most serious priority among the issues, in the rubric's wording if it has one.

Rules:
- **Accuracy comes first.** Never recommend a change that could alter a requirement, deadline, amount, eligibility rule or legal meaning. If plain wording would risk that, say what needs checking with program staff instead.
- **Don't invent facts or policy.** You can't verify the content's facts; only flag things that look inconsistent within the content (two different deadlines, an undefined acronym used before it's explained) or that a reader would need and is missing (who to contact, by when).
- **Keep required terms.** If a legal or program term must stay, recommend explaining it in plain words next to it rather than replacing it.
- Quote the content exactly, so the writer can find each issue.

## 6. Present it

1. **Summary** (3–5 lines): overall score and priority, the readability numbers, and the **top three fixes**.
2. **Scores table**: criterion | weight | score | priority.
3. **Details** by criterion (strengths, issues with quotes, recommendations, before/after).
4. **Fit notes**: how you adapted the rubric, anything you ignored, any rubric inconsistencies.
5. **Next steps**: offer to (a) rewrite specific sections, or the whole piece, applying the fixes, and (b) translate it with the **usdr-benefits-translation** skill once the English is final.

Use readable formatting (headings, a table, bullets). Keep it proportionate: a short paragraph doesn't need a long report.

## Content in other languages

The rubric is for **English**. If the content is in Spanish or another language, say so and ask whether they meant to review an English source. If they want a review anyway, apply the same principles as a best effort and say clearly that the rubric wasn't written for that language.
