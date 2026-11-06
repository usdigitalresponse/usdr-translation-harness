# Sample review (synthetic)

For testing and demos, without waiting for a real reviewer.

- `ai-draft-django.json`, `ai-draft-djangojs.json`: a canned AI draft of the whole sample project, in the format `po_tool.py apply` takes. Use it to get to the review step quickly, or to compare with a live run.
- `review-sheet-filled.csv`: the review sheet as a reviewer might return it. Most rows are approved. It also has:
  - four corrections, including a plural and one that drops a trailing space (the tool puts it back);
  - two comment-only rows (questions; they stay drafts);
  - one correction that renames a placeholder (`%(first_name)s` → `%(nombre)s`), which the tool refuses;
  - two rows left blank.

Each row's ID (such as `django:feb192bc71`) is the `.po` file name plus a fingerprint of the string's English and context (see "The review sheet's ID column" in `references/review-and-escalation.md`). It doesn't depend on the Spanish, so this sheet applies to any draft of the sample, live or canned. Its "Spanish (AI draft)" column shows the canned draft.

Quick run, outside Claude, on a copy of the sample (from the skill folder):

    cp -r examples/sample-django /tmp/sample-django
    L=/tmp/sample-django/locale/es/LC_MESSAGES; R=/tmp/sample-django/docs/translation/reports/demo
    python3 scripts/po_tool.py apply $L/django.po examples/sample-review/ai-draft-django.json --run-dir $R
    python3 scripts/po_tool.py apply $L/djangojs.po examples/sample-review/ai-draft-djangojs.json --run-dir $R
    python3 scripts/po_tool.py export-review $L/django.po $L/djangojs.po --run-dir $R
    python3 scripts/po_tool.py import-review $L/django.po $L/djangojs.po examples/sample-review/review-sheet-filled.csv --run-dir $R
