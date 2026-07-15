const { google } = require("googleapis");
const { DOCS_API_VERSION, DRIVE_API_VERSION, stripExtension } = require("./loaders");

const DOC_PROPERTY_KEY = "usdr_translation_review";
const HEADER_BG = { red: 0.93, green: 0.93, blue: 0.93 };
const BODY_FONT = "Arial";
const HEADER_FONT_SIZE_PT = 10;
const BODY_FONT_SIZE_PT = 10;
const TITLE_FONT_SIZE_PT = 16;
const COLUMN_WIDTH_PT = 234;
const HEADER_LABEL_ORIGINAL = "Original Text (English)";
const HEADER_LABEL_TRANSLATED = "Translated Text (Spanish)";
const EMPTY_TRANSLATION_TEMPLATE = "No translatable content was returned by {provider}/{model}.";
const BODY_START_INDEX = 1;

/**
 * Create a Google Doc with a side-by-side translation table and store
 * metadata as a document property so the editor add-on can find it.
 *
 * Table layout (one content row per extraction block):
 *
 *   | Original Text (English) | Translated Text (Spanish) |
 *   |-------------------------|---------------------------|
 *   | block b01 original      | block b01 translation     |
 *   | block b02 original      | block b02 translation     |
 *   | ...                     | ...                       |
 *
 * Returns the created document's file ID.
 */
async function createTranslationDoc({
  translationJson,
  translationFileId,
  sourceFileName,
  provider,
  model,
  stagingFolderId,
  outputFolderId,
}) {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  const docs = google.docs({ version: DOCS_API_VERSION, auth });
  const drive = google.drive({ version: DRIVE_API_VERSION, auth });

  const blocks = translationJson.blocks || [];
  const baseName = stripExtension(sourceFileName);
  const docTitle = `${baseName} — ${provider}/${model} — Spanish Translation`;

  // Create an empty Google Doc in the staging folder via Drive API.
  // Service accounts can't use docs.documents.create (no personal Drive),
  // but can create files directly on a Shared Drive.
  const parents = stagingFolderId ? [stagingFolderId] : [];
  const { data: created } = await drive.files.create({
    requestBody: {
      name: docTitle,
      mimeType: "application/vnd.google-apps.document",
      parents,
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const documentId = created.id;

  try {
    if (!blocks.length) {
      const emptyMessage = EMPTY_TRANSLATION_TEMPLATE
        .replace("{provider}", provider)
        .replace("{model}", model);
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            { insertText: { text: docTitle + "\n" + emptyMessage, location: { index: BODY_START_INDEX } } },
          ],
        },
      });
      await setDocumentProperty(drive, documentId, translationFileId);
      if (outputFolderId) {
        await moveToFolder(drive, documentId, outputFolderId);
      }
      return documentId;
    }

    await insertStructure(docs, documentId, docTitle, blocks.length + 1);

    // The Docs API uses character-offset indices for all operations. When we
    // insert a table in Phase 1, the API assigns indices to every cell, but
    // we can't predict those indices ahead of time — they depend on internal
    // structural elements the API adds (row/cell/paragraph markers). So we
    // have to read the doc back after Phase 1 to discover the real indices,
    // then use them to insert text and format cells.
    await populateAndFormat(docs, documentId, blocks);

    // Value is just the translation file ID — the add-on fetches full
    // metadata from that file when needed.
    await setDocumentProperty(drive, documentId, translationFileId);

    // Move from staging to output folder last so the doc isn't visible
    // to translators until fully built
    if (outputFolderId) {
      await moveToFolder(drive, documentId, outputFolderId);
    }
  } catch (err) {
    console.error(`Doc creation failed, leaving ${documentId} in staging folder:`, err.message);
    throw err;
  }

  return documentId;
}

/**
 * Phase 1: Insert the title heading and an empty table.
 */
async function insertStructure(docs, documentId, title, tableRows) {
  const requests = [];
  let cursor = BODY_START_INDEX;

  // Title text
  requests.push({
    insertText: { text: title + "\n", location: { index: cursor } },
  });
  const titleEnd = cursor + title.length;
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: cursor, endIndex: titleEnd },
      paragraphStyle: { namedStyleType: "HEADING_1" },
      fields: "namedStyleType",
    },
  });
  requests.push({
    updateTextStyle: {
      range: { startIndex: cursor, endIndex: titleEnd },
      textStyle: {
        fontSize: { magnitude: TITLE_FONT_SIZE_PT, unit: "PT" },
        weightedFontFamily: { fontFamily: BODY_FONT },
      },
      fields: "fontSize,weightedFontFamily",
    },
  });

  // Table — inserted after the title paragraph
  cursor = titleEnd + 1;
  requests.push({
    insertTable: {
      rows: tableRows,
      columns: 2,
      location: { index: cursor },
    },
  });

  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });
}

/**
 * Phase 2: Read the doc structure, populate cells, then format.
 *
 * This runs as two sequential batchUpdate calls:
 *   2a. Insert text into cells (reverse order so indices stay valid)
 *   2b. Re-read the doc, then apply formatting with updated indices
 */
