The content below is structured JSON from an automated PDF extraction. Here is how to interpret it:

- **page_metadata**: An array of layout and dimension entries, one per page of the original PDF. Use this to understand space constraints.
- **blocks**: Every text element across all pages in reading order. Each block has:
  - "page": Which page the block appears on (1-indexed). "spans_pages" is true if the block crosses a page boundary.
  - "translate": true/false — only translate blocks marked true. Blocks marked false (e.g. logos, legal citations) are included for context only. You MUST translate ALL blocks where translate is true. Do not stop early or omit any blocks.
  - "spatial": Position and space constraints. When "space_constrained" is true, keep the translation concise to fit the original layout.
  - "typography" and "visual_emphasis": Formatting context that may affect translation choices (e.g. a bold callout should stay punchy).
  - "notes": Extraction-time guidance for the translator.
  - "id": Block identifier — reference these IDs in your response so translations can be mapped back to the source layout.
- **non_translatable_elements**: Phone numbers, URLs, emails, form numbers, etc. that must be preserved exactly as-is.
- **translation_warnings**: Specific challenges identified during extraction (space constraints, ambiguities, etc.). Address these in your translation.
