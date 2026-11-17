# Sample project (synthetic)

A **made-up** Django project, "Example State Family Services", used to test and demo the `usdr-web-strings-translation` skill. It isn't a real site and doesn't describe any real program; it exists only to contain the kinds of strings that are hard to translate well (see `../expected.md`).

Only the parts the skill reads are here: templates, a few Python and JavaScript files that mark strings for translation, and the Spanish `.po` files in `locale/es/LC_MESSAGES/`. It doesn't run as a website.

**To try the skill on it, copy it somewhere outside the skill first**, so the skill edits the copy:

    cp -r examples/sample-django /tmp/sample-django

**To start over**, delete the copy and copy the sample again. Everything a run creates (the edited `.po` files and `docs/translation/`) is inside the copy:

    rm -rf /tmp/sample-django && cp -r examples/sample-django /tmp/sample-django
