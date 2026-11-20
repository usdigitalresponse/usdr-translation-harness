"""Pilot size limits ("traffic light"): green = normal, yellow = translated
with a heads-up, red = not processed. Pages are checked before any model call,
translatable blocks after extraction; a file takes the worse of the two.
Limits come from the Settings tab (loaders.load_settings)."""
import io
import math

import pdfplumber

GREEN, YELLOW, RED = "green", "yellow", "red"
_SEVERITY = {GREEN: 0, YELLOW: 1, RED: 2}


def category(value, green_max, yellow_max):
    """green up to green_max, yellow up to yellow_max, red beyond."""
    if value <= green_max:
        return GREEN
    return YELLOW if value <= yellow_max else RED


def worse(*categories):
    return max(categories, key=_SEVERITY.__getitem__)


def page_category(pages, settings):
    return category(pages, settings["green_max_pages"], settings["yellow_max_pages"])


def block_category(blocks, settings):
    return category(blocks, settings["green_max_blocks"], settings["yellow_max_blocks"])


def pdf_page_count(pdf_bytes):
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        return len(pdf.pages)


def estimated_pages(paragraphs, words_per_page):
    """A Word file's pages, estimated from its word count (a .docx carries no
    reliable page count): at least 1."""
    words = sum(len(p.split()) for p in paragraphs)
    return max(1, math.ceil(words / words_per_page))


def translatable_block_count(parsed):
    return sum(1 for b in parsed.get("blocks", []) if b.get("translate", True))


def size_info(category_, pages, pages_estimated, blocks):
    """What's recorded with the extraction (its "size" field) and passed on to Translate."""
    return {"category": category_, "pages": pages, "pagesEstimated": pages_estimated, "blocks": blocks}


# ── Messages (Chat). Wording to confirm with PM + designer before Maryland. ──

def _pages_text(pages, pages_estimated):
    return f"{'about ' if pages_estimated else ''}{pages} page{'s' if pages != 1 else ''}"


def red_reason(pages_red, pages, pages_estimated, settings):
    """Why a red file wasn't processed, in plain language: pages first, then blocks."""
    if pages_red:
        return (f"it's {_pages_text(pages, pages_estimated)}, and the pilot supports up to "
                f"{settings['yellow_max_pages']}. Split it into shorter files and submit them separately.")
    return ("it has too many separate pieces of text for the pilot (for example, a large table, where each "
            "cell counts separately). Split it into shorter files, or simplify large tables, and submit again.")


def yellow_reason(pages_yellow, pages, pages_estimated):
    """Why a yellow file is larger than the pilot is designed for."""
    if pages_yellow:
        return _pages_text(pages, pages_estimated)
    return "a lot of separate pieces of text, for example a large table"
