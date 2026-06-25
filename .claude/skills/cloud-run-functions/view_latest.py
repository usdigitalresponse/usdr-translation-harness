#!/usr/bin/env python3
"""Open the extraction viewer with the latest JSON output and source PDF pre-loaded."""

import base64
import json
import os
import subprocess
import tempfile
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
VIEWER_TEMPLATE = Path(__file__).resolve().parent / "viewer.html"
OUTPUT_DIR = REPO_ROOT / "cloud-run" / "extract" / "fixtures" / "output"

load_dotenv(REPO_ROOT / ".env")


def find_latest_extraction_json():
    json_files = sorted(OUTPUT_DIR.glob("*_extraction.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not json_files:
        raise FileNotFoundError(f"No extraction JSON files in {OUTPUT_DIR}")
    return json_files[0]


def get_pdf_path():
    local_path = os.environ.get("LOCAL_PDF_PATH")
    if not local_path:
        raise ValueError("LOCAL_PDF_PATH not set in .env")
    path = Path(local_path)
    if not path.is_absolute():
        path = REPO_ROOT / path
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {path}")
    return path


def build_viewer_html(json_path, pdf_path):
    template = VIEWER_TEMPLATE.read_text()
    extraction_data = json.loads(json_path.read_text())
    pdf_b64 = base64.b64encode(pdf_path.read_bytes()).decode()

    inject_script = f"""
<script>
  // Auto-loaded by view_latest.py
  const _autoJson = {json.dumps(extraction_data)};
  const _autoPdfB64 = "{pdf_b64}";

  window.addEventListener("DOMContentLoaded", () => {{
    // Load PDF
    const pdfPanel = document.getElementById("pdf-panel");
    pdfPanel.innerHTML = '<embed src="data:application/pdf;base64,' + _autoPdfB64 + '#navpanes=0" type="application/pdf">';

    // Load JSON
    renderExtraction(_autoJson);

    // Update toolbar to show what's loaded
    const toolbar = document.querySelector(".toolbar");
    const info = document.createElement("span");
    info.style.cssText = "font-size:12px; color:#888; margin-left:auto;";
    info.textContent = "JSON: {json_path.name} | PDF: {pdf_path.name}";
    toolbar.appendChild(info);
  }});
</script>
"""
    return template.replace("</body>", inject_script + "</body>")


def main():
    json_path = find_latest_extraction_json()
    pdf_path = get_pdf_path()

    print(f"JSON: {json_path.name}")
    print(f"PDF:  {pdf_path.name}")

    with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w") as f:
        f.write(build_viewer_html(json_path, pdf_path))
        tmp_path = f.name

    subprocess.run(["open", tmp_path])
    print(f"Opened viewer: {tmp_path}")


if __name__ == "__main__":
    main()
