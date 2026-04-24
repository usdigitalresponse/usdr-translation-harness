import csv
import io
import os
import re

import requests

PROMPTS_DOC_ID = os.getenv("PROMPTS_DOC_ID", "1Wk5mmXZWE45pFBG8cy_tv48-rWX2Lz1xN7U8nzsQrbw")
GLOSSARY_SHEET_ID = os.getenv("GLOSSARY_SHEET_ID", "1AxYldzJ7TH6ihg3TLZRdP19KbGz1QyKzkcZLTwpnh5Q")
GLOSSARY_SHEET_GID = os.getenv("GLOSSARY_SHEET_GID", "430246301")

# Ordered list so we can detect section boundaries by finding the next one
RUBRIC_SECTIONS = [
    ("accuracy_and_relevance",    r"Accuracy\s*&\s*Relevance:"),
    ("clarity_and_accessibility", r"Clarity,?\s+Simplicity\s*&\s*Accessibility:"),
    ("cultural_sensitivity",      r"Cultural\s+Sensitivity:"),
    ("active_voice_and_tone",     r"Active\s+Voice\s*&\s*Tone:"),
    ("consistency_and_style",     r"Consistency\s*&\s*Style:"),
]

SECTION_KEYS = {key for key, _ in RUBRIC_SECTIONS}


def _fetch_text(url: str) -> str:
    response = requests.get(url, timeout=15)
    response.raise_for_status()
    return response.text


def fetch_rubric(section: str | None = None) -> str:
    text = _fetch_text(
        f"https://docs.google.com/document/d/{PROMPTS_DOC_ID}/export?format=txt"
    )

    rubric_start = text.find("Spanish Translation Evaluation Rubric")
    if rubric_start == -1:
        return "Rubric section not found in document."

    # Bounded by the next major section
    rubric_end = text.find("Plain English Prompt", rubric_start)
    block = text[rubric_start:rubric_end].strip() if rubric_end != -1 else text[rubric_start:].strip()

    if section is None or section == "full":
        return block

    # Find positions of all section headers within the block
    positions = []
    for key, pattern in RUBRIC_SECTIONS:
        match = re.search(pattern, block)
        if match:
            positions.append((match.start(), key))
    positions.sort()

    target_start = next((pos for pos, key in positions if key == section), None)
    if target_start is None:
        return f"Section '{section}' not found in rubric."

    target_idx = next(i for i, (_, key) in enumerate(positions) if key == section)
    target_end = positions[target_idx + 1][0] if target_idx + 1 < len(positions) else None

    excerpt = block[target_start:target_end].strip() if target_end else block[target_start:].strip()

    # Stop before the Priority Levels appendix if it falls inside
    priority_pos = excerpt.find("Priority Levels for Issues")
    if priority_pos != -1:
        excerpt = excerpt[:priority_pos].strip()

    return excerpt


def fetch_glossary() -> str:
    csv_text = _fetch_text(
        f"https://docs.google.com/spreadsheets/d/{GLOSSARY_SHEET_ID}"
        f"/export?format=csv&gid={GLOSSARY_SHEET_GID}"
    )

    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)

    if len(rows) < 2:
        return "Glossary is empty."

    entries = []
    for row in rows[1:]:  # skip header
        if not row or not row[0].strip():
            continue

        english_term = row[0].strip()
        # Most current English definition: post-research > AZ-approved > original
        english_def = (
            row[4].strip() if len(row) > 4 and row[4].strip()
            else row[3].strip() if len(row) > 3 and row[3].strip()
            else row[1].strip() if len(row) > 1 else ""
        )
        spanish_term = row[6].strip() if len(row) > 6 else ""
        spanish_def = row[7].strip() if len(row) > 7 else ""

        lines = [english_term]
        if spanish_term:
            lines.append(f"  Spanish: {spanish_term}")
        if english_def:
            lines.append(f"  Definition: {english_def}")
        if spanish_def:
            lines.append(f"  Spanish definition: {spanish_def}")

        entries.append("\n".join(lines))

    return f"SNAP Glossary ({len(entries)} terms)\n\n" + "\n\n".join(entries)
