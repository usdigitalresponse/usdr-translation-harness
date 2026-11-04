#!/usr/bin/env python3
"""Compare the elements a translation must keep unchanged: URLs, email
addresses, phone numbers, dollar amounts, percentages and other numbers.

    python compare_elements.py source.txt translation.txt

Prints each kind of element found in the source, and anything missing from or
added in the translation. Some differences are expected: a translation may
spell out small numbers ("3" -> "tres") or write dates differently
("1/3/2028" -> "3 de enero de 2028"). Check each difference in context.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

# Order matters: each kind is removed before the next is matched (emails
# before URLs, so an email's domain isn't counted as a URL)
PATTERNS = {
    "emails": re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"),
    "urls": re.compile(r"\b(?:https?://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:gov|org|com|net|edu|us)(?:/\S*)?\b", re.I),
    "phone_numbers": re.compile(r"(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"),
    "dollar_amounts": re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?"),
    "percentages": re.compile(r"\b\d+(?:[.,]\d+)?\s?%"),
}
# Any other number, once the elements above are removed
NUMBER = re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")
TRAILING_PUNCTUATION = ".,;:)"


def normalize(kind, value):
    value = value.rstrip(TRAILING_PUNCTUATION)
    if kind in ("urls", "emails"):
        return value.lower()
    if kind == "phone_numbers":
        return re.sub(r"\D", "", value)[-10:]
    return re.sub(r"\s", "", value)


def extract(text):
    found = {}
    remaining = text
    for kind, pattern in PATTERNS.items():
        values = [normalize(kind, m) for m in pattern.findall(remaining)]
        found[kind] = Counter(values)
        remaining = pattern.sub(" ", remaining)
    found["other_numbers"] = Counter(n.rstrip(TRAILING_PUNCTUATION) for n in NUMBER.findall(remaining))
    return found


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    source = extract(Path(sys.argv[1]).read_text(encoding="utf-8"))
    translation = extract(Path(sys.argv[2]).read_text(encoding="utf-8"))
    report = {}
    for kind in source:
        missing = source[kind] - translation[kind]
        added = translation[kind] - source[kind]
        report[kind] = {
            "in_source": sorted(source[kind].elements()),
            "missing_from_translation": sorted(missing.elements()),
            "added_in_translation": sorted(added.elements()),
        }
    report["all_match"] = all(not r["missing_from_translation"] and not r["added_in_translation"]
                              for r in report.values() if isinstance(r, dict))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
