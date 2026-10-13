/**
 * Design system reference site: a web app that renders the USDR Translation
 * Review add-on's design system (colors, typography, spacing, components).
 * Content is copied from the designer's Google Doc ("USDR Translation design
 * system" tab); update Index.html / DesignSystemCss.html when the doc changes.
 */

var PAGE_TITLE = "USDR Translation Design System";

/**
 * Serves the page for GET requests to the web app URL.
 *
 * @returns {HtmlOutput} The rendered page
 */
function doGet() {
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle(PAGE_TITLE)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Inlines another HTML file from this project (used by Index.html's template tags).
 *
 * @param {string} filename - Project file name without the .html extension
 * @returns {string} The file's contents
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
