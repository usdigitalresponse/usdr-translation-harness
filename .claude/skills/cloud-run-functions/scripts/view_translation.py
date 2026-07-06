#!/usr/bin/env python3
"""Open the translation viewer with the latest translation JSON pre-loaded.

Optionally loads extraction JSON to enrich blocks with role/spatial metadata.
"""

import json
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
VIEWER_TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "translation-viewer.html"
TRANSLATION_OUTPUT_DIR = REPO_ROOT / "cloud-run" / "translate" / "fixtures" / "output"
EXTRACTION_OUTPUT_DIR = REPO_ROOT / "cloud-run" / "extract" / "fixtures" / "output"


def find_latest_json(directory, glob_pattern="*.json"):
    json_files = sorted(directory.glob(glob_pattern), key=lambda f: f.stat().st_mtime, reverse=True)
    if not json_files:
        return None
    return json_files[0]


def build_viewer_html(translation_path, extraction_path=None):
    template = VIEWER_TEMPLATE.read_text()
    translation_data = json.loads(translation_path.read_text())

    extraction_data = {}
    if extraction_path:
        extraction_data = json.loads(extraction_path.read_text())

    inject_script = f"""
<script>
  // Auto-loaded by view_translation.py
  const _translation = {json.dumps(translation_data)};
  const _extraction = {json.dumps(extraction_data)};

  window.addEventListener("DOMContentLoaded", () => {{
    render(_translation, _extraction);
    const label = document.getElementById("file-label");
    if (label) {{
      label.textContent = "Translation: {translation_path.name}" + ({'"  |  Extraction: " + "{extraction_path.name}"' if extraction_path else '""'});
    }}
  }});
</script>
"""
    return template.replace("</body>", inject_script + "</body>")


def main():
    translation_path = find_latest_json(TRANSLATION_OUTPUT_DIR)
    if not translation_path:
        print(f"No translation JSON files in {TRANSLATION_OUTPUT_DIR}")
        return

    extraction_path = find_latest_json(EXTRACTION_OUTPUT_DIR, "*_extraction.json")

    print(f"Translation: {translation_path.name}")
    if extraction_path:
        print(f"Extraction:  {extraction_path.name}")
    else:
        print("Extraction:  (none found, block metadata will be limited)")

    with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w") as f:
        f.write(build_viewer_html(translation_path, extraction_path))
        tmp_path = f.name

    subprocess.run(["open", tmp_path])
    print(f"Opened viewer: {tmp_path}")


if __name__ == "__main__":
    main()
