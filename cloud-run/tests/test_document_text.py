"""What the text passthrough reads from Google Docs and Word files
(extract/document_text.py), and what it leaves out. Word cases use real .docx
files (python-docx, plus raw XML for structures it can't author: tracked
changes, content controls, fields, text boxes). Google Docs cases use
documents.get responses shaped like the Docs API v1 schema."""
import io
import logging
from unittest.mock import patch, MagicMock

import docx
import pytest
from docx.oxml import parse_xml

from document_text import gdoc_paragraphs, docx_paragraphs, GDOC_GET_PARAMS
from extract.main import fetch_paragraphs_from_drive, text_to_extraction_json, MIME_GOOGLE_DOCS

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:v="urn:schemas-microsoft-com:vml" '
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
      'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"')


# ── Word ──────────────────────────────────────────────────────────────────

def docx_bytes(build=None, body_xml=()):
    """A real .docx: built with python-docx, plus raw <w:body> children (in order, after)."""
    document = docx.Document()
    if build:
        build(document)
    body = document.element.body
    for xml in body_xml:
        # Declare the namespaces on the element's opening tag
        body.insert(len(body) - 1, parse_xml(xml.replace(">", f" {NS}>", 1)))
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def word_lines(build=None, *body_xml):
    """The .docx's paragraphs (blocks)."""
    return docx_paragraphs(docx_bytes(build, body_xml))


def p(*runs_xml):
    return "<w:p>" + "".join(runs_xml) + "</w:p>"


def r(text):
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


class TestWordBodyAndTables:
    def test_paragraphs_and_tables_in_document_order(self):
        def build(d):
            d.add_paragraph("Intro paragraph.")
            t = d.add_table(rows=2, cols=2)
            t.cell(0, 0).text, t.cell(0, 1).text = "Program", "Who qualifies"
            t.cell(1, 0).text, t.cell(1, 1).text = "Waiver A", "Adults over 65"
            d.add_paragraph("Closing paragraph.")
        assert word_lines(build) == [
            "Intro paragraph.", "Program", "Who qualifies", "Waiver A", "Adults over 65", "Closing paragraph.",
        ]

    def test_merged_cells_read_once(self):
        def build(d):
            t = d.add_table(rows=3, cols=2)
            t.cell(0, 0).merge(t.cell(0, 1)).text = "Header across both columns"
            t.cell(1, 0).merge(t.cell(2, 0)).text = "Spans two rows"
            t.cell(1, 1).text, t.cell(2, 1).text = "Row 1 detail", "Row 2 detail"
        assert word_lines(build) == ["Header across both columns", "Spans two rows", "Row 1 detail", "Row 2 detail"]

    def test_nested_table_and_multi_paragraph_cell(self):
        def build(d):
            cell = d.add_table(rows=1, cols=1).cell(0, 0)
            cell.text = "First line in cell"
            cell.add_paragraph("Second line in cell")
            cell.add_table(rows=1, cols=1).cell(0, 0).text = "Nested cell"
        assert word_lines(build) == ["First line in cell", "Second line in cell", "Nested cell"]

    def test_empty_paragraphs_and_cells_skipped(self):
        def build(d):
            d.add_paragraph("")
            d.add_table(rows=1, cols=2).cell(0, 0).text = "Only filled cell"
        assert word_lines(build) == ["Only filled cell"]

    def test_line_break_stays_in_the_paragraph_and_tab_kept(self):
        assert word_lines(None, p(r("Line 1"), "<w:r><w:br/></w:r>", r("Line 2"), "<w:r><w:tab/></w:r>", r("after tab"))) == [
            "Line 1\nLine 2\tafter tab"]

    def test_paragraph_tab_stops_are_not_text(self):
        assert word_lines(None, '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'
                          + r("No tab here") + "</w:p>") == ["No tab here"]


class TestWordFormsLinksAndFields:
    def test_inline_content_control_shows_its_value(self):
        sdt = ('<w:sdt><w:sdtPr><w:dropDownList><w:listItem w:displayText="Other" w:value="o"/></w:dropDownList></w:sdtPr>'
               '<w:sdtContent>' + r("Selected option") + '</w:sdtContent></w:sdt>')
        assert word_lines(None, p(r("Choice: "), sdt)) == ["Choice: Selected option"]

    def test_block_content_control_paragraphs_read(self):
        block = '<w:sdt><w:sdtPr/><w:sdtContent>' + p(r("Inside a content control")) + '</w:sdtContent></w:sdt>'
        assert word_lines(None, block) == ["Inside a content control"]

    def test_content_controls_around_table_rows_and_cells(self):
        tbl = ('<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid>'
               '<w:sdt><w:sdtContent><w:tr><w:tc>' + p(r("Row in a control")) + '</w:tc></w:tr></w:sdtContent></w:sdt>'
               '<w:tr><w:sdt><w:sdtContent><w:tc>' + p(r("Cell in a control")) + '</w:tc></w:sdtContent></w:sdt></w:tr>'
               '</w:tbl>')
        assert word_lines(None, tbl) == ["Row in a control", "Cell in a control"]

    def test_hyperlink_simple_field_and_smart_tag_text(self):
        assert word_lines(
            None,
            p('<w:hyperlink r:id="rId99">' + r("link text") + '</w:hyperlink>'),
            p('<w:fldSimple w:instr="DATE">' + r("Nov 18, 2026") + '</w:fldSimple>'),
            p('<w:smartTag w:uri="u" w:element="e">' + r("smart tag text") + '</w:smartTag>'),
        ) == ["link text", "Nov 18, 2026", "smart tag text"]

    def test_complex_field_shows_result_not_code(self):
        field = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE \\@ "MMMM d" </w:instrText></w:r>'
                 '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + r("November 18")
                 + '<w:r><w:fldChar w:fldCharType="end"/></w:r>')
        assert word_lines(None, p(r("Due "), field)) == ["Due November 18"]


