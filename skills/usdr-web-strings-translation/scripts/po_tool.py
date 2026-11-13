#!/usr/bin/env python3
"""Read, write and check Django .po files for the usdr-web-strings-translation skill.

Claude never edits .po files by hand: every read and write goes through this
tool, which keeps plural forms, whitespace, placeholders and HTML intact and
refuses translations that would break them. Output is JSON.

    po_tool.py find     <project dir>
        Spanish .po files in the project, with counts per page group.
    po_tool.py scan     <po file>... [--include untranslated|fuzzy|all] [--page TEXT] [--msgid TEXT]
        Entries to work on, grouped by page (shared layout first), each with its
        ID, comments, file:line references, a first guess at its role, and its
        placeholders, tags and leading/trailing whitespace.
    po_tool.py context  <project dir> <file:line>... [--around N]
        The source lines around each reference.
    po_tool.py apply    <po file> <translations.json> --run-dir DIR [--overwrite]
        Writes translations (see TRANSLATION INPUT below), marks them fuzzy with
        an "AI draft" comment, and appends each decision to DIR/decisions.jsonl.
    po_tool.py check    <po file>... [--run-dir DIR] [--glossary glossary.json]
        Placeholders, HTML, plurals, whitespace and msgfmt -c (errors); length,
        consistency and forbidden terms (for Claude to look at).
    po_tool.py export-review <po file>... --run-dir DIR
        Writes DIR/review-sheet.csv for a reviewer: every fuzzy entry, in page order.
    po_tool.py import-review <po file>... <review-sheet.csv> --run-dir DIR [--reviewer NAME]
        Applies a filled-in review sheet: approvals and corrections lose the fuzzy
        flag; comment-only rows stay fuzzy; broken corrections are refused.

TRANSLATION INPUT (for apply) is a JSON list, one object per entry:
    {"id": "<from scan>", "msgstr": "..."}                    # or "msgstr_plural": ["...", "..."]
    optional: "fuzzy": false (only when the settings allow it), "high_stakes": true,
              "page", "role", "place_on_page", "priority", "flags" (list of reasons
              to review), "reasoning", "alternatives", "glossary_terms", "ledger_terms"

The project root (for reading templates) is the folder that contains locale/,
or --root. Exit status is 1 when anything was refused or a check failed.
Needs polib (pip install polib); msgfmt is optional.
"""

import argparse
import csv
import datetime
import hashlib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

try:
    import polib
except ImportError:
    sys.exit("polib isn't installed. Run: pip install polib")

# check_forbidden.py ships next to this script (from the shared glossary group).
# In the source tree it lives in skills/_shared/glossary/scripts/.
SCRIPT_DIR = Path(__file__).resolve().parent
for _candidate in (SCRIPT_DIR, SCRIPT_DIR.parents[1] / "_shared" / "glossary" / "scripts"):
    if (_candidate / "check_forbidden.py").exists():
        sys.path.insert(0, str(_candidate))
        break
try:
    from check_forbidden import (APPROVED, ENGLISH_TERM, FORBIDDEN, MIN_TERM_CHARS, SPLIT_TERMS,
                                 field, fold, term_pattern)
except ImportError:
    term_pattern = None

ENCODING = "utf-8"
WRAP_WIDTH = 79
SPANISH_GLOB = "**/locale/es/LC_MESSAGES/*.po"
LOCALE_DIR = "locale"
TOOL_NAME = "usdr-web-strings-translation"
AI_DRAFT_PREFIX = f"AI draft ({TOOL_NAME}"
FUZZY = "fuzzy"
DECISIONS_FILE = "decisions.jsonl"
REVIEW_SHEET = "review-sheet.csv"
CSV_BOM = "\ufeff"          # so Excel opens the sheet with accents intact
PLURAL_SEPARATOR = " || "   # how plural forms appear in the review sheet
ID_HASH_CHARS = 10
CONTEXT_AROUND = 6
DEFAULT_PLURAL_FORMS = 2
SHORT_STRING_CHARS = 20
SHORT_STRING_MAX_RATIO = 2.0
SHORT_STRING_MIN_GROWTH = 6   # so "Next" -> "Siguiente" isn't flagged
LAYOUT_GROUP = "Shared layout (every page)"
MULTI_GROUP = "Used on several pages"
NO_REFERENCE = "(no file reference)"
STATUS_UNTRANSLATED = "untranslated"
STATUS_FUZZY = "fuzzy"
STATUS_TRANSLATED = "translated"
INCLUDE = {
    "untranslated": {STATUS_UNTRANSLATED},
    "fuzzy": {STATUS_UNTRANSLATED, STATUS_FUZZY},
    "all": {STATUS_UNTRANSLATED, STATUS_FUZZY, STATUS_TRANSLATED},
}
# Roles that sit in fixed-width UI, where length matters
CONSTRAINED_ROLES = {"button", "link button", "navigation", "tab", "menu item", "dropdown option"}
APPROVE_WORDS = {"yes", "y", "sí", "si", "x", "approve", "approved", "ok", "true"}
DEFAULT_PRIORITY = "Medium"
HIGH_STAKES_PRIORITY = "Critical"
EARLIER_DRAFT_NOTE = "Marked fuzzy before this run (not an AI draft from this tool)"

