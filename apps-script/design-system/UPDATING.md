# Updating the Design System Site

For whoever maintains the design system doc. Edit the Google Doc as usual, then have Claude (Claude Code) update the site from it. The site keeps the same URL.

## One-time setup

1. Ask Laurel to:
   - share the **Apps Script project** with you as an editor
   - send you the **script ID**
2. Clone this repo and open it in Claude Code.
3. Install and log in to clasp, the command-line tool for Apps Script (in Claude Code, type `!` before a command to run it yourself):
   ```
   ! npm install -g @google/clasp
   ! clasp login
   ```
   Log in with the Google account that has edit access to the project.
4. Create `apps-script/design-system/.clasp.json` with the script ID (it's gitignored, so it never gets committed):
   ```json
   { "scriptId": "<SCRIPT_ID>", "rootDir": "" }
   ```

## Each update

Paste this to Claude, with your doc link:

> Update the design system site in `apps-script/design-system/` to match this Google Doc: `<DOC LINK>`. Read `apps-script/design-system/README.md` first. Change only what differs from the doc, preview it locally, then push and deploy to the **existing** deployment with `clasp deploy -i`. Tell me what changed.

If Claude can't open the doc (it needs a Google Drive connection), use **File → Download → Markdown (.md)** in Google Docs and give Claude the downloaded file instead.

## What to check

- **Same URL:** Claude should deploy with `clasp deploy -i <DEPLOYMENT_ID>`. Running `clasp deploy` without `-i` makes a new URL. Running `clasp push` alone doesn't change the live site at all.
- **Look at the live site** after the deploy (reload the page).
- **Save your changes to the repo** (a branch and pull request, or send them to Laurel). Otherwise the next deploy from the repo overwrites them.