class TestWordTrackedChanges:
    """Read as the document stands without pending changes: insertions out, deletions kept."""

    def test_insertion_left_out_deletion_kept(self):
        ins = '<w:ins w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z">' + r("inserted ") + '</w:ins>'
        dele = ('<w:del w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z">'
                '<w:r><w:delText xml:space="preserve">deleted </w:delText></w:r></w:del>')
        assert word_lines(None, p(r("Keep "), ins, dele, r("end"))) == ["Keep deleted end"]

    def test_moved_text_read_at_original_place_only(self):
        assert word_lines(
            None,
            p('<w:moveFrom w:id="3" w:author="a" w:date="2026-01-01T00:00:00Z">' + r("moved sentence") + '</w:moveFrom>'),
            p(r("Other text "), '<w:moveTo w:id="4" w:author="a" w:date="2026-01-01T00:00:00Z">' + r("moved sentence") + '</w:moveTo>'),
        ) == ["moved sentence", "Other text"]


class TestWordNotRead:
    def test_text_boxes_not_read_and_not_duplicated(self):
        vml = ('<w:r><w:pict><v:shape><v:textbox><w:txbxContent>' + p(r("VML text box"))
               + '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>')
        drawingml = ('<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>'
                     + p(r("DrawingML text box")) + '</w:txbxContent></wps:txbx></w:drawing></mc:Choice>'
                     '<mc:Fallback><w:pict><v:textbox><w:txbxContent>' + p(r("Fallback copy"))
                     + '</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent>')
        assert word_lines(None, p(r("Before box. "), vml, r("After box.")), p(drawingml, r("Next."))) == [
            "Before box. After box.", "Next."]

    def test_headers_footers_footnotes_and_comments_not_read(self):
        def build(d):
            d.sections[0].header.paragraphs[0].text = "HEADER text"
            d.sections[0].footer.paragraphs[0].text = "FOOTER text"
            d.add_paragraph("Body text.")
        body = p(r("Footnote here"), '<w:r><w:footnoteReference w:id="1"/></w:r>',
                 '<w:commentRangeStart w:id="0"/>', r(" and comment"), '<w:commentRangeEnd w:id="0"/>',
                 '<w:r><w:commentReference w:id="0"/></w:r>')
        assert word_lines(build, body) == ["Body text.", "Footnote here and comment"]


# ── Google Docs ───────────────────────────────────────────────────────────

def text_run(text):
    return {"startIndex": 1, "endIndex": 2, "textRun": {"content": text}}


def para(*elements):
    return {"paragraph": {"elements": list(elements)}}


def table(*rows):
    return {"table": {"tableRows": [{"tableCells": [{"content": cell} for cell in row]} for row in rows]}}


def gdoc(*content, tabs=None):
    """A documents.get response (includeTabsContent=true): one tab, or the given tabs."""
    if tabs is None:
        tabs = [tab("Tab 1", list(content))]
    return {"documentId": "doc", "tabs": tabs}


def tab(title, content, children=(), **document_tab_extra):
    return {"tabProperties": {"title": title}, "childTabs": list(children),
            "documentTab": {"body": {"content": content}, **document_tab_extra}}


def gdoc_lines(document):
    """The Google Doc's paragraphs (blocks)."""
    return gdoc_paragraphs(document)


class TestGoogleDocsBodyAndTables:
    def test_paragraphs_with_several_runs(self):
        assert gdoc_lines(gdoc(para(text_run("Bold part "), text_run("plain part\n")),
                               para(text_run("Second paragraph\n")))) == ["Bold part plain part", "Second paragraph"]

    def test_tables_merged_cells_and_nested_tables(self):
        doc = gdoc(
            para(text_run("Before\n")),
            table(
                [[para(text_run("Merged header\n"))], [para(text_run("\n"))]],  # covered cell comes back empty
                [[para(text_run("A2\n")), para(text_run("A2 second paragraph\n"))],
                 [table([[para(text_run("Nested\n"))]])]],
            ),
            para(text_run("After\n")),
        )
        assert gdoc_lines(doc) == ["Before", "Merged header", "A2", "A2 second paragraph", "Nested", "After"]

    def test_soft_line_break_stays_in_the_paragraph(self):
        assert gdoc_lines(gdoc(para(text_run("123 Main St\u000bSuite 4\n")))) == ["123 Main St\nSuite 4"]

    def test_empty_paragraphs_skipped(self):
        assert gdoc_lines(gdoc(para(text_run("\n")), para(text_run("Text\n")), para())) == ["Text"]

    def test_table_of_contents_and_section_breaks_skipped(self):
        doc = gdoc({"sectionBreak": {}}, {"tableOfContents": {"content": [para(text_run("Heading 1 ...... 2\n"))]}},
                   para(text_run("Heading 1\n")))
        assert gdoc_lines(doc) == ["Heading 1"]


