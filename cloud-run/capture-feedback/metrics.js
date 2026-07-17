/**
 * Compute aggregate quality metrics from block diffs.
 *
 * Metrics:
 *   - acceptanceRate: percentage of blocks the reviewer left unmodified
 *   - editDistance: aggregate character-level and word-level edit distances
 *   - perBlock: per-block edit distance breakdown
 *
 * @param {Array<Object>} diffs - Output from diffBlocks()
 * @param {Object} translationJson - Full translation JSON (for provider/model metadata)
 * @returns {Object} Computed metrics
 */
function computeMetrics(diffs, translationJson) {
  const totalBlocks = diffs.length;
  const unchangedBlocks = diffs.filter((d) => !d.hasChanges).length;
  const changedBlocks = totalBlocks - unchangedBlocks;

  const acceptanceRate = totalBlocks > 0
    ? unchangedBlocks / totalBlocks
    : 0;

  let totalCharDistance = 0;
  let totalWordDistance = 0;
  let totalAiChars = 0;
  let totalAiWords = 0;

  const perBlock = diffs.map((d) => {
    const ed = d.editDistance;
    totalCharDistance += ed.character;
    totalWordDistance += ed.word;
    totalAiChars += ed.aiCharCount;
    totalAiWords += ed.aiWordCount;

    return {
      blockId: d.blockId,
      hasChanges: d.hasChanges,
      characterEditDistance: ed.character,
      wordEditDistance: ed.word,
      aiCharCount: ed.aiCharCount,
      aiWordCount: ed.aiWordCount,
    };
  });

  return {
    provider: translationJson.provider || "",
    model: translationJson.model || "",
    totalBlocks,
    unchangedBlocks,
    changedBlocks,
    acceptanceRate,
    editDistance: {
      totalCharacter: totalCharDistance,
      totalWord: totalWordDistance,
      totalAiChars,
      totalAiWords,
      normalizedCharacter: totalAiChars > 0 ? totalCharDistance / totalAiChars : 0,
      normalizedWord: totalAiWords > 0 ? totalWordDistance / totalAiWords : 0,
    },
    perBlock,
  };
}

/**
 * Compute seconds between sidebar open and review submission.
 * Returns null if sidebarOpenedAt is missing (reviewer never opened the sidebar).
 */
function computeTimeToApprove(sidebarOpenedAt, submittedAt) {
  if (!sidebarOpenedAt) return null;
  const opened = new Date(sidebarOpenedAt);
  const submitted = new Date(submittedAt);
  if (isNaN(opened.getTime()) || isNaN(submitted.getTime())) return null;
  const seconds = (submitted - opened) / 1000;
  return seconds >= 0 ? Math.round(seconds) : null;
}

module.exports = { computeMetrics, computeTimeToApprove };