# Placeholders: %(name)s, %s, %d; {name}, {0}, {} (str.format / JS)
PRINTF = re.compile(r"%\((\w+)\)[sdifr]|%[sdifr]")
BRACE = re.compile(r"\{\w*\}")
HTML_TAG = re.compile(r"</?\s*([a-zA-Z][\w-]*)([^>]*)>")
H1_TRANS = re.compile(r"<h1[^>]*>\s*\{%\s*trans\s+\"([^\"]+)\"")
EXTENDS = re.compile(r"\{%\s*extends\s+[\"']([^\"']+)[\"']")

COL_ID, COL_PAGE, COL_WHERE, COL_EN, COL_ES, COL_WHY, COL_PRIORITY = (
    "ID", "Page", "Where on the page", "English", "Spanish (AI draft)", "Why it's flagged", "Priority")
COL_APPROVE, COL_CHANGE, COL_COMMENT = (
    "Reviewer: Approve? (yes/no)", "Reviewer: Change to", "Reviewer: Comment")
REVIEW_COLUMNS = [COL_ID, COL_PAGE, COL_WHERE, COL_EN, COL_ES, COL_WHY, COL_PRIORITY,
                  COL_APPROVE, COL_CHANGE, COL_COMMENT]


# ── Loading, identity, status ─────────────────────────────────────────────

def load(path):
    return polib.pofile(str(path), encoding=ENCODING, wrapwidth=WRAP_WIDTH)


def entry_id(po_path, entry):
    """Stable short ID from the file name, context and English text."""
    key = f"{Path(po_path).name}\x00{entry.msgctxt or ''}\x00{entry.msgid}"
    return f"{Path(po_path).stem}:{hashlib.sha1(key.encode(ENCODING)).hexdigest()[:ID_HASH_CHARS]}"


def plural_forms(po):
    m = re.search(r"nplurals\s*=\s*(\d+)", po.metadata.get("Plural-Forms", ""))
    return int(m.group(1)) if m else DEFAULT_PLURAL_FORMS


def project_root(po_path, root=None):
    """The folder containing locale/ (Django's usual layout), unless --root is given."""
    if root:
        return Path(root).resolve()
    path = Path(po_path).resolve()
    for parent in path.parents:
        if parent.name == LOCALE_DIR:
            return parent.parent
    return path.parent


def project_relative(po_path, root=None):
    """The .po path relative to the project (for logs committed with the project)."""
    path = Path(po_path).resolve()
    try:
        return path.relative_to(project_root(po_path, root)).as_posix()
    except ValueError:
        return path.name


def forms_of(entry, count):
    """The entry's Spanish as a list (one item, or one per plural form)."""
    if entry.msgid_plural:
        return [entry.msgstr_plural.get(i, "") for i in range(count)]
    return [entry.msgstr]


def status(entry):
    if FUZZY in entry.flags:
        return STATUS_FUZZY
    done = all(entry.msgstr_plural.values()) if entry.msgid_plural else bool(entry.msgstr)
    return STATUS_TRANSLATED if done else STATUS_UNTRANSLATED


def is_ai_draft(entry):
    return AI_DRAFT_PREFIX in (entry.tcomment or "")


# ── What must survive translation ─────────────────────────────────────────

def placeholders(text):
    text = text or ""
    return sorted(m.group(0) for m in PRINTF.finditer(text)) + sorted(BRACE.findall(text))


