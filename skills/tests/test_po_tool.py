"""Tests for usdr-web-strings-translation/scripts/po_tool.py."""

import csv
import json
import shutil

import polib
import pytest

import po_tool
from conftest import PO_TOOL, SAMPLE_REVIEW

LOCALE = "locale/es/LC_MESSAGES"


def po_paths(project):
    return project / LOCALE / "django.po", project / LOCALE / "djangojs.po"


def entry(po_path, msgid, msgctxt=None):
    po = polib.pofile(str(po_path))
    return next(e for e in po if e.msgid == msgid and e.msgctxt == msgctxt and not e.obsolete)


def eid(po_path, msgid, msgctxt=None):
    return po_tool.entry_id(po_path, entry(po_path, msgid, msgctxt))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def apply_sample_draft(project, run_tool, run_dir):
    django, js = po_paths(project)
    for po, name in ((django, "ai-draft-django.json"), (js, "ai-draft-djangojs.json")):
        code, out = run_tool(PO_TOOL, "apply", po, SAMPLE_REVIEW / name, "--run-dir", run_dir)
        assert code == 0, out


# ── Placeholder, tag and whitespace rules ─────────────────────────────────

def test_placeholders_cover_printf_and_braces():
    assert po_tool.placeholders("Hi %(name)s, %s and {count} {}") == ["%(name)s", "%s", "{count}", "{}"]


def test_html_tags_include_placeholder_attributes():
    assert po_tool.html_tags('<a href="%(url)s">x</a>') == ["/a", "a %(url)s"]


def test_problems_catch_a_renamed_placeholder():
    e = polib.POEntry(msgid="Welcome, %(first_name)s")
    assert "placeholders differ" in po_tool.problems(e, ["Bienvenida, %(nombre)s"], 2)[0]


def test_problems_catch_lost_trailing_space_and_line_breaks():
    e = polib.POEntry(msgid="Total: ")
    assert po_tool.problems(e, ["Total:"], 2)
    e = polib.POEntry(msgid="Hello,\n\nThanks.\n")
    assert po_tool.problems(e, ["Hola: Gracias."], 2)
    assert not po_tool.problems(e, ["Hola:\n\nGracias.\n"], 2)


def test_problems_catch_broken_html():
    e = polib.POEntry(msgid="Renew by <strong>%(date)s</strong>.")
    assert any("HTML" in p for p in po_tool.problems(e, ["Renueve el %(date)s."], 2))


def test_plural_needs_every_form_but_may_drop_the_number():
    e = polib.POEntry(msgid="%s file", msgid_plural="%s files")
    assert any("plural forms" in p for p in po_tool.problems(e, ["%s archivo"], 2))
    assert not po_tool.problems(e, ["un archivo", "%s archivos"], 2)


def test_restore_edges_puts_back_the_english_spacing():
    assert po_tool.restore_edges("Saved. ", "Guardado.") == "Guardado. "


# ── find / scan ───────────────────────────────────────────────────────────

def test_find_counts_by_page(project, run_tool):
    code, out = run_tool(PO_TOOL, "find", project)
    assert code == 0
    django = next(f for f in out["spanish_po_files"] if f["po_file"].endswith("django.po"))
    assert django["totals"] == {"untranslated": 44, "translated": 2, "fuzzy": 1}
    assert django["obsolete_entries"] == 1
    assert po_tool.LAYOUT_GROUP in django["by_group"]


def test_scan_puts_shared_layout_first_and_keeps_contexts_apart(project, run_tool):
    django, _ = po_paths(project)
    code, out = run_tool(PO_TOOL, "scan", django)
    assert code == 0
    assert out["groups"][0]["group"] == po_tool.LAYOUT_GROUP
    applies = [e for g in out["groups"] for e in g["entries"] if e["msgid"] == "Apply"]
    assert sorted(str(e["msgctxt"]) for e in applies) == ["None", "filter"]
    submit = next(e for e in applies if e["msgctxt"] is None)
    assert submit["developer_comment"].startswith("Translators:")
    assert submit["role_guess"] == "button"


def test_scan_reports_whitespace_and_plurals(project, run_tool):
    django, _ = po_paths(project)
    _, out = run_tool(PO_TOOL, "scan", django)
    entries = {e["msgid"]: e for g in out["groups"] for e in g["entries"]}
    assert entries["Total: "]["trailing_space"] == " "
    assert entries["You have %(count)s application in progress."]["plural_forms_needed"] == 2


