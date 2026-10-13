# Design System Site

A reference web app (Apps Script) that renders the Translation Review add-on's design system: colors, typography, spacing, components, CSS variables, accessibility standards, and usage examples. Components are live, styled by the same CSS shown beside them.

Content is copied from the designer's Google Doc ("USDR Translation design system" tab, version 1.0, Oct 6 2026). It does not read the doc, so update the files here when the doc changes.

Not part of the translation pipeline.

## Files

| File | Contents |
|---|---|
| `Code.js` | `doGet()` serves the page; `include()` inlines `DesignSystemCss.html` |
| `DesignSystemCss.html` | The design system's CSS, copied from the doc. One `<style>` block per section (tokens, type, buttons, …); the page shows each block's text as that component's CSS sample |
| `Index.html` | The page: section content, live component examples, and the data for the swatch, type, and table sections (in the `<script>` at the bottom) |
| `appsscript.json` | Web app config: runs as the deploying user, open to anyone in the deploying account's domain |

## Updating when the doc changes

Step-by-step for the doc's maintainer (working with Claude Code): [UPDATING.md](UPDATING.md).

- Colors, type scale, spacing, tables, checklists: edit the arrays at the top of the `<script>` in `Index.html`
- Component CSS: edit the matching `<style id="css-…">` block in `DesignSystemCss.html`
- Component markup: edit the example inside its `.demo` block in `Index.html` (the HTML sample is read from the live markup)

## Setup and deploy

`.clasp.json` is gitignored for this project (it holds the script ID). To set it up, create `.clasp.json` with the script ID:

```json
{ "scriptId": "<SCRIPT_ID>", "rootDir": "" }
```

Push and update the existing deployment (keeps the same URL):

```sh
clasp push --force
clasp deployments                                   # find the deployment ID
clasp deploy -i <DEPLOYMENT_ID> -d "vN — what changed"
```

The URL is `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`. Running `clasp deploy` without `-i` creates a new deployment with a new URL.

## Preview locally

The page is plain HTML apart from the one `include()` tag. To preview without deploying, paste the contents of `DesignSystemCss.html` in place of `<?!= include("DesignSystemCss"); ?>` and open the result in a browser.