def html_tags(text):
    """Tags with any placeholders in their attributes, e.g. ['/a', 'a %(url)s']."""
    out = []
    for m in HTML_TAG.finditer(text or ""):
        closing = "/" if m.group(0).startswith("</") else ""
        attrs = " ".join(placeholders(m.group(2)))
        out.append(f"{closing}{m.group(1).lower()}{' ' + attrs if attrs else ''}")
    return sorted(out)


def edges(text):
    """(leading whitespace, trailing whitespace, number of line breaks)."""
    text = text or ""
    return text[:len(text) - len(text.lstrip())], text[len(text.rstrip()):], text.count("\n")


def restore_edges(source, translation):
    """Give a reviewer's correction the English's leading/trailing whitespace
    (a spreadsheet cell easily loses a trailing space or newline)."""
    lead, trail, _ = edges(source)
    return lead + translation.strip() + trail


def problems(entry, forms, expected_forms):
    """Reasons a translation can't be written. Empty list = fine."""
    found = []
    if entry.msgid_plural and len(forms) != expected_forms:
        found.append(f"needs {expected_forms} plural forms, got {len(forms)}")
    sources = [entry.msgid, entry.msgid_plural] if entry.msgid_plural else [entry.msgid]
    for i, text in enumerate(forms):
        source = sources[min(i, len(sources) - 1)]
        label = f"form {i}: " if entry.msgid_plural else ""
        if not text.strip():
            found.append(f"{label}empty")
            continue
        theirs, ours = placeholders(source), placeholders(text)
        # gettext lets a plural form leave out the number (e.g. "un archivo")
        dropped_ok = entry.msgid_plural and set(ours) <= set(theirs)
        if ours != theirs and not dropped_ok:
            found.append(f"{label}placeholders differ (English {theirs}, Spanish {ours})")
        if html_tags(text) != html_tags(source):
            found.append(f"{label}HTML tags differ (English {html_tags(source)}, Spanish {html_tags(text)})")
        if edges(text) != edges(source):
            found.append(f"{label}leading/trailing spaces or line breaks differ from the English")
    return found


# ── Pages and roles ───────────────────────────────────────────────────────

def read_lines(path):
    try:
        return Path(path).read_text(encoding=ENCODING, errors="replace").splitlines()
    except OSError:
        return []


def layout_templates(root):
    """Templates that other templates extend (base layouts), relative to root."""
    templates = list(root.rglob("*.html"))
    extended = set()
    for f in templates:
        m = EXTENDS.search("\n".join(read_lines(f)))
        if m:
            extended.add(m.group(1))
    return {f.relative_to(root).as_posix() for f in templates
            if any(f.as_posix().endswith("/" + name) for name in extended)}


def page_name(root, rel):
    """A human name for a page: its <h1> text and file, else just the file."""
    m = H1_TRANS.search("\n".join(read_lines(root / rel))) if rel.endswith(".html") else None
    return f"{m.group(1)} ({rel})" if m else rel


def group_of(entry, layouts):
    files = sorted({f for f, _ in entry.occurrences})
    if any(f in layouts for f in files):
        return LAYOUT_GROUP
    if len(files) > 1:
        return MULTI_GROUP
    return files[0] if files else NO_REFERENCE


def group_label(root, group):
    return group if group in (LAYOUT_GROUP, MULTI_GROUP, NO_REFERENCE) else page_name(root, group)


HTML_ROLE_HINTS = [
    ("<title", "page title"), ("aria-label", "accessibility label"), ("<button", "button"),
    ('class="button', "link button"), ("<option", "dropdown option"), ("<label", "form label"),
    ("<h1", "heading"), ("<h2", "heading"), ("<h3", "heading"), ("<th", "table header"),
]
PY_ROLE_HINTS = [
    ("label=", "form label"), ("help_text=", "help text"), ("validationerror", "error message"),
    ("messages.", "status message"), ("subject", "email subject"), ("email", "email text"),
]


def guess_role(root, rel, line):
    """First guess at a string's UI role from its source line, with the line as
    evidence. Claude confirms or corrects it by reading the context."""
    lines = read_lines(root / rel)
    try:
        index = int(line) - 1
        text = lines[index]
    except (ValueError, IndexError):
        return "unknown", ""
    lowered = text.lower()
    if rel.endswith(".html"):
        for needle, role in HTML_ROLE_HINTS:
            if needle in lowered:
                return role, text.strip()
        before = "\n".join(lines[:index + 1])
        if before.count("<nav") > before.count("</nav>") and "<a" in lowered:
            return "navigation", text.strip()
        if "<p" in lowered or "blocktrans" in lowered:
            return "body text", text.strip()
        if "<a" in lowered:
            return "link", text.strip()
    elif rel.endswith(".py"):
        for needle, role in PY_ROLE_HINTS:
            if needle in lowered:
                return role, text.strip()
        return "text from Python code", text.strip()
    elif rel.endswith(".js"):
        return "text from JavaScript", text.strip()
    return "unknown", text.strip()


