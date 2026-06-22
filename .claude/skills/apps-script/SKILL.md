---
name: apps-script
description: Develop, push, and configure Google Apps Script projects (orchestrator + editor add-on) using clasp. Covers push/pull, Script Properties setup, trigger management, and testing. Use when asked to work on Apps Script code, push to Google, configure triggers or script properties. This skill does NOT deploy or publish — it only pushes code.
---

# Apps Script

Skill for working with the two Apps Script projects in this repo: the **orchestrator** (watches Drive for PDFs, calls Extract) and the **editor add-on** (adds "Submit Review" menu to translation output docs). Uses `clasp` CLI for push/pull.

**This skill must never publish add-ons or change Workspace admin settings — only the user does that.**

## What you can ask

**Getting started:**
- "Help me set up clasp for the Apps Script projects"
- "Check if my clasp auth is working"
- "Push the orchestrator to Google"

**Development:**
- "Pull the latest orchestrator code from Google"
- "Push the editor add-on"
- "Show me the Apps Script logs"

**Testing:**
- "Run the Apps Script tests"
- "Run the orchestrator unit tests"
- "How do I test the orchestrator manually?"
- "Push and test the orchestrator"

**Configuration:**
- "Set the Script Properties for the orchestrator"
- "What properties does the editor add-on need?"
- "Set up the orchestrator time trigger"

**Understanding:**
- "What do the Apps Script projects do?"
- "How does the orchestrator fit in the pipeline?"

## Project structure

```
apps-script/
  orchestrator/           Standalone script — watches Drive folder, calls Extract
    orchestrator.js       Main code
    test-helpers.js       Manual test functions (run from Apps Script Editor)
    appsscript.json       Manifest (scopes, runtime)
    .clasp.json           Script ID for clasp
  editor-addon/           Editor add-on — "Submit Review" menu in Docs
    addon.js              Main code
    appsscript.json       Manifest (scopes, add-on config)
    .clasp.json           Script ID for clasp
  tests/                  Local Jest unit tests for Apps Script logic
    test_orchestrator.js
  package.json            Dev dependencies (Jest)
  jest.config.js
```

Each project is a separate Apps Script project in Google, with its own script ID in `.clasp.json`.

## How the projects fit in the pipeline

```
[Drive folder] → Orchestrator (Apps Script, time trigger every 5 min)
                      │ calls Extract Cloud Run function (fire-and-forget, 202)
                      │ logs to Processing Log Google Sheet
                      ▼
              [... Cloud Run pipeline ...]
                      ▼
              [Reviewer opens output Doc]
                      │ Editor Add-on shows "Submit Review" menu
                      │ calls Capture Feedback Cloud Run function
```

The orchestrator is the pipeline entry point. The editor add-on is the pipeline exit point (feedback capture).

## How Apps Script development works

Apps Script code lives in Google's cloud — there's no local runtime. You edit locally, then push to Google, where it runs. This is different from typical Node/Python development where you run and test locally first.

**The dev loop:**