def test_scan_skips_existing_translations_unless_asked(project, run_tool):
    django, _ = po_paths(project)
    _, default = run_tool(PO_TOOL, "scan", django)
    _, with_fuzzy = run_tool(PO_TOOL, "scan", django, "--include", "fuzzy")
    assert default["total"] == 44 and with_fuzzy["total"] == 45


# ── apply ─────────────────────────────────────────────────────────────────

def test_apply_marks_fuzzy_and_logs_decisions(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    run_dir = tmp_path / "run"
    items = [{"id": eid(django, "Save"), "msgstr": "Guardar", "role": "button", "reasoning": "Infinitive"}]
    code, out = run_tool(PO_TOOL, "apply", django, write_json(tmp_path / "t.json", items), "--run-dir", run_dir)
    assert code == 0 and out["applied"] == 1
    e = entry(django, "Save")
    assert e.msgstr == "Guardar" and "fuzzy" in e.flags
    assert e.tcomment.startswith(po_tool.AI_DRAFT_PREFIX)
    assert e.comment.startswith("Translators:")     # developer comment untouched
    log = [json.loads(l) for l in (run_dir / "decisions.jsonl").read_text().splitlines()]
    assert log[0]["reasoning"] == "Infinitive" and log[0]["msgid"] == "Save"


def test_apply_refuses_broken_translations_and_leaves_them_out(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    items = [
        {"id": eid(django, "Welcome, %(first_name)s"), "msgstr": "Bienvenida, %(nombre)s"},
        {"id": eid(django, "You have %(count)s application in progress."), "msgstr_plural": ["Tiene %(count)s solicitud."]},
        {"id": eid(django, "Total: "), "msgstr": "Total:"},
        {"id": eid(django, "Back"), "msgstr": "Volver"},
    ]
    code, out = run_tool(PO_TOOL, "apply", django, write_json(tmp_path / "t.json", items), "--run-dir", tmp_path / "run")
    assert code == 1
    assert out["applied"] == 1 and len(out["refused"]) == 3
    assert entry(django, "Welcome, %(first_name)s").msgstr == ""


def test_apply_never_overwrites_a_finished_translation_by_default(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    items = write_json(tmp_path / "t.json", [{"id": eid(django, "Home"), "msgstr": "Página principal"}])
    code, out = run_tool(PO_TOOL, "apply", django, items, "--run-dir", tmp_path / "run")
    assert code == 1 and entry(django, "Home").msgstr == "Inicio"
    code, _ = run_tool(PO_TOOL, "apply", django, items, "--run-dir", tmp_path / "run", "--overwrite")
    assert code == 0 and entry(django, "Home").msgstr == "Página principal"


def test_high_stakes_stays_fuzzy_even_if_asked_not_to(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    items = [{"id": eid(django, "Your application was denied."), "msgstr": "Su solicitud fue denegada.",
              "fuzzy": False, "high_stakes": True},
             {"id": eid(django, "Privacy"), "msgstr": "Privacidad", "fuzzy": False}]
    run_tool(PO_TOOL, "apply", django, write_json(tmp_path / "t.json", items), "--run-dir", tmp_path / "run")
    assert "fuzzy" in entry(django, "Your application was denied.").flags
    assert "fuzzy" not in entry(django, "Privacy").flags


def test_apply_keeps_the_file_compilable(project, run_tool, tmp_path):
    if not shutil.which("msgfmt"):
        pytest.skip("msgfmt not installed")
    apply_sample_draft(project, run_tool, tmp_path / "run")
    code, out = run_tool(PO_TOOL, "check", *po_paths(project), "--run-dir", tmp_path / "run")
    assert code == 0 and out["ok"], out


# ── check ─────────────────────────────────────────────────────────────────

def test_check_flags_long_buttons_and_inconsistency(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    run_dir = tmp_path / "run"
    items = [{"id": eid(django, "Apply"), "msgstr": "Enviar solicitud", "role": "button"},
             {"id": eid(django, "Clear"), "msgstr": "Borrar", "role": "link"},
             {"id": eid(django, "Back"), "msgstr": "Borrar", "role": "link button"}]
    run_tool(PO_TOOL, "apply", django, write_json(tmp_path / "t.json", items), "--run-dir", run_dir)
    _, out = run_tool(PO_TOOL, "check", django, "--run-dir", run_dir)
    warnings = [w["warning"] for w in out["warnings"]]
    assert any("length for a button" in w for w in warnings)
    assert any("different English strings share" in w for w in warnings)


def test_check_finds_forbidden_glossary_terms(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    items = [{"id": eid(django, "Your application was denied."), "msgstr": "Su aplicación fue denegada."}]
    run_tool(PO_TOOL, "apply", django, write_json(tmp_path / "t.json", items), "--run-dir", tmp_path / "run")
    glossary = write_json(tmp_path / "g.json", [{"English Term": "application", "Approved Spanish": "solicitud",
                                                  "Forbidden Terms": "aplicación"}])
    _, out = run_tool(PO_TOOL, "check", django, "--glossary", glossary)
    assert out["forbidden_term_hits"][0]["forbidden_term"] == "aplicación"


# ── export-review / import-review ─────────────────────────────────────────

def read_sheet(path):
    raw = path.read_bytes()
    assert raw.startswith(po_tool.CSV_BOM.encode("utf-8"))      # Excel-friendly
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def test_export_review_lists_drafts_in_page_order(project, run_tool, tmp_path):
    run_dir = tmp_path / "run"
    apply_sample_draft(project, run_tool, run_dir)
    code, out = run_tool(PO_TOOL, "export-review", *po_paths(project), "--run-dir", run_dir)
    assert code == 0 and out["rows"] == 48
    rows = read_sheet(run_dir / "review-sheet.csv")
    assert list(rows[0]) == po_tool.REVIEW_COLUMNS
    assert rows[0]["Page"] == "Every page (header and footer)"
    denied = next(r for r in rows if r["English"] == "Your application was denied.")
    assert denied["Priority"] == "Critical"
    plural = next(r for r in rows if r["English"].startswith("You have %(count)s"))
    assert po_tool.PLURAL_SEPARATOR in plural["Spanish (AI draft)"]


def test_import_review_applies_the_sample_review(project, run_tool, tmp_path):
    run_dir = tmp_path / "run"
    apply_sample_draft(project, run_tool, run_dir)
    django, js = po_paths(project)
    code, out = run_tool(PO_TOOL, "import-review", django, js, SAMPLE_REVIEW / "review-sheet-filled.csv",
                         "--run-dir", run_dir, "--reviewer", "Test")
    assert code == 1                                   # one correction is refused
    assert out["refused"][0]["msgid"] == "Welcome, %(first_name)s"
    assert out["approved"] == 39 and len(out["corrected"]) == 4 and len(out["comments_only"]) == 2

    saved = entry(django, "Your application was saved. ")
    assert saved.msgstr == "Guardamos su solicitud. "            # trailing space restored
    assert "fuzzy" not in saved.flags and po_tool.AI_DRAFT_PREFIX not in saved.tcomment
    assert entry(django, "Apply").msgstr == "Enviar"
    assert entry(django, "Apply", "filter").msgstr == "Aplicar"  # other "Apply" untouched
    plural = entry(django, "You have %(count)s application in progress.")
    assert plural.msgstr_plural[1] == "Tiene %(count)s solicitudes pendientes."
    for still_fuzzy in ("Welcome, %(first_name)s", "Example State Family Services",
                        'You can appeal this decision within 30 days. <a href="%(url)s">Learn how to appeal</a>.'):
        assert "fuzzy" in entry(django, still_fuzzy).flags
    log = [json.loads(l) for l in (run_dir / "decisions.jsonl").read_text().splitlines()]
    assert {r.get("action") for r in log if r["type"] == "review"} == {"approved", "corrected", "comment"}


def test_import_review_wont_approve_an_empty_translation(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    sheet = tmp_path / "sheet.csv"
    with open(sheet, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=po_tool.REVIEW_COLUMNS)
        w.writeheader()
        w.writerow({"ID": eid(django, "Back"), po_tool.COL_APPROVE: "yes"})
    code, out = run_tool(PO_TOOL, "import-review", django, sheet, "--run-dir", tmp_path / "run")
    assert code == 1 and "no Spanish" in out["refused"][0]["reason"]


def test_decision_log_uses_project_relative_paths(project, run_tool, tmp_path):
    django, _ = po_paths(project)
    items = write_json(tmp_path / "t.json", [{"id": eid(django, "Save"), "msgstr": "Guardar"}])
    run_tool(PO_TOOL, "apply", django.resolve(), items, "--run-dir", tmp_path / "run")
    record = json.loads((tmp_path / "run" / "decisions.jsonl").read_text().splitlines()[0])
    assert record["po_file"] == "locale/es/LC_MESSAGES/django.po"