def describe(po_path, entry, root, count):
    refs = [{"file": f, "line": int(l) if l.isdigit() else l} for f, l in entry.occurrences]
    role, evidence = guess_role(root, *entry.occurrences[0]) if entry.occurrences else ("unknown", "")
    lead, trail, breaks = edges(entry.msgid)
    item = {
        "id": entry_id(po_path, entry),
        "status": status(entry),
        "msgctxt": entry.msgctxt,
        "msgid": entry.msgid,
        "developer_comment": entry.comment or None,
        "translator_comment": entry.tcomment or None,
        "flags": entry.flags,
        "references": refs,
        "pages": sorted({page_name(root, r["file"]) for r in refs}),
        "role_guess": role,
        "role_evidence": evidence,
        "placeholders": placeholders(entry.msgid),
        "html_tags": html_tags(entry.msgid),
        "leading_space": lead, "trailing_space": trail, "line_breaks": breaks,
        "current": forms_of(entry, count) if entry.msgid_plural else entry.msgstr,
    }
    if entry.msgid_plural:
        item["msgid_plural"] = entry.msgid_plural
        item["plural_forms_needed"] = count
    return item


# ── Commands ──────────────────────────────────────────────────────────────

def cmd_find(args):
    project = Path(args.project).resolve()
    report = []
    for path in sorted(project.glob(SPANISH_GLOB)):
        if "site-packages" in path.parts:
            continue
        po = load(path)
        layouts = layout_templates(project_root(path, args.root))
        by_group = defaultdict(Counter)
        for e in po:
            if not e.obsolete:
                by_group[group_of(e, layouts)][status(e)] += 1
        report.append({
            "po_file": str(path),
            "totals": dict(sum(by_group.values(), Counter())),
            "by_group": {g: dict(c) for g, c in sorted(by_group.items())},
            "obsolete_entries": sum(1 for e in po if e.obsolete),
        })
    print(json.dumps({"project": str(project), "spanish_po_files": report}, ensure_ascii=False, indent=2))


def cmd_scan(args):
    groups = defaultdict(list)
    labels = {}
    for path in args.po:
        root = project_root(path, args.root)
        layouts = layout_templates(root)
        po = load(path)
        count = plural_forms(po)
        for e in po:
            if e.obsolete or status(e) not in INCLUDE[args.include]:
                continue
            if args.page and not any(args.page in f for f, _ in e.occurrences):
                continue
            if args.msgid and args.msgid.lower() not in e.msgid.lower():
                continue
            group = group_of(e, layouts)
            labels[group] = group_label(root, group)
            item = describe(path, e, root, count)
            item["po_file"] = str(path)
            groups[group].append(item)
    # Shared layout first, then each page, then strings used on several pages
    order = sorted(groups, key=lambda g: (g != LAYOUT_GROUP, g == MULTI_GROUP, g))
    print(json.dumps({
        "total": sum(len(v) for v in groups.values()),
        "groups": [{"group": labels[g], "count": len(groups[g]), "entries": groups[g]} for g in order],
    }, ensure_ascii=False, indent=2))


def cmd_context(args):
    root = Path(args.project)
    for ref in args.refs:
        rel, _, line = ref.rpartition(":")
        lines = read_lines(root / rel)
        if not lines or not line.isdigit():
            print(f"== {ref}: can't read it")
            continue
        n = int(line)
        print(f"== {ref}")
        for i in range(max(1, n - args.around), min(len(lines), n + args.around) + 1):
            print(f"{'>' if i == n else ' '}{i:5}  {lines[i - 1]}")


def ai_comment(date):
    return f"{AI_DRAFT_PREFIX}, {date}): needs human review"


def without_ai_comment(entry):
    return [l for l in (entry.tcomment or "").splitlines() if AI_DRAFT_PREFIX not in l]