1. **Edit locally** — change `.js` files in the `apps-script/` directories. This is just regular JavaScript, but it runs in Google's V8 environment with Google-specific globals (`DriveApp`, `SpreadsheetApp`, `UrlFetchApp`, etc.) that aren't available locally.
2. **Push to Google** — `clasp push --force` from the project directory uploads your code to the Apps Script editor. This replaces the remote code entirely.
3. **Test in Google** — open the script at [script.google.com](https://script.google.com), select a function, and click Run. Watch the Execution Log for `Logger.log()` output and errors. There's no way to run Apps Script locally — Google's APIs only exist in their environment.
4. **Pull if needed** — if you or someone else edits directly in the online editor, `clasp pull` brings those changes back to local files.

**Key differences from normal JS development:**
- No `npm`, no `require`/`import` — all `.js` files in a project share a single global scope
- No local testing against real Google APIs — you can unit test pure logic, but anything touching `DriveApp`, `SpreadsheetApp`, etc. must be tested by running in Google
- `appsscript.json` is the manifest (like `package.json`) — it declares OAuth scopes the script needs
- Script Properties (set in the online editor under Project Settings) are the equivalent of environment variables

**When something isn't working:** open the script in the browser (`clasp open-script`), check the Executions log (left sidebar, clock icon), and look at the error details there. Stackdriver/Cloud Logging also captures exceptions.

## Testing

There are two layers of testing for Apps Script code:

### Local unit tests (Jest)

Tests for pure logic that doesn't need Google APIs. Run from `apps-script/`:

```sh
cd apps-script
npm install    # first time only
npm test
```

These use Node's `vm` module to load Apps Script files (which use global functions, not `module.exports`) into a sandbox with mocked Google globals (`PropertiesService`, `DriveApp`, `SpreadsheetApp`, `UrlFetchApp`, etc.). Each test gets a fresh sandbox.

Add new test files to `apps-script/tests/`. The test files, `package.json`, and `jest.config.js` live outside the clasp project directories, so `clasp push` never sends them to Google.

### Manual test functions (Apps Script Editor)

Each project includes `test-helpers.js` with functions you can run from the Apps Script Editor's Run button. These test against real Google services (Drive, Sheets, etc.) and are useful for verifying configuration, access, and end-to-end behavior.

The orchestrator includes:
- `testConfig` — verifies script properties are set
- `testFolderAccess` — lists PDFs in the input folder
- `testProcessingLog` — shows processing log contents
- `testWatchWithStub` — runs the full watcher flow with a stub extract call (no real Cloud Run call)

After pushing with `clasp push`, open the script at [script.google.com](https://script.google.com), select a test function, and click Run. Output appears in the Execution Log.

**Version control and GitHub:**

Apps Script code lives in two places: this Git repo (source of truth) and Google's cloud (where it runs). They're synced manually via `clasp push` and `clasp pull` — there's no automatic link between them.

- **GitHub is the source of truth.** All changes should be committed to Git before or after pushing to Google. The code in Google is a deployment target, not a versioned copy.
- **The full workflow is: edit locally → `clasp push --force` to Google → test in Google → iterate → commit when it works → open a PR.** Push and test as many times as you need before committing. Commits are cheap, so committing early is fine too — the PR is the real quality gate, not individual commits.
- **When you merge a PR, `clasp push` the final version.** You're responsible for making sure the code running in Google matches what's in `main`. Merging to GitHub doesn't automatically update Google — you need to `clasp push` from the merged branch so the two stay in sync.
- **If someone edits in the online editor:** run `clasp pull` to bring changes back to local, review the diff, and commit. Treat it the same as any other code change.
- **Branch normally.** Apps Script changes go on feature branches and through PRs like everything else. The `clasp push` happens from whatever branch you're on — there's no branch concept on the Google side. During development, push from your feature branch to test. After merging a PR, push from `main` to finalize.
- **`.clasp.json` is checked in** but contains a script ID, not secrets. It maps this directory to a specific Apps Script project in Google. Don't change it unless you're pointing to a different project.
- **Script Properties are not version-controlled.** They live only in Google and are not affected by `clasp push` or `clasp pull`. Document expected properties in READMEs and `.env.example` so new contributors know what to set.

## Prerequisites

Clasp stores OAuth credentials in `~/.clasprc.json`. The user must run `clasp login` in the **same terminal session** where Claude is running — otherwise Claude cannot authenticate with Google's Apps Script API. If clasp commands fail with auth errors, remind the user to run `! clasp login` (the `!` prefix runs it in the current session).

## Task: First-time setup

When the user needs to set up clasp for Apps Script development:

1. Check clasp is installed:
   ```sh
   clasp --version   # need 3.x
   ```
   If missing: `npm install -g @google/clasp`

2. Check clasp login status:
   ```sh
   clasp show-authorized-user
   ```
   **Do NOT use `clasp login --status`** — it does not exist and will error. If not logged in, tell the user to run `clasp login` (this opens a browser — they must do it themselves).

3. Verify script IDs are configured. Check both `.clasp.json` files:
   - `apps-script/orchestrator/.clasp.json`
   - `apps-script/editor-addon/.clasp.json`

   If either is missing or has a placeholder, tell the user:
   - Run `clasp create --title "<name>" --type standalone` from the project directory
   - Or go to [script.google.com](https://script.google.com) and create a new project, then copy the script ID from Project Settings → IDs into `.clasp.json`

4. Test with a pull:
   ```sh
   cd apps-script/orchestrator && clasp pull
   ```

## Task: Push code to Google

Push from the specific project directory:

```sh
# Orchestrator
cd apps-script/orchestrator && clasp push

# Editor add-on
cd apps-script/editor-addon && clasp push
```

`clasp push` sends all files not excluded by `.claspignore` (which allows `.js`, `.gs`, `.html`, and `appsscript.json`).

If `clasp push` prints "Skipping push." with no error, use `clasp push --force`. This happens because clasp prompts interactively when it detects the local `appsscript.json` differs from the remote manifest ("Do you want to push and overwrite?"), and in a non-interactive terminal the prompt defaults to "no". The `--force` flag skips this confirmation — it is safe and only affects the manifest overwrite prompt.

After pushing, tell the user the code is live in the Apps Script editor. **Do not publish the add-on or change deployment settings.**

## Task: Pull code from Google

Pull the latest code from the Apps Script editor back to local:

```sh
cd apps-script/orchestrator && clasp pull
cd apps-script/editor-addon && clasp pull
```

Review the diff after pulling — the user may have made changes directly in the online editor.

## Task: View logs

```sh
cd apps-script/orchestrator && clasp tail-logs
cd apps-script/editor-addon && clasp tail-logs
```

Logs from `Logger.log()` and `console.log()` appear here. Both projects also route exceptions to Stackdriver (Cloud Logging) via the `STACKDRIVER` setting in `appsscript.json`.

## Task: Configure Script Properties

Script Properties are key-value pairs set in the Apps Script editor (Project Settings → Script Properties) or programmatically. They store config that shouldn't be in code.

**Orchestrator needs:**
| Property | Description |
|---|---|
| `INPUT_FOLDER_ID` | Google Drive folder ID to watch for incoming PDFs |
| `EXTRACT_FUNCTION_URL` | URL of the Extract Cloud Run function |
| `PROCESSING_LOG_SHEET_ID` | Google Sheet ID for the processing log (tab named `ProcessingLog` with headers: `fileId`, `fileName`, `processedAt`, `status`, `durationMs`, `errorDetail`) |

**Editor add-on needs:**
| Property | Description |
|---|---|
| `CAPTURE_FEEDBACK_FUNCTION_URL` | URL of the Capture Feedback Cloud Run function |

To set properties, tell the user to:
1. Open the script at [script.google.com](https://script.google.com)
2. Go to Project Settings → Script Properties
3. Add each key-value pair

These values come from the `.env` file at the repo root (same values used by Cloud Run functions). The Cloud Run function URLs are the deployed endpoint URLs.

## Task: Set up the orchestrator time trigger

The orchestrator has a `createTimeTrigger()` function that sets up a 5-minute polling trigger. To activate it:

1. Push the code first (see above)
2. Open the script at [script.google.com](https://script.google.com)
3. Run `createTimeTrigger` from the editor (Run → select function → Run)
4. Approve the OAuth consent screen when prompted

Alternatively, the user can set up the trigger manually:
1. Go to Triggers (clock icon in left sidebar)
2. Add trigger: `watchForNewPDFs`, time-driven, every 5 minutes

Only one trigger should exist — check Triggers page to avoid duplicates.

## Task: Open in browser

```sh
# Open the orchestrator in the Apps Script editor
cd apps-script/orchestrator && clasp open-script

# Open the editor add-on
cd apps-script/editor-addon && clasp open-script
```

## OAuth scopes reference

**Orchestrator** (`appsscript.json`):
- `auth/drive` — read PDFs from input folder
- `auth/spreadsheets` — read/write the processing log Google Sheet
- `auth/script.external_request` — call Extract Cloud Run function via `UrlFetchApp`
- `openid` — required for `ScriptApp.getIdentityToken()` to authenticate with Cloud Run
- `auth/userinfo.email` — includes caller email in the identity token for Cloud Run IAM

**Editor add-on** (`appsscript.json`):
- `auth/documents.currentonly` — read the currently open doc and check its properties
- `auth/script.container.ui` — add menus to the Docs UI
- `auth/script.external_request` — call Capture Feedback Cloud Run function via `UrlFetchApp`
- `openid` — required for `ScriptApp.getIdentityToken()` to authenticate with Cloud Run
- `auth/userinfo.email` — includes caller email in the identity token for Cloud Run IAM

If you need to add scopes (e.g., for Sheets access), update the `oauthScopes` array in the relevant `appsscript.json`. Users will need to re-authorize on next run.
