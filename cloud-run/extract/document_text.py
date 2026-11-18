"""Text of Google Docs and Word files, for the text passthrough (no model call).

Both formats read the same parts, so a document gives the same blocks either
way. Each paragraph becomes one block. Supported (read):
  - body paragraphs, in order
  - tables: row by row, each cell's paragraphs in order; a merged cell once;
    tables inside cells
  - line breaks within a paragraph (Shift+Enter): kept inside the paragraph's
    block, so lines like an address are translated together
  - Google Docs: every tab, in order (child tabs after their parent)
  - Google Docs smart chips, as their displayed text: people (name, or email),
    file/link chips (title), dates, dropdowns (the selected option)
  - Word: content controls (dropdowns, date pickers, plain text controls) as
    their displayed text, field results (e.g. an inserted date), hyperlink text
  - the document as it currently stands: pending suggestions (Google Docs) and
    tracked changes (Word) are ignored, so suggested insertions are left out
    and suggested deletions are kept
Not supported (not read): comments, headers, footers, footnotes, text boxes,
drawings, equations, images, the table of contents, Google Docs tab titles.
"""
import io
import logging

import docx
from docx.oxml.ns import qn

logger = logging.getLogger(__name__)

# ── Google Docs (Docs API documents.get response) ─────────────────────────

# documents.get parameters: every tab's content, and the document without
# pending suggestions. By default the API returns suggestions inline for an
# account that can edit, mixed into the text. Comments are omitted by default.
GDOC_GET_PARAMS = {"includeTabsContent": True, "suggestionsViewMode": "PREVIEW_WITHOUT_SUGGESTIONS"}
# Shift+Enter inside a paragraph
GDOC_SOFT_LINE_BREAK = "\u000b"
# Paragraph elements with no text to translate (footnote markers, page
# numbers, breaks, rules, equations, images)
GDOC_ELEMENTS_WITHOUT_TEXT = {
    "footnoteReference", "autoText", "pageBreak", "columnBreak", "horizontalRule", "equation",
    "inlineObjectElement",
}
# Position fields on every element, not content
GDOC_ELEMENT_POSITION_KEYS = {"startIndex", "endIndex"}


def _gdoc_chip_text(element):
    """Displayed text of a smart chip, or None if the element isn't one."""
    if "person" in element:
        props = element["person"].get("personProperties", {})
        return props.get("name") or props.get("email", "")
    if "richLink" in element:
        props = element["richLink"].get("richLinkProperties", {})
        return props.get("title") or props.get("uri", "")
    if "dateElement" in element:
        return element["dateElement"].get("dateElementProperties", {}).get("displayText", "")
    if "dropdown" in element:
        return element["dropdown"].get("dropdownProperties", {}).get("displayValue", "")
    return None


def _gdoc_paragraph_text(paragraph):
    parts = []
    for element in paragraph.get("elements", []):
        if "textRun" in element:
            parts.append(element["textRun"].get("content", ""))
            continue
        chip = _gdoc_chip_text(element)
        if chip is not None:
            parts.append(chip)
            continue
        kinds = set(element) - GDOC_ELEMENT_POSITION_KEYS
        if not kinds & GDOC_ELEMENTS_WITHOUT_TEXT:
            # A new kind of element: it may hold text we're not reading
            logger.warning("Google Doc paragraph element not read: %s", sorted(kinds))
    return "".join(parts).replace(GDOC_SOFT_LINE_BREAK, "\n")


def _gdoc_collect(content, out):
    for element in content:
        if "paragraph" in element:
            out.append(_gdoc_paragraph_text(element["paragraph"]))
        elif "table" in element:
            # Cells covered by a merge come back empty, so they add nothing
            for row in element["table"].get("tableRows", []):
                for cell in row.get("tableCells", []):
                    _gdoc_collect(cell.get("content", []), out)
        # sectionBreak: no text. tableOfContents: skipped, it repeats the headings.


def _gdoc_tabs_in_order(tabs):
    for tab in tabs:
        yield tab
        yield from _gdoc_tabs_in_order(tab.get("childTabs", []))