def log_decisions(run_dir, records):
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    with open(run_dir / DECISIONS_FILE, "a", encoding=ENCODING) as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def read_decisions(run_dir):
    path = Path(run_dir) / DECISIONS_FILE if run_dir else None
    if not path or not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding=ENCODING).splitlines() if l.strip()]


def latest_translations(run_dir):
    """This run's most recent translation decision for each entry ID."""
    return {r["id"]: r for r in read_decisions(run_dir) if r.get("type") == "translation"}


DECISION_FIELDS = ("page", "role", "place_on_page", "priority", "flags", "reasoning",
                   "alternatives", "glossary_terms", "ledger_terms")


def cmd_apply(args):
    po = load(args.po)
    count = plural_forms(po)
    by_id = {entry_id(args.po, e): e for e in po if not e.obsolete}
    items = json.loads(Path(args.translations).read_text(encoding=ENCODING))
    today = datetime.date.today().isoformat()
    applied, refused, records = 0, [], []
    for item in items:
        eid = item.get("id")
        e = by_id.get(eid)
        if e is None:
            refused.append({"id": eid, "reason": "no entry with this ID (run scan for IDs)"})
            continue
        if status(e) == STATUS_TRANSLATED and not args.overwrite:
            refused.append({"id": eid, "msgid": e.msgid,
                            "reason": "already translated and not fuzzy; a person may have approved it (use --overwrite)"})
            continue
        forms = item.get("msgstr_plural") if e.msgid_plural else [item.get("msgstr", "")]
        if not isinstance(forms, list) or not all(isinstance(f, str) for f in forms):
            refused.append({"id": eid, "msgid": e.msgid,
                            "reason": "plural entries need msgstr_plural, a list of strings" if e.msgid_plural
                            else "msgstr must be a string"})
            continue
        found = problems(e, forms, count)
        if found:
            refused.append({"id": eid, "msgid": e.msgid, "reason": "; ".join(found)})
            continue
        if e.msgid_plural:
            e.msgstr_plural = dict(enumerate(forms))
        else:
            e.msgstr = forms[0]
        high_stakes = bool(item.get("high_stakes"))
        fuzzy = high_stakes or item.get("fuzzy", True)
        if fuzzy and FUZZY not in e.flags:
            e.flags.append(FUZZY)
        elif not fuzzy and FUZZY in e.flags:
            e.flags.remove(FUZZY)
        e.tcomment = "\n".join(without_ai_comment(e) + [ai_comment(today)])
        applied += 1
        records.append({
            "type": "translation", "date": today, "id": eid, "po_file": project_relative(args.po),
            "msgctxt": e.msgctxt, "msgid": e.msgid, "msgid_plural": e.msgid_plural or None,
            "spanish": forms if e.msgid_plural else forms[0], "fuzzy": fuzzy, "high_stakes": high_stakes,
            **{k: item[k] for k in DECISION_FIELDS if item.get(k) is not None},
        })
    if applied:
        po.save(str(args.po))
        log_decisions(args.run_dir, records)
    print(json.dumps({"applied": applied, "refused": refused,
                      "decision_log": str(Path(args.run_dir) / DECISIONS_FILE)}, ensure_ascii=False, indent=2))
    if refused:
        sys.exit(1)


def forbidden_hits(texts, glossary_path):
    entries = json.loads(Path(glossary_path).read_text(encoding=ENCODING))
    hits = []
    for text in texts:
        folded = fold(unicodedata.normalize("NFC", text))
        for g in entries:
            for term in SPLIT_TERMS.split(field(g, FORBIDDEN)):
                term = term.strip(" .\"'“”")
                if len(term) >= MIN_TERM_CHARS and term_pattern(term).search(folded):
                    hits.append({"spanish": text, "forbidden_term": term, "glossary_entry": field(g, ENGLISH_TERM),
                                 "approved_spanish": field(g, APPROVED)})
    return hits


