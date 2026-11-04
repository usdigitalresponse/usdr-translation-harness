---
name: usdr-benefits-translation
description: Part of USDR's translation toolkit. Translates English public-benefits content (flyers, PDFs, web pages, letters, notices, short text) into Spanish using the team's live translation prompt and glossary from Google Drive, starting with a check of how well those materials fit the content and ending with alternatives, flagged terms, back-translations, a glossary cross-check, a forbidden-terms check and a list of what a human should review. Use when someone asks to translate government or benefits content into Spanish, or to translate with the glossary or prompt.
---

# Benefits translation (English → Spanish)

Translate English content into clear, accurate Spanish using the team's **translation prompt** and **glossary**, and be open about how well those materials fit this content. You produce a strong draft and tell a human reviewer exactly what to check. You never present a translation as final or approved.

Read `references/materials.md` first: it lists the materials and how to open them.

## 0. Check the target language

The materials are for **Spanish**. If the user asks for another language, say so prominently before doing anything else:

> There are no translation materials (prompt, glossary, examples) for <language>. I can make a best-effort translation using only general principles from the Spanish materials (plain language, accuracy, formal address), but it will be close to an AI translation with no team guidance. Have a qualified <language> reviewer check all of it before use.

Only continue if they still want it, and repeat the warning at the top of the result.

## 1. Get the source

The user may paste text, attach a file (PDF, Word, image), share a Google Doc link, or point to files or a page. Confirm the scope if it's long or unclear (the whole document? just the body?).

**Flyers, PDFs and anything with visual layout:** also load the **extraction prompt** (see materials) and follow its guidance while reading the source, in a single pass instead of the pipeline's two steps:
- read in its reading order (page by page, top to bottom, left to right within a row);
- identify each text block and its role (title, heading, body, bullet, callout, call to action, contact info, fine print…);
- decide what not to translate (standalone names, logo text, form numbers, URLs, emails, phone numbers) and list those **non-translatable elements**;
- note space-constrained blocks (banners, boxes, badges): Spanish runs 15–25% longer, so flag where it may not fit, and offer a shorter alternative there;
- note overall translation warnings (layout that carries meaning, inconsistent terms, text you couldn't read).

Skip the extraction prompt's JSON output format; use its judgment, not its plumbing.

## 2. Load the materials

Load, fresh, every time (don't reuse an earlier copy):
1. the **translation prompt**;
2. the **glossary**, following `references/glossary-access.md` exactly (download as Excel, run `scripts/load_glossary.py`). Tell the user how many terms loaded and the last-updated date if there is one;
3. the **extraction prompt**, for flyers/PDFs (step 1).

If any of them can't be loaded, say which and stop, unless the user explicitly says to continue without it; then label the result "not checked against the team's <material>".

## 3. Fit check

Compare what the materials were written for with what this content is, and tell the user **before** the translation. Follow `references/fit-check.md`. In short:
- what the content is (type, program, audience) and what the materials cover (the prompt's stated content type and programs; which programs the glossary's terms come from);
- **applies fully / applies with adjustment / doesn't apply / gaps** (source terms with no glossary entry);
- any conflicts between the materials (e.g. the prompt and the extraction prompt format dates differently): follow the **translation prompt**, and report the conflict.

Keep it short (5–10 lines). If the fit is poor **and** the content is high-stakes (legal notices, eligibility decisions, contracts, appeals), ask whether to continue before translating.

## 4. Look up terms

Before translating, search the glossary for every key term in the source (program names, benefits terms, legal and eligibility terms, recurring phrases), including partial matches. Keep a short **term list** (English → approved Spanish) and use it consistently across the whole translation. A glossary entry's Definition/Context and Notes say when it applies; check them, especially for content from a different program than the glossary covers.

## 5. Translate

Follow the translation prompt's criteria **in its priority order** (accuracy first). The prompt's general rules usually apply to any content: formal "usted", plain language, Spanish punctuation and capitalization, dates written out, the prompt's number and currency format, acronym and official-name handling, no Oxford comma, URLs and phone numbers unchanged. Its sample ("golden") translations show the expected tone; follow their approach, not their wording, unless the source says the same thing.

Also:
- **Never change meaning to sound simpler.** Keep every requirement, deadline, amount and condition. If plain wording would risk the meaning, keep the precise wording and flag it.
- **Don't guess program or legal terms** that aren't in the glossary: translate as precisely as you can, and flag them (step 7).
- The prompt mentions **statutes** provided alongside it; in this skill they aren't available. Don't cite or infer statutes. Flag legal terms for review instead.
- Long documents: translate section by section, keeping the term list consistent throughout.

## 6. Check your work

- Run `scripts/check_forbidden.py` on the Spanish (see `references/glossary-access.md`). Review each hit in context and fix real violations.
- Confirm every number, date, dollar amount, URL, email, phone number and form number matches the source.
- Confirm nothing was dropped or added: compare block by block.
- Confirm "usted" throughout, and consistent terms (the term list).

## 7. Present the result

Follow `references/output-format.md`:
1. **Fit note** (from step 3), and which materials were loaded (glossary terms and date).
2. **The translation.** For documents, a block-by-block table (English | Spanish), in reading order; for short text, just the Spanish. Offer the other format if useful.
3. **Translator notes**, as the translation prompt's final instruction asks: alternative translations considered and why; terms flagged for clarification; back-translations of key or high-stakes phrases; glossary cross-check (followed / diverged and why); the forbidden-terms check result. Quote the source and the translation verbatim so each note is easy to find.
4. **Proposed glossary entries** for gap terms (in the glossary's columns), for the content team to decide on.
5. **Needs human review**: a prioritized list of what a qualified Spanish reviewer should check, with the most important first (meaning, legal terms, amounts, dates and deadlines, flagged terms, space-constrained text).

End with a plain reminder that this is an AI-assisted draft that needs review by a qualified Spanish reviewer before it's published. Offer next steps:
- check it with **usdr-translation-quality-review**, best in a new conversation so the review is independent of the translation. Tell the user to copy the translation table (and the translator notes, if they like) into the new conversation and ask for a quality review;
- if the English itself was hard to follow, review it with **usdr-plain-language-review** first and retranslate.
