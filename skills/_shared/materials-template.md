# Materials

This skill doesn't contain the team's rules itself. It reads the team's **live materials** from Google Drive each time, so edits by the content team apply right away. This file says which materials this skill uses, where they are, and how to open them.

**Materials set:** {{MATERIALS_SET_NAME}}

## Setting up the links

If you see `{{…}}` placeholders in this file, it hasn't been set up yet. Replace each placeholder with your team's value (a link to the Google Doc or Sheet, the glossary tab name, a short name for the materials set), and save:
- **claude.ai:** Customize → Skills → this skill → open `references/materials.md` → edit.
- **Claude Code:** edit `references/materials.md` in the skill's folder (e.g. `~/.claude/skills/<skill>/` or a project's `.claude/skills/<skill>/`).

{{MATERIALS_TABLE}}

**More than one glossary?** Copy the glossary row once per glossary (for example one per program or department), and give each its own link, tab and **scope** (what program and kind of content it covers). The skill picks the glossary whose scope fits each term, and says when none does.

## Where these materials come from

The team uses these materials in an **automated translation pipeline**: a system that takes documents dropped into a Google Drive folder, sends them to an AI model with these prompts and the glossary, and writes the translations and scores to Drive for people to review. No one is in the conversation while it runs, so the materials include instructions meant for that system. In this skill you're working directly with a person, and you use the materials' judgment (criteria, priorities, terminology, style) without that machinery.

## How to open them

1. **Google Drive connector (preferred).** Open each link with the Drive connector. Docs read as text.{{GLOSSARY_OPEN_NOTE}}
2. **Local copies.** If the connector isn't available, look for a `materials/` folder next to this skill or in the current project, with the file names in the table. Tell the user which local file you used and its date if you know it, since it may be out of date.
3. **Neither works.** Say so plainly, name the missing material, and ask the user to share it (paste it, attach an export, or connect Google Drive). Don't silently substitute your own version. If the user wants to go ahead anyway, label the result clearly as "not checked against the team's materials".

If a link still shows a `{{…}}` placeholder, the skill hasn't been set up. Tell the user, and ask them for the link (or to paste or attach the material). Use what they give you for this conversation, and tell them how to save it so they aren't asked again: replace the placeholder in this file (see "Setting up the links" above).

## Reading them

- Use what they say about **criteria, priorities, terminology and style**.
- **Ignore instructions meant for the automated pipeline**, and mention once that you did. They're instructions about how the system passes text in and out rather than about the content, for example: input wrapped in tags like `<extraction>`, `<statutes>` or `<document>`; "return only JSON matching the schema"; "plain text only, no markdown"; references to material the pipeline supplies separately (like statutes) that you don't have.
- Note the **scope** each one states (content type, program, state, audience) and compare it with the content in front of you. The skill's instructions say how.
- If a material contradicts itself or another material (e.g. two different weights for the same criterion, two date formats), follow its main table or rule list, and tell the user about the inconsistency so the content team can fix it.