def cmd_check(args):
    errors, warnings, texts = [], [], []
    roles = {i: r.get("role") for i, r in latest_translations(args.run_dir).items()}
    spanish_for = defaultdict(set)    # (context, English) -> Spanish versions, across files
    english_for = defaultdict(set)    # Spanish -> English strings
    for path in args.po:
        po = load(path)
        count = plural_forms(po)
        for e in po:
            forms = forms_of(e, count)
            if e.obsolete or not any(forms):
                continue
            eid = entry_id(path, e)
            errors += [{"id": eid, "msgid": e.msgid, "problem": p} for p in problems(e, forms, count)]
            spanish = PLURAL_SEPARATOR.join(forms)
            texts.append(spanish)
            spanish_for[(e.msgctxt, e.msgid)].add(spanish)
            english_for[spanish].add(e.msgid)
            role = roles.get(eid)
            growth = len(forms[0]) - len(e.msgid)
            too_long = (len(forms[0]) > SHORT_STRING_MAX_RATIO * len(e.msgid)
                        and growth >= SHORT_STRING_MIN_GROWTH)
            if len(e.msgid) <= SHORT_STRING_CHARS and too_long and (role is None or role in CONSTRAINED_ROLES):
                warnings.append({"id": eid, "msgid": e.msgid, "spanish": forms[0],
                                 "warning": f"more than {SHORT_STRING_MAX_RATIO:g}x the English length"
                                            + (f" for a {role}" if role else "; check it fits if it's a button or menu")})
    for (ctx, msgid), versions in spanish_for.items():
        if len(versions) > 1:
            warnings.append({"msgid": msgid, "msgctxt": ctx, "versions": sorted(versions),
                             "warning": "the same English is translated differently in different files"})
    for spanish, english in english_for.items():
        if len(english) > 1:
            warnings.append({"spanish": spanish, "english": sorted(english),
                             "warning": "different English strings share this translation; fine only if they mean the same"})
    forbidden = []
    if args.glossary:
        if term_pattern is None:
            warnings.append({"warning": "check_forbidden.py not found; forbidden terms weren't checked"})
        else:
            forbidden = forbidden_hits(texts, args.glossary)
    msgfmt_errors = []
    if shutil.which("msgfmt"):
        for path in args.po:
            r = subprocess.run(["msgfmt", "-c", "-o", "/dev/null", str(path)], capture_output=True, text=True)
            if r.returncode:
                msgfmt_errors.append({"po_file": str(path), "output": r.stderr.strip()})
    else:
        warnings.append({"warning": "msgfmt isn't installed, so the gettext compile check was skipped (optional)"})
    ok = not errors and not msgfmt_errors
    print(json.dumps({"ok": ok, "errors": errors, "msgfmt_errors": msgfmt_errors,
                      "forbidden_term_hits": forbidden, "warnings": warnings}, ensure_ascii=False, indent=2))
    if not ok:
        sys.exit(1)


def reference_key(entry):
    file, line = entry.occurrences[0] if entry.occurrences else ("", "0")
    return file, int(line) if line.isdigit() else 0


def cmd_export_review(args):
    decisions = latest_translations(args.run_dir)
    rows = []
    for path in args.po:
        root = project_root(path, args.root)
        layouts = layout_templates(root)
        po = load(path)
        count = plural_forms(po)
        for e in po:
            if e.obsolete or FUZZY not in e.flags:
                continue
            eid = entry_id(path, e)
            d = decisions.get(eid, {})
            group = group_of(e, layouts)
            why = list(d.get("flags") or [])
            if not is_ai_draft(e):
                why.insert(0, EARLIER_DRAFT_NOTE)
            row = {
                COL_ID: eid,
                COL_PAGE: d.get("page") or group_label(root, group),
                COL_WHERE: d.get("place_on_page") or d.get("role") or "",
                COL_EN: e.msgid + (PLURAL_SEPARATOR + e.msgid_plural if e.msgid_plural else ""),
                COL_ES: PLURAL_SEPARATOR.join(forms_of(e, count)),
                COL_WHY: "; ".join(why),
                COL_PRIORITY: d.get("priority") or (HIGH_STAKES_PRIORITY if d.get("high_stakes") else DEFAULT_PRIORITY),
            }
            # Page order: shared layout, each page top to bottom, then shared strings
            rows.append((row, (group != LAYOUT_GROUP, group == MULTI_GROUP, reference_key(e))))
    rows.sort(key=lambda r: r[1])
    out = Path(args.run_dir) / REVIEW_SHEET
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding=ENCODING, newline="") as f:
        f.write(CSV_BOM)
        writer = csv.DictWriter(f, fieldnames=REVIEW_COLUMNS)
        writer.writeheader()
        writer.writerows(row for row, _ in rows)
    print(json.dumps({"review_sheet": str(out), "rows": len(rows)}, ensure_ascii=False, indent=2))


