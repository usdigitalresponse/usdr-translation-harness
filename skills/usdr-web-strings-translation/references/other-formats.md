# Other string formats (not supported yet)

This skill's tooling (`po_tool.py`) reads and writes only gettext `.po` files. Other web frameworks keep strings differently. Notes for whoever extends the skill:

| Format | Where files live | Placeholders | Plurals | What a tool would need |
|---|---|---|---|---|
| **Rails YAML** (`config/locales/es.yml`) | Nested keys, one file per language | `%{name}` | Keys `one:` / `other:` under the string | A YAML round trip that keeps key order and comments; a place for an "AI draft" marker (no fuzzy flag exists, so drafts need a separate file or a review state) |
| **JSON (i18next, react-intl, Vue)** (`locales/es/*.json`) | Nested or flat keys | `{{name}}` (i18next), `{name}` (ICU) | i18next `key_one` / `key_other`; ICU `{count, plural, one {...} other {...}}` | ICU message parsing for plurals and select; no fuzzy flag, so same as YAML |
| **XLIFF** (`.xlf`, Angular, iOS) | XML, `<trans-unit>` per string | `<x id="..."/>` elements | ICU inside the text | XML round trip; has a `state="needs-review-translation"` attribute, which plays the role of fuzzy |

What carries over unchanged:
- the workflow (page-by-page reading, terms settled once, review packet, decision log);
- the checks (placeholders, plurals, whitespace, HTML, length, consistency).

What changes:
- the parser;
- how "not reviewed yet" is recorded, since only `.po` (fuzzy) and XLIFF (state) have a built-in flag.