class TestGoogleDocsChips:
    @pytest.mark.parametrize("element, shown", [
        ({"person": {"personProperties": {"name": "Jane Doe", "email": "jane@md.gov"}}}, "Jane Doe"),
        ({"person": {"personProperties": {"email": "jane@md.gov"}}}, "jane@md.gov"),
        ({"richLink": {"richLinkProperties": {"title": "FAMLI guide", "uri": "https://docs.google.com/x"}}}, "FAMLI guide"),
        ({"richLink": {"richLinkProperties": {"uri": "https://example.gov/form"}}}, "https://example.gov/form"),
        ({"dateElement": {"dateElementProperties": {"displayText": "Dec 1, 2026"}}}, "Dec 1, 2026"),
        ({"dropdown": {"dropdownProperties": {"displayValue": "Approved"}}}, "Approved"),
    ])
    def test_chip_read_as_displayed_text(self, element, shown):
        assert gdoc_lines(gdoc(para(text_run("Value: "), element, text_run(".\n")))) == [f"Value: {shown}."]


class TestGoogleDocsNotRead:
    def test_elements_without_text_add_nothing_and_no_markers(self, caplog):
        doc = gdoc(para(
            text_run("Footnote here"), {"footnoteReference": {"footnoteId": "f1", "footnoteNumber": "1"}},
            text_run(", page "), {"autoText": {"type": "PAGE_NUMBER"}},
            {"equation": {}}, {"inlineObjectElement": {"inlineObjectId": "img"}},
            {"pageBreak": {}}, {"horizontalRule": {}}, {"columnBreak": {}}, text_run("end\n")))
        with caplog.at_level(logging.WARNING):
            assert gdoc_lines(doc) == ["Footnote here, page end"]
        assert not caplog.records

    def test_unknown_element_logged_and_rest_kept(self, caplog):
        with caplog.at_level(logging.WARNING):
            assert gdoc_lines(gdoc(para(text_run("Kept "), {"startIndex": 1, "newChip": {"x": 1}}, text_run("text\n")))) == [
                "Kept text"]
        assert "newChip" in caplog.text

    def test_headers_footers_footnotes_not_read(self):
        doc = gdoc(tabs=[tab("T", [para(text_run("Body\n"))],
                             headers={"h": {"content": [para(text_run("HEADER\n"))]}},
                             footers={"f": {"content": [para(text_run("FOOTER\n"))]}},
                             footnotes={"n": {"content": [para(text_run("FOOTNOTE\n"))]}})])
        assert gdoc_lines(doc) == ["Body"]


class TestGoogleDocsTabs:
    def test_every_tab_in_order_children_after_parent(self):
        doc = gdoc(tabs=[
            tab("First", [para(text_run("Tab 1 text\n"))], children=[
                tab("First child", [para(text_run("Child text\n"))]),
            ]),
            tab("Second", [para(text_run("Tab 2 text\n"))]),
        ])
        assert gdoc_lines(doc) == ["Tab 1 text", "Child text", "Tab 2 text"]

    def test_tab_titles_not_read(self):
        assert gdoc_paragraphs(gdoc(tabs=[tab("First", [para(text_run("Body\n"))])])) == ["Body"]


class TestFetch:
    @patch("extract.main.google.auth.default", return_value=(MagicMock(), "proj"))
    @patch("extract.main.build")
    def test_google_docs_read_through_docs_api_without_suggestions(self, mock_build, _auth):
        docs = mock_build.return_value
        docs.documents.return_value.get.return_value.execute.return_value = gdoc(para(text_run("Hello\n")))

        assert fetch_paragraphs_from_drive("doc-id", MIME_GOOGLE_DOCS) == ["Hello"]
        assert mock_build.call_args[0][0] == "docs"
        docs.documents.return_value.get.assert_called_once_with(
            documentId="doc-id", includeTabsContent=True, suggestionsViewMode="PREVIEW_WITHOUT_SUGGESTIONS")
        assert GDOC_GET_PARAMS == {"includeTabsContent": True, "suggestionsViewMode": "PREVIEW_WITHOUT_SUGGESTIONS"}

    def test_paragraphs_become_blocks(self):
        paragraphs = gdoc_paragraphs(gdoc(para(text_run("One\u000bTwo\n")), table([[para(text_run("Cell\n"))]])))
        parsed = text_to_extraction_json(paragraphs, "src")
        assert [b["text"] for b in parsed["blocks"]] == ["One\nTwo", "Cell"]