def cmd_import_review(args):
    *po_paths, sheet = args.files
    if not po_paths:
        sys.exit("Give the .po files, then the review sheet.")
    with open(sheet, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    files = {p: load(p) for p in po_paths}
    index = {entry_id(p, e): (p, e) for p, po in files.items() for e in po if not e.obsolete}
    today = datetime.date.today().isoformat()
    approved, corrected, comments_only, refused, no_answer = [], [], [], [], 0
    records = []
    for row in rows:
        eid = (row.get(COL_ID) or "").strip()
        approve = (row.get(COL_APPROVE) or "").strip().lower() in APPROVE_WORDS
        change = (row.get(COL_CHANGE) or "").strip()
        comment = (row.get(COL_COMMENT) or "").strip()
        if eid not in index:
            if eid:
                refused.append({"id": eid, "reason": "not in these .po files"})
            continue
        path, e = index[eid]
        record = {"type": "review", "date": today, "id": eid, "msgid": e.msgid,
                  "reviewer": args.reviewer, "comment": comment or None}
        if change:
            sources = [e.msgid, e.msgid_plural] if e.msgid_plural else [e.msgid]
            parts = change.split(PLURAL_SEPARATOR.strip()) if e.msgid_plural else [change]
            forms = [restore_edges(sources[min(i, len(sources) - 1)], p) for i, p in enumerate(parts)]
            found = problems(e, forms, plural_forms(files[path]))
            if found:
                refused.append({"id": eid, "msgid": e.msgid, "correction": change, "reason": "; ".join(found)})
                continue
            if e.msgid_plural:
                e.msgstr_plural = dict(enumerate(forms))
            else:
                e.msgstr = forms[0]
            record.update(action="corrected", spanish=forms if e.msgid_plural else forms[0])
            corrected.append({"id": eid, "msgid": e.msgid, "spanish": record["spanish"], "comment": comment or None})
        elif approve and not any(forms_of(e, plural_forms(files[path]))):
            refused.append({"id": eid, "msgid": e.msgid, "reason": "approved, but there's no Spanish to approve yet"})
            continue
        elif approve:
            record["action"] = "approved"
            approved.append(eid)
        elif comment:
            # Stays fuzzy: the reviewer has a question or concern to settle first
            record["action"] = "comment"
            comments_only.append({"id": eid, "msgid": e.msgid, "comment": comment})
            records.append(record)
            continue
        else:
            no_answer += 1
            continue
        if FUZZY in e.flags:
            e.flags.remove(FUZZY)
        e.tcomment = "\n".join(without_ai_comment(e))
        records.append(record)
    for path, po in files.items():
        po.save(str(path))
    log_decisions(args.run_dir, records)
    print(json.dumps({"approved": len(approved), "corrected": corrected, "comments_only": comments_only,
                      "refused": refused, "rows_without_an_answer": no_answer}, ensure_ascii=False, indent=2))
    if refused:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("find", help="list Spanish .po files and their status")
    p.add_argument("project")
    p.add_argument("--root")
    p.set_defaults(func=cmd_find)

    p = sub.add_parser("scan", help="entries to work on, grouped by page")
    p.add_argument("po", nargs="+")
    p.add_argument("--include", choices=sorted(INCLUDE), default="untranslated")
    p.add_argument("--page", help="only entries referenced from files whose path contains this")
    p.add_argument("--msgid", help="only entries whose English contains this")
    p.add_argument("--root")
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("context", help="source lines around references")
    p.add_argument("project")
    p.add_argument("refs", nargs="+", metavar="FILE:LINE")
    p.add_argument("--around", type=int, default=CONTEXT_AROUND)
    p.set_defaults(func=cmd_context)

    p = sub.add_parser("apply", help="write translations as fuzzy AI drafts")
    p.add_argument("po")
    p.add_argument("translations")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--overwrite", action="store_true", help="also replace translations that aren't fuzzy")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("check", help="check translations")
    p.add_argument("po", nargs="+")
    p.add_argument("--run-dir", help="this run's folder, for the roles recorded by apply")
    p.add_argument("--glossary", help="glossary.json from load_glossary.py")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("export-review", help="write the reviewer's sheet")
    p.add_argument("po", nargs="+")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--root")
    p.set_defaults(func=cmd_export_review)

    p = sub.add_parser("import-review", help="apply a filled-in review sheet")
    p.add_argument("files", nargs="+", metavar="FILE", help=".po files, then the review sheet")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--reviewer", default="reviewer")
    p.set_defaults(func=cmd_import_review)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
