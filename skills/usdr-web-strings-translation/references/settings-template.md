# Settings template (and the first-run walkthrough)

On the first run, walk the user through the **six settings one at a time**: explain the setting in your own words from the paragraph below, give the default and why, and ask to keep or change it. The person may be an engineer who hasn't thought about translation before; don't assume they know what fuzzy means. Before starting, offer the shortcut, for example:

> There are six settings. I'll go through them one at a time, or say "use the defaults for now" and I'll save the defaults. Either way they go in `docs/translation/translation-settings.md`, and you can change any of them later.

The **always-reviewed rule** isn't a setting, so don't count it or ask about it. Mention it when you explain settings 1 and 2, since it's the limit on both. Then write `docs/translation/translation-settings.md` from the template, filling in each choice, who chose it and the date.

Two things are **decided, not settings**: entries are translated in chunks of about 40, and everything lives under `docs/translation/`. Both can be changed if someone asks.

## Template

```markdown
# Translation settings

Used by the usdr-web-strings-translation skill on every run. Edit this file, or ask the skill to change a setting (it updates the date and "changed by").
Why each default was chosen, with sources: the skill's DECISIONS.md.

## Always reviewed (a rule, not a setting)
**Always drafts:** rights, decisions about benefits, money, deadlines, eligibility, legal and appeal information

These are always drafts, whatever the settings below say. A wrong word here can cost someone a benefit or a deadline. You can **add** categories (for example health or immigration): edit this line, or ask the skill. You can't remove these.

## 1. Mark new translations as drafts (fuzzy)
**Setting:** yes
**Changed by / date:** default, <date>

Every new translation gets a "fuzzy" flag, which means "not confirmed". Django leaves fuzzy translations out when it builds the site, so visitors see the English for that text until a reviewer approves it. This is what keeps unreviewed AI translations off the public site. The cost is that pages show a mix of English and Spanish until review is done. Turning this off makes drafts visible immediately, unreviewed. Only consider it if a qualified reviewer checks everything before each deploy some other way. A test or staging site can show drafts anyway (`compilemessages --use-fuzzy`), which gets you previews without the risk.

## 2. Roles that skip review
**Setting:** none
**Changed by / date:** default, <date>

A list of string roles (for example `navigation, tab`) whose translations go live without review. This lets low-risk, everyday words ("Inicio", "Ayuda") appear in Spanish right away, so pages look less mixed. The risk is small but real: a short menu word with no context is exactly where machine translation guesses wrong. If you use it, keep it to roles where the words are common and the meaning is obvious, and spot-check them. It never applies to the always-reviewed content above.

## 3. Replace existing translations
**Setting:** no
**Changed by / date:** default, <date>

When a string already has a confirmed (non-fuzzy) Spanish translation, the skill leaves it alone and only fills in missing ones and drafts. Someone may have reviewed that translation; replacing it would undo human work silently. You can still ask for specific strings to be retranslated. The skill then asks before replacing, and the new version goes back to draft.

## 4. Button, menu and tab wording
**Setting:** infinitive ("Guardar", "Solicitar beneficios")
**Changed by / date:** default, <date>, to confirm with the content team

Spanish interfaces word commands two ways: the infinitive ("Guardar", "to save") or the command form ("Guarde", "save!"). The infinitive is the common convention for buttons and menus (Microsoft's US Spanish style guide; HealthCare.gov's Spanish site uses it on buttons). It's shorter, neutral, and doesn't need usted or tú. Changing it to the usted command form makes buttons sound more like instructions, and longer. Pick one and keep it site-wide; mixing them looks careless.

## 5. Instructions and links inside sentences
**Setting:** usted command form ("Inicie sesión para continuar")
**Changed by / date:** default, <date>

Text that tells the reader to do something, inside a sentence or as a link in a sentence, uses the formal command form. US government Spanish sites use usted, and the translation prompt requires it. This setting exists so the button choice (4) isn't applied to instructions by mistake. Changing it would contradict the prompt's form of address.

## 6. Length warning for short strings
**Setting:** flag when the Spanish is more than 2× the English (and at least 6 characters longer), for buttons, menus, tabs and dropdown options up to about 20 characters
**Changed by / date:** default, <date>

Spanish usually runs longer than English, and short strings grow the most: often two to three times for a 10-character word, because there's no room to absorb it. Buttons and menus may not wrap or may cut off. The skill flags long ones for someone to check on the screen, and offers a shorter option. It doesn't shorten on its own if that would lose meaning. Raise the limit if your layout handles long labels well; lower it for tight designs, such as mobile tabs.
```
