"""Shared fixtures for the translation-skill tests.

Run from the repo root: .venv/bin/python -m pytest skills/tests
(needs skills/requirements-dev.txt). Tests only touch temporary copies.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parents[1]
WEB_SKILL = SKILLS / "usdr-web-strings-translation"
SAMPLE = WEB_SKILL / "examples" / "sample-django"
SAMPLE_REVIEW = WEB_SKILL / "examples" / "sample-review"
PO_TOOL = WEB_SKILL / "scripts" / "po_tool.py"
GLOSSARY_SCRIPTS = SKILLS / "_shared" / "glossary" / "scripts"
ELEMENTS_SCRIPTS = SKILLS / "_shared" / "elements" / "scripts"

for path in (WEB_SKILL / "scripts", GLOSSARY_SCRIPTS, ELEMENTS_SCRIPTS):
    sys.path.insert(0, str(path))


@pytest.fixture
def project(tmp_path):
    """A fresh copy of the sample Django project."""
    dest = tmp_path / "sample-django"
    shutil.copytree(SAMPLE, dest)
    return dest


@pytest.fixture
def run_tool():
    """Run a script as the skill would, returning (exit code, parsed JSON or text)."""
    def run(script, *args):
        r = subprocess.run([sys.executable, str(script), *map(str, args)], capture_output=True, text=True)
        try:
            out = json.loads(r.stdout)
        except json.JSONDecodeError:
            out = r.stdout + r.stderr
        return r.returncode, out
    return run
