/**
 * Split an extraction into contiguous block ranges for parallel LLM calls,
 * and merge the per-chunk translations back into one result.
 *
 * Large documents don't fit the 600 s request limit in one call: on a
 * 438-block document Claude Opus 5.5 took 437 s in one call vs 179 s as
 * 4 x 110-block chunks, and gemini-4-carbon ~570 s vs 183-361 s per chunk.
 * Documents with CHUNK_SIZE or fewer translatable blocks stay one call.
 */

// Translatable blocks per chunk, for every model
const CHUNK_SIZE = 110;

// All chunks run at once: Cloud Run's 600 s timeout covers the whole request,
// so a second wave of chunks wouldn't fit. 4 parallel calls is the tested
// level; 11 parallel gemini-4-carbon calls hit a 429 (TPM quota).
const MAX_PARALLEL_CHUNKS = 4;

/**
 * Plan contiguous chunks of the extraction's blocks.
 *
 * Chunks are cut by translatable-block count, but each chunk keeps every block
 * in its range (including translate=false context blocks) so the model sees
 * the surrounding text. If the document needs more than maxParallel chunks,
 * the chunk size grows instead, so all chunks run in a single wave.
 *
 * @param {Array<{id: string, translate?: boolean}>} blocks - extraction blocks, in order
 * @param {number} chunkSize - target translatable blocks per chunk (0 = no chunking)
 * @param {number} [maxParallel]
 * @returns {Array<{blocks: Array, expectedBlockIds: string[]}>} one entry per chunk
 */
function planChunks(blocks, chunkSize, maxParallel = MAX_PARALLEL_CHUNKS) {
  const translatable = blocks.filter((b) => b.translate !== false).length;
  if (!chunkSize || translatable <= chunkSize) {
    return [{ blocks, expectedBlockIds: blocks.filter((b) => b.translate !== false).map((b) => b.id) }];
  }
  const chunkCount = Math.min(Math.ceil(translatable / chunkSize), maxParallel);
  const perChunk = Math.ceil(translatable / chunkCount);

  const chunks = [];
  let current = { blocks: [], expectedBlockIds: [] };
  for (const block of blocks) {
    if (current.expectedBlockIds.length === perChunk && block.translate !== false) {
      chunks.push(current);
      current = { blocks: [], expectedBlockIds: [] };
    }
    current.blocks.push(block);
    if (block.translate !== false) {
      current.expectedBlockIds.push(block.id);
    }
  }
  chunks.push(current);
  return chunks;
}

/**
 * Merge per-chunk translation JSON (in chunk order) into one translation.
 *
 * @param {Array<{blocks?: Array, metadata?: Object}>} parts
 * @returns {{blocks: Array, metadata: Object}}
 */
function mergeChunkTranslations(parts) {
  const blocks = parts.flatMap((p) => (Array.isArray(p?.blocks) ? p.blocks : []));
  const first = parts.find((p) => p?.metadata)?.metadata || {};
  const notes = parts
    .map((p) => (p?.metadata?.overall_notes || "").trim())
    .filter(Boolean);
  return {
    blocks,
    metadata: { ...first, overall_notes: [...new Set(notes)].join("\n\n") },
  };
}

module.exports = { CHUNK_SIZE, MAX_PARALLEL_CHUNKS, planChunks, mergeChunkTranslations };
