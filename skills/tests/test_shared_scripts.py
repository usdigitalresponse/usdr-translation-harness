"""Tests for the shared toolkit scripts in skills/_shared/."""

import csv

from check_forbidden import fold, term_pattern
from compare_elements import extract
from conftest import ELEMENTS_SCRIPTS, GLOSSARY_SCRIPTS

LOAD_GLOSSARY = GLOSSARY_SCRIPTS / "load_glossary.py"
CHECK_FORBIDDEN = GLOSSARY_SCRIPTS / "check_forbidden.py"
COMPARE = ELEMENTS_SCRIPTS / "compare_elements.py"


def test_fold_strips_accents_but_keeps_enie():
    assert fold("Aplicación AÑO") == "aplicacion año"


def test_term_pattern_matches_plurals_and_whole_words():
    pattern = term_pattern("plan autoasegurado")
    assert pattern.search(fold("los planes autoasegurados"))
    assert not term_pattern("ano").search(fold("el año"))
    assert not term_pattern("sol").search(fold("solicitud"))


def write_glossary_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Glossary title"])                  # a title row above the header
        w.writerow(["English Term", "Approved Spanish", "Forbidden Terms", "Definition/Context"])
        w.writerows(rows)
    return path


def test_load_glossary_reads_csv_under_a_title_row(tmp_path, run_tool):
    src = write_glossary_csv(tmp_path / "g.csv", [["application", "solicitud", "aplicación", "A request for benefits"],
                                                  ["", "", "", ""]])
    code, out = run_tool(LOAD_GLOSSARY, src, "ignored", "--out", tmp_path / "g.json")
    assert code == 0 and out["entries"] == 1 and out["entries_with_forbidden_terms"] == 1


def test_load_glossary_fails_loudly_when_empty(tmp_path, run_tool):
    src = write_glossary_csv(tmp_path / "g.csv", [])
    code, _ = run_tool(LOAD_GLOSSARY, src, "ignored", "--out", tmp_path / "g.json")
    assert code != 0


def test_check_forbidden_reports_each_hit(tmp_path, run_tool):
    src = write_glossary_csv(tmp_path / "g.csv", [["application", "solicitud", "aplicación, y/o", ""]])
    run_tool(LOAD_GLOSSARY, src, "ignored", "--out", tmp_path / "g.json")
    text = tmp_path / "t.txt"
    text.write_text("Envíe su APLICACION y/o documentos.", encoding="utf-8")
    code, out = run_tool(CHECK_FORBIDDEN, text, tmp_path / "g.json")
    assert code == 0
    assert sorted(h["found"] for h in out["hits"]) == ["APLICACION", "y/o"]


def test_compare_elements_finds_changed_numbers_and_urls(tmp_path, run_tool):
    src, out_file = tmp_path / "en.txt", tmp_path / "es.txt"
    src.write_text("Call 1-800-555-0100 or visit Benefits.gov/apply. Limit $4,000.", encoding="utf-8")
    out_file.write_text("Llame al 1-800-555-0100 o visite benefits.gov/apply. Límite $40,000.", encoding="utf-8")
    code, out = run_tool(COMPARE, src, out_file)
    assert code == 0 and not out["all_match"]
    assert out["dollar_amounts"]["missing_from_translation"] == ["$4,000"]
    assert not out["urls"]["missing_from_translation"]     # host case doesn't matter


def test_extract_keeps_emails_out_of_urls():
    found = extract("Write to help@agency.gov")
    assert list(found["emails"]) == ["help@agency.gov"] and not found["urls"]