def gdoc_paragraphs(document):
    """Paragraphs of a Google Doc (each becomes a block), from a documents.get
    response fetched with GDOC_GET_PARAMS. Table cell paragraphs are separate
    paragraphs; a line break inside a paragraph stays inside it."""
    paragraphs = []
    for tab in _gdoc_tabs_in_order(document.get("tabs", [])):
        body = tab.get("documentTab", {}).get("body", {})
        _gdoc_collect(body.get("content", []), paragraphs)
    return clean_paragraphs(paragraphs)


# ── Word (.docx XML) ──────────────────────────────────────────────────────

MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
DOCX_PARAGRAPH = qn("w:p")
DOCX_TABLE = qn("w:tbl")
DOCX_ROW = qn("w:tr")
DOCX_CELL = qn("w:tc")
# Wrappers whose children are read as if they weren't there: content controls
# and custom XML, at block, row, cell or run level
DOCX_TRANSPARENT = {qn("w:sdt"), qn("w:sdtContent"), qn("w:customXml")}
# Text inside a paragraph
DOCX_TEXT = {qn("w:t"), qn("w:delText")}      # delText: a tracked deletion (kept, see module doc)
DOCX_LINE_BREAKS = {qn("w:br"), qn("w:cr")}
DOCX_TAB = qn("w:tab")
# Subtrees skipped inside a paragraph: tracked insertions and moved-to text
# (pending changes), text boxes, the duplicate fallback copy of a drawing, a
# content control's settings, field codes, and paragraph/run properties (which
# also contain a w:tab element: a tab stop, not text)
DOCX_SKIP = {
    qn("w:ins"), qn("w:moveTo"), qn("w:txbxContent"), MC_FALLBACK, qn("w:sdtPr"), qn("w:instrText"),
    qn("w:pPr"), qn("w:rPr"),
}


def _docx_paragraph_text(element, parts):
    for child in element:
        tag = child.tag
        if tag in DOCX_SKIP:
            continue
        if tag in DOCX_TEXT:
            parts.append(child.text or "")
        elif tag == DOCX_TAB:
            parts.append("\t")
        elif tag in DOCX_LINE_BREAKS:
            parts.append("\n")
        else:
            # Runs, hyperlinks, fields, smart tags, inline content controls,
            # tracked deletions (w:del) and moved-from text: read what's inside
            _docx_paragraph_text(child, parts)


def _docx_rows(table):
    for child in table:
        if child.tag == DOCX_ROW:
            yield child
        elif child.tag in DOCX_TRANSPARENT:
            yield from _docx_rows(child)


def _docx_cells(row):
    for child in row:
        if child.tag == DOCX_CELL:
            yield child
        elif child.tag in DOCX_TRANSPARENT:
            yield from _docx_cells(child)


def _docx_collect(container, out):
    for child in container:
        if child.tag == DOCX_PARAGRAPH:
            parts = []
            _docx_paragraph_text(child, parts)
            out.append("".join(parts))
        elif child.tag == DOCX_TABLE:
            # A merged cell is stored once; the cells it covers are stored
            # empty, so each merged cell's text is read once
            for row in _docx_rows(child):
                for cell in _docx_cells(row):
                    _docx_collect(cell, out)
        elif child.tag in DOCX_TRANSPARENT:
            _docx_collect(child, out)


def docx_paragraphs(raw_bytes):
    """Paragraphs of a .docx (each becomes a block). Table cell paragraphs are
    separate paragraphs; a line break inside a paragraph stays inside it."""
    paragraphs = []
    _docx_collect(docx.Document(io.BytesIO(raw_bytes)).element.body, paragraphs)
    return clean_paragraphs(paragraphs)


def clean_paragraphs(paragraphs):
    """Trim each line, drop blank lines, and drop empty paragraphs."""
    cleaned = []
    for paragraph in paragraphs:
        text = "\n".join(line.strip() for line in paragraph.split("\n") if line.strip())
        if text:
            cleaned.append(text)
    return cleaned
