#!/usr/bin/env python3
"""Check a Spanish translation against the glossary's forbidden terms.

    python check_forbidden.py translation.txt glossary.json
    cat translation.txt | python check_forbidden.py - glossary.json

glossary.json is the output of load_glossary.py. Prints each forbidden term
found, the glossary entry it belongs to (with that entry's approved term and
context), and where it appears. A hit isn't automatically wrong: a term can be
forbidden for one meaning and fine for another, so check each hit's context.
Matching ignores case and accents (but not ñ, so "ano" doesn't match "año"),
matches whole words, and lets each word match its plural (-s/-es), so "plan
autoasegurado" also finds "planes autoasegurados".
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ENGLISH_TERM = "english term"
APPROVED = "approved spanish"
FORBIDDEN = "forbidden terms"
CONTEXT = "definition/context"
# "permiso, baja o ausencia" / "a; b" / "a / b" -> separate terms. A slash
# splits only with spaces around it, so a forbidden "y/o" stays one term.
SPLIT_TERMS = re.compile(r"\s*(?:[,;]|\s/\s|\so\s|\su\s)\s*")
MIN_TERM_CHARS = 2
KEEP_MARKS = {"ñ", "Ñ"}
CONTEXT_CHARS = 60
PLURAL_SUFFIX = r"(?:es|s)?"


def fold_char(c):
    """One character, lowercased and without accents (except ñ)."""
    if c in KEEP_MARKS:
        return "ñ"
    base = unicodedata.normalize("NFD", c)[0]
    lower = base.lower()
    return lower if len(lower) == 1 else base


def fold(text):
    """Lowercase and strip accents, one character for one character, so match
    positions in the folded text line up with the original. Call on NFC text."""
    return "".join(fold_char(c) for c in text)


def term_pattern(term):
    """Whole-word pattern for a (folded) term, each word allowing a plural ending."""
    words = [re.escape(w) + PLURAL_SUFFIX for w in fold(unicodedata.normalize("NFC", term)).split()]
    return re.compile(r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)")


def field(entry, name):
    return next((v for k, v in entry.items() if k.lower() == name), "")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    raw = sys.stdin.read() if sys.argv[1] == "-" else Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
    entries = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    # Precomposed accents (é, not e + ´), so positions in `folded` match `text`
    text = unicodedata.normalize("NFC", raw)
    folded = fold(text)

    # One hit per place in the text, listing every glossary entry that forbids it
    hits = {}
    for entry in entries:
        for term in SPLIT_TERMS.split(field(entry, FORBIDDEN)):
            term = term.strip(" .\"'“”")
            if len(term) < MIN_TERM_CHARS:
                continue
            for m in term_pattern(term).finditer(folded):
                hit = hits.setdefault((m.start(), m.end()), {
                    "found": text[m.start():m.end()],
                    "in_context": text[max(0, m.start() - CONTEXT_CHARS):m.end() + CONTEXT_CHARS].replace("\n", " "),
                    "forbidden_by": [],
                })
                hit["forbidden_by"].append({
                    "glossary_entry": field(entry, ENGLISH_TERM),
                    "forbidden_term": term,
                    "approved_spanish": field(entry, APPROVED),
                    "entry_context": field(entry, CONTEXT),
                })

    ordered = [hits[k] for k in sorted(hits)]
    print(json.dumps({"forbidden_term_hits": len(ordered), "hits": ordered}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
