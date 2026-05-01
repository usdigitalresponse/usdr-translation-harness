# First-Time Setup

Walk through these steps in order, confirming each one before moving on.

## Step 1: Install Homebrew (Mac only, skip if already installed)

Homebrew is a package manager that makes it easy to install developer tools.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the prompts. It may ask for their Mac password.

> **Not on a Mac?** Ask the volunteer to reach out to the team for platform-specific help.

## Step 2: Install uv

`uv` manages Python and project dependencies.

```bash
brew install uv
```

Verify it worked:

```bash
uv --version
```

Should print a version number.

## Step 3: Download the repository

Create a folder and clone the repo:

```bash
mkdir -p ~/Projects
git clone https://github.com/your-org/translation-harness.git ~/Projects/translation-harness
```

> **No git?** Download the ZIP from GitHub, unzip it, and move the folder to `~/Projects/translation-harness`.

## Step 4: Set up the environment file

This creates a file called `.env` that stores a private API key for Honeycomb, a tool the team uses to monitor how the server is performing. Run these two commands in Terminal:

```bash
cd ~/Projects/translation-harness
```

```bash
touch .env
open -a TextEdit .env
```

TextEdit will open an empty file. Type the following, replacing `your-key-here` with the actual key the team shared with you:

```
HONEYCOMB_API_KEY=your-key-here
```

Save and close.

> This file is private — it's excluded from git automatically and should never be shared or pasted anywhere. If you don't have the key yet, skip this step and ask the team. The server works fine without it.

## Step 5: Configure Claude Desktop

1. Open Claude Desktop
2. Go to **Claude menu → Settings → Developer → Edit Config**
3. Add the following to the config file:

```json
{
  "mcpServers": {
    "translation-harness": {
      "command": "uv",
      "args": [
        "run",
        "--directory",
        "/Users/YOURUSERNAME/Projects/translation-harness",
        "python",
        "-m",
        "translation_harness.server"
      ]
    }
  }
}
```

Replace `YOURUSERNAME` with their actual Mac username. If they're not sure what it is:

```bash
whoami
```

## Step 6: Restart Claude Desktop

Quit and reopen Claude Desktop. Claude Desktop launches the server automatically — no manual start needed.

## Verify it's working

Ask the volunteer to look for a **plus icon** near the text input in Claude Desktop, then click it and choose **Connectors**. They should see the translation harness listed there. Then have them start a new conversation and try these checks:

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