async function populateAndFormat(docs, documentId, blocks) {
  // 2a — Insert cell text
  const { data: doc } = await docs.documents.get({ documentId });
  const tableElement = findFirstTable(doc.body.content);
  if (!tableElement) {
    throw new Error("Table not found in document after creation");
  }

  const cellIndices = getCellIndices(tableElement);
  const insertRequests = [];

  // Insert in reverse row order, right-to-left within each row,
  // so earlier insertions don't shift later insertion points.
  for (let row = blocks.length; row >= 0; row--) {
    const isHeader = row === 0;
    for (let col = 1; col >= 0; col--) {
      let text;
      if (isHeader) {
        text = col === 0
          ? HEADER_LABEL_ORIGINAL
          : HEADER_LABEL_TRANSLATED;
      } else {
        const block = blocks[row - 1];
        text = col === 0
          ? (block.original_text || "")
          : (block.translated_text || "");
      }

      if (text) {
        insertRequests.push({
          insertText: {
            text,
            location: { index: cellIndices[row][col].start },
          },
        });
      }
    }
  }

  if (insertRequests.length) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: insertRequests },
    });
  }

  // 2b — Format with post-insertion indices
  const { data: updatedDoc } = await docs.documents.get({ documentId });
  const updatedTable = findFirstTable(updatedDoc.body.content);
  if (!updatedTable) {
    throw new Error("Table not found in document after text insertion");
  }
  const updatedCells = getCellIndices(updatedTable);

  const formatRequests = [];

  // Header row text formatting
  for (let col = 0; col < 2; col++) {
    const { start, end } = updatedCells[0][col];
    if (end > start) {
      formatRequests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end - 1 },
          textStyle: {
            bold: true,
            fontSize: { magnitude: HEADER_FONT_SIZE_PT, unit: "PT" },
            weightedFontFamily: { fontFamily: BODY_FONT },
          },
          fields: "bold,fontSize,weightedFontFamily",
        },
      });
    }
  }

  // Body cell text formatting
  for (let row = 1; row < updatedCells.length; row++) {
    for (let col = 0; col < 2; col++) {
      const { start, end } = updatedCells[row][col];
      if (end > start) {
        formatRequests.push({
          updateTextStyle: {
            range: { startIndex: start, endIndex: end - 1 },
            textStyle: {
              fontSize: { magnitude: BODY_FONT_SIZE_PT, unit: "PT" },
              weightedFontFamily: { fontFamily: BODY_FONT },
            },
            fields: "fontSize,weightedFontFamily",
          },
        });
      }
    }
  }

  // Header row background color
  const tableStart = updatedTable.startIndex;
  formatRequests.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStart },
          rowIndex: 0,
          columnIndex: 0,
        },
        rowSpan: 1,
        columnSpan: 2,
      },
      tableCellStyle: {
        backgroundColor: { color: { rgbColor: HEADER_BG } },
      },
      fields: "backgroundColor",
    },
  });

  // Equal column widths
  for (let col = 0; col < 2; col++) {
    formatRequests.push({
      updateTableColumnProperties: {
        tableStartLocation: { index: tableStart },
        columnIndices: [col],
        tableColumnProperties: {
          widthType: "FIXED_WIDTH",
          width: { magnitude: COLUMN_WIDTH_PT, unit: "PT" },
        },
        fields: "widthType,width",
      },
    });
  }

  if (formatRequests.length) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: formatRequests },
    });
  }
}

/**
 * Find the first table element in a document's body content.
 */
function findFirstTable(content) {
  for (const element of content) {
    if (element.table) return element;
  }
  return null;
}

/**
 * Extract cell paragraph indices from a table element.
 * Returns cellIndices[row][col] = { start, end }.
 */
function getCellIndices(tableElement) {
  const table = tableElement.table;
  const indices = [];

  for (const row of table.tableRows) {
    const rowIndices = [];
    for (const cell of row.tableCells) {
      const paragraph = cell.content[0]?.paragraph;
      if (!paragraph) {
        throw new Error("Table cell missing expected paragraph element");
      }
      const el = paragraph.elements[0];
      rowIndices.push({ start: el.startIndex, end: el.endIndex });
    }
    indices.push(rowIndices);
  }

  return indices;
}

/**
 * Move a file into a target Drive folder. Works with Shared Drives.
 */
async function moveToFolder(drive, fileId, folderId) {
  const { data: file } = await drive.files.get({
    fileId,
    fields: "parents",
    supportsAllDrives: true,
  });

  const previousParents = (file.parents || []).join(",");

  await drive.files.update({
    fileId,
    addParents: folderId,
    removeParents: previousParents,
    supportsAllDrives: true,
  });
}

/**
 * Set the usdr_translation_review property on the doc using Drive's
 * `properties` field (not `appProperties`) so any OAuth client — including
 * the editor add-on — can read it. Value is the translation file ID.
 */
async function setDocumentProperty(drive, fileId, translationFileId) {
  await drive.files.update({
    fileId,
    requestBody: {
      properties: { [DOC_PROPERTY_KEY]: translationFileId },
    },
    supportsAllDrives: true,
  });
}

module.exports = {
  createTranslationDoc,
  DOC_PROPERTY_KEY,
};
