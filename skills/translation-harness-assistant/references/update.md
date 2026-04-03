# Updating the Server

When the team ships changes, the volunteer needs to pull them down and restart Claude Desktop.

Open Terminal (Mac) or PowerShell (Windows) and run:

```bash
cd ~/Projects/translation-harness
git pull
uv sync
```

Then quit and reopen Claude Desktop.

> `uv sync` is safe to run even if nothing changed — it's a no-op if dependencies are up to date.

Verify it's still working by asking Claude to call the `ping` tool.
