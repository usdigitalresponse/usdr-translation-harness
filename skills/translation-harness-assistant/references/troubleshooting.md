# Troubleshooting

## Hammer icon isn't showing up in Claude Desktop

The MCP server isn't connecting. Most likely cause: wrong path in the config file.

1. Open Terminal (Mac) or PowerShell (Windows) and run:
   ```bash
   cd ~/Projects/translation-harness
   ```
   If this fails, the folder isn't where the config expects it. Find where it actually is and update the path in the config.

2. Open Claude Desktop → **Claude menu → Settings → Developer → Edit Config** and check that the path in `--directory` matches exactly.

3. Restart Claude Desktop after saving any changes.

## "Python or uv not found" error

Run:
```bash
uv --version
```

If this fails, uv isn't installed or isn't on the PATH. Re-run Step 2 of setup.

## Server was working before, now it isn't

Usually caused by an incomplete update. Run:

```bash
cd ~/Projects/translation-harness
git pull
uv sync
```

Then restart Claude Desktop.

## Something else is wrong

Ask the volunteer to paste the full error message. Error messages appear in:
- The Claude Desktop developer console (Claude menu → Settings → Developer)
- Or as a response from Claude when trying to use a tool

Share the error with the team.
