# Loading the glossary

**Always load the glossary fresh from Drive before translating or reviewing.** Don't rely on a copy from earlier in the conversation, from memory, or bundled with the skill: the content team updates it.

The glossary is a Google Sheet with several tabs; the one to use is named in `materials.md`. Two Drive connector shortcuts **don't work** for it:
- reading the sheet as text returns only a preview of each tab;
- exporting it as CSV returns only the **first** tab, which may be a different glossary (for example an English-only one).

So download the whole sheet as Excel and read the right tab with the helper script.

## Steps

1. **Download** the glossary sheet (link in `materials.md`) with the Drive connector's download tool, exporting as Excel:
   `exportMimeType: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
2. The download is usually too large to show, so the connector **saves it to a file** and says where (in claude.ai, under `/mnt/user-data/tool_results/`; in Claude Code, a `tool-results` folder). Note that path.
3. **Load the tab** with the helper script (it decodes the download and reads the tab with openpyxl):
   ```
   python scripts/load_glossary.py <saved file> "<glossary tab name>" --out glossary.json
   ```
   It writes `glossary.json` (one entry per term) and prints a summary.
4. **Tell the user** the number of terms loaded and the "last updated" date if the summary has one, so they can confirm the version. If `missing_expected_columns` isn't empty, say which columns are missing.
5. **Look up terms:** before translating, search `glossary.json` (English Term and Approved Spanish) for every key term in the source, including partial matches (e.g. "leave" inside "family leave").
6. **Check forbidden terms:** after translating, run
   ```
   python scripts/check_forbidden.py translation.txt glossary.json
   ```
   and review every hit in context. A hit isn't automatically wrong: a word can be forbidden for one meaning and fine for another (the hit shows which entry forbids it and that entry's context). Fix real violations, and report the result.

If a step fails (no Drive access, the file moved, the tab was renamed, openpyxl missing), **tell the user which step failed**. Don't translate from memory or from an older copy without saying so.

If the user has an `.xlsx` export, or a `.csv` export of just the glossary tab, pass that file to step 3 directly.

## Without code execution

Ask the user to copy the glossary tab (all columns) and paste it, or export just that tab as CSV and attach it. Say you're working from a pasted copy, check terms by reading it, and check forbidden terms by hand (say that this check was manual).

## Using it

- **Approved Spanish** is the term to use, exactly as written, including capitalization, even if the English capitalizes it differently.
- **Forbidden Terms** must never appear for that meaning, even if they seem natural.
- **Definition/Context** and **Notes** say when a term applies. A term approved for one program may not fit another; check the context before applying it to content from a different program, and say when you're unsure.
- Don't change the glossary. When you find a term that isn't in it and should be, list it as a **proposed glossary entry** for the content team, in the glossary's columns (English Term, Approved Spanish (proposed), Definition/Context, Example English, Example Spanish, Notes: where it came from).
