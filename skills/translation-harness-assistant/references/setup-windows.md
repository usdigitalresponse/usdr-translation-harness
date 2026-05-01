# First-Time Setup (Windows)

Walk through these steps in order, confirming each one before moving on. All commands should be run in **PowerShell** — search for it in the Start menu.

## Step 1: Install uv

`uv` manages Python and project dependencies. Run this in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Close and reopen PowerShell after it finishes, then verify:

```powershell
uv --version
```

Should print a version number.

## Step 2: Install Git

Check if Git is already installed:

```powershell
git --version
```

If that prints a version number, skip to Step 3. If not, install it:

```powershell
winget install Git.Git
```

Close and reopen PowerShell after it finishes.

## Step 3: Download the repository

```powershell
mkdir ~/Projects
git clone https://github.com/your-org/translation-harness.git ~/Projects/translation-harness
```

## Step 4: Set up the environment file

This creates a file called `.env` that stores a private API key for Honeycomb, a tool the team uses to monitor how the server is performing.

```powershell
cd ~/Projects/translation-harness
New-Item .env
notepad .env
```

Notepad will open an empty file. Type the following, replacing `your-key-here` with the actual key the team shared with you:

```
HONEYCOMB_API_KEY=your-key-here
```

Save and close.

> This file is private — it's excluded from git automatically and should never be shared or pasted anywhere. If you don't have the key yet, skip this step and ask the team. The server works fine without it.

## Step 5: Configure Claude Desktop

First, find your Windows username:

```powershell
whoami
```

This prints something like `COMPUTERNAME\username` — the part after the backslash is your username.

Then:

1. Open Claude Desktop
2. Go to **Claude menu → Settings → Developer → Edit Config**
3. Add the following to the config file, replacing `YOURUSERNAME` with your username:

```json
{
  "mcpServers": {
    "translation-harness": {
      "command": "uv",
      "args": [
        "run",
        "--directory",
        "C:/Users/YOURUSERNAME/Projects/translation-harness",
        "python",
        "-m",
        "translation_harness.server"
      ]
    }
  }
}
```

## Step 6: Restart Claude Desktop

Quit and reopen Claude Desktop. Claude Desktop launches the server automatically — no manual start needed.

## Verify it's working

Look for a **plus icon** near the text input in Claude Desktop, then click it and choose **Connectors**. The translation harness should be listed there. Start a new conversation and try these checks:

> "Can you call the ping tool from the translation harness?"

Expected response: `Translation harness MCP server is running!`

> "Can you call get_glossary and tell me what the approved Spanish term is for 'Allotment'?"

Expected response: the glossary entry for Allotment with its Spanish term and definition.

> "Can you call get_rubric with section='accuracy_and_relevance'?"

Expected response: the accuracy and relevance criteria and scoring guidance.

If the translation harness isn't showing up under Connectors, see `references/troubleshooting.md`.

## Optional: Install the evaluation skill (content partners)

If you're testing Spanish translation quality, also install the evaluation skill:

1. Find `translation-evaluator.skill` in the `skills/` folder of the repository
2. Open Claude Desktop → **Settings → Customize → Skills**
3. Upload the file

Once installed, start a new conversation and paste a Spanish translation:

> "Please evaluate this Spanish translation: [paste translation here]"

Claude will use the glossary and rubric automatically to score the translation.
