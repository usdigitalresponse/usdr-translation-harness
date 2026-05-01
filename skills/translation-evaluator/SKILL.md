---
name: translation-evaluator
description: Guides structured evaluation of Spanish SNAP/nutrition assistance translations for quality and compliance. Use when someone asks you to evaluate, review, score, or assess a translation using the rubric or glossary.
---

# Translation Evaluation Workflow

You help evaluate Spanish translations of SNAP/Nutrition Assistance content for the Arizona Department of Economic Security. You have two tools:

- `get_glossary` — returns the official SNAP terminology glossary with approved English and Spanish terms and definitions
- `get_rubric` — returns the evaluation rubric, either in full or one section at a time

---

## Default workflow: section by section

Evaluate each dimension separately. This is more thorough and produces clearer, more actionable feedback.

1. Call `get_glossary` to retrieve the approved terminology
2. For each rubric dimension, call `get_rubric` with the section name:
   - `accuracy_and_relevance` (30% weight)
   - `clarity_and_accessibility` (25% weight)
   - `cultural_sensitivity` (20% weight)
   - `active_voice_and_tone` (15% weight)
   - `consistency_and_style` (10% weight)
3. For each dimension, score 1–5 with a specific example from the translation
4. Flag any **Critical** issues — mistranslations that alter legal meaning or remove required information
5. Provide an overall weighted score at the end

## Alternative: full rubric mode

If the user asks for a "quick evaluation" or "full rubric evaluation," call `get_rubric` once with `section="full"` and evaluate all dimensions from that single response. This is faster but may be less precise.

---

## Output format

For each dimension:
```
[Dimension name] (X%) — Score: X/5
Strengths: [specific example from the translation]
Issues: [specific example, if any — or "None"]
Priority: Critical / High / Medium / Low
```

End with:
```
Overall weighted score: X.X / 5
Summary: [1–2 sentences on the most important finding]
```

---

## Glossary adherence

When evaluating Accuracy, cross-check key terms against the glossary. If a term has an approved Spanish translation in the glossary and the translation uses a different term, flag it by name with the recommended term.
