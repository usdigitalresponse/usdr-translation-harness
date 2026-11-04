#!/usr/bin/env python3
"""Rough readability numbers for English text: sentence lengths, long
sentences, and Flesch-Kincaid grade level. Standard library only.

    python readability.py content.txt
    cat content.txt | python readability.py

Numbers are evidence for a plain-language review, not a score: grade-level
formulas ignore jargon, undefined terms and structure.
"""

import json
import re
import sys

LONG_SENTENCE_WORDS = 20      # the rubric's guideline is 15-20 words
MAX_LONG_SENTENCES_SHOWN = 10
# Flesch-Kincaid grade = 0.39 * (words/sentence) + 11.8 * (syllables/word) - 15.59
FK_WORDS_PER_SENTENCE = 0.39
FK_SYLLABLES_PER_WORD = 11.8
FK_OFFSET = 15.59

# A sentence ends at . ! ? or a line break (headings and bullets have no period)
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)*")
VOWEL_GROUPS = re.compile(r"[aeiouy]+")


def syllables(word):
    """Approximate English syllable count (vowel groups, silent final e)."""
    w = word.lower().strip("'’-")
    if not w or w[0].isdigit():
        return 1
    count = len(VOWEL_GROUPS.findall(w))
    if w.endswith("e") and not w.endswith(("le", "ee")) and count > 1:
        count -= 1
    return max(count, 1)


def analyze(text):
    sentences = []
    for chunk in SENTENCE_SPLIT.split(text):
        chunk = chunk.strip(" \t-•*")
        words = WORD.findall(chunk)
        if words:
            sentences.append((chunk, words))
    if not sentences:
        return {"error": "No sentences found."}

    word_counts = [len(w) for _, w in sentences]
    all_words = [w for _, ws in sentences for w in ws]
    total_syllables = sum(syllables(w) for w in all_words)
    words_per_sentence = len(all_words) / len(sentences)
    grade = (FK_WORDS_PER_SENTENCE * words_per_sentence
             + FK_SYLLABLES_PER_WORD * total_syllables / len(all_words) - FK_OFFSET)
    long_ones = sorted(
        [(len(w), s) for s, w in sentences if len(w) > LONG_SENTENCE_WORDS], reverse=True)

    return {
        "sentences": len(sentences),
        "words": len(all_words),
        "average_words_per_sentence": round(words_per_sentence, 1),
        "longest_sentence_words": max(word_counts),
        f"sentences_over_{LONG_SENTENCE_WORDS}_words": len(long_ones),
        "flesch_kincaid_grade_approx": round(grade, 1),
        "longest_sentences": [
            {"words": n, "text": s} for n, s in long_ones[:MAX_LONG_SENTENCES_SHOWN]
        ],
        "note": ("Approximate. Line breaks count as sentence ends, so headings and bullets are separate items; "
                 "abbreviations like 'e.g.' or 'U.S.' may split a sentence in two."),
    }


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
            text = f.read()
    else:
        text = sys.stdin.read()
    print(json.dumps(analyze(text), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
