# `.po` files (Django gettext)

Django keeps a site's interface text in **`.po` files**, one per language and "domain": `locale/es/LC_MESSAGES/django.po` holds text from templates and Python, and `djangojs.po` holds text from JavaScript. A project can have one `locale/` at the root or one per app. Developers regenerate the files with `python manage.py makemessages -l es`, which adds new strings and keeps existing translations. `compilemessages` turns them into the `.mo` files the site actually uses.

## An entry, line by line

```po
# AI draft (usdr-web-strings-translation, 2026-11-06): needs human review
#. Translators: Button that submits the benefits application
#: applications/templates/applications/apply.html:22
#, fuzzy
msgid "Apply"
msgstr "Enviar solicitud"
```

| Line | Meaning | Who writes it |
|---|---|---|
| `# ...` | Translator comment. It survives `makemessages`, so this skill puts its "AI draft" note here. | Translators (this skill) |
| `#. ...` | Extracted comment: a code comment starting with `Translators:`, copied from the template or Python. It's regenerated on every `makemessages`, so don't write here. | Developers |
| `#: file:line` | Where the string is used (one or more places). | `makemessages` |
| `#, ...` | Flags. `fuzzy` = not confirmed (see below); `python-format` / `javascript-format` = contains placeholders that must survive. | Both |
| `msgctxt "..."` | Context that separates two meanings of the same English (`pgettext("filter", "Apply")`). Each context is a separate entry with its own translation. | Developers |
| `msgid "..."` | The English. Never change it. | `makemessages` |
| `msgstr "..."` | The Spanish. Empty = not translated; the site shows English. | Translators |

**Plurals:** `msgid_plural` plus `msgstr[0]` (singular) and `msgstr[1]` (plural). Spanish has two forms (`Plural-Forms: nplurals=2; plural=(n != 1);` in the file header). Fill both. A form may leave out the number ("un archivo") if it reads better, but it may not add one.

**Obsolete entries** (`#~ msgid ...`) are strings the code no longer uses. Leave them alone; `makemessages` keeps them in case the string comes back.

## Fuzzy

`#, fuzzy` means "this translation isn't confirmed". Two things set it:
- `makemessages` / `msgmerge`, when it guesses a translation from a similar old string;
- this skill, on every new draft.

**Django's `compilemessages` skips fuzzy entries**, so the site shows the English until someone removes the flag. That's what makes it safe to write drafts straight into the project. A test environment can show the drafts with `compilemessages --use-fuzzy`; whether that's easy depends on how the team builds and deploys.

## Placeholders and HTML

These must come through **exactly**, though they may move within the sentence:
- **Python:** `%(name)s` (named; can move), `%s` / `%d` (positional; order matters), `{name}` (from `str.format`).
- **Templates:** `{% blocktrans %}...{{ date }}...{% endblocktrans %}` becomes `%(date)s` in the `.po` file.
- **JavaScript:** `gettext()` / `ngettext()` with `interpolate()`. Either `%s` (positional) or `%(name)s` (named, when `interpolate(..., true)`).
- **HTML** inside strings (`<strong>`, `<a href="%(url)s">`): keep every tag and attribute. Translate only the text between them.

Leading and trailing spaces and line breaks matter too. `"Total: "` is followed by an amount in the code, and an email body's `\n\n` is its paragraph break.

## What `po_tool.py` refuses

It refuses a translation or correction when any of these happen:
- a placeholder is missing, added or renamed;
- an HTML tag or attribute changes;
- a plural form is missing or empty;
- leading or trailing whitespace or line breaks differ from the English.

It also won't replace a non-fuzzy translation without `--overwrite`. `check` adds `msgfmt -c` when GNU gettext is installed.
