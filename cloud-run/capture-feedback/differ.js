const { diffWords } = require("diff");

/**
 * Compare AI-generated translation blocks against reviewer-edited blocks.
 *
 * Each result includes word-level diff changes plus character-level and
 * word-level Levenshtein edit distances.
 *
 * @param {Array<{original_text: string, translated_text: string}>} aiBlocks
 * @param {Array<{original_text: string, translated_text: string}>} reviewedBlocks
 * @returns {Array<Object>}
 */
function diffBlocks(aiBlocks, reviewedBlocks) {
  const results = [];

  for (let i = 0; i < aiBlocks.length; i++) {
    const aiText = (aiBlocks[i].translated_text || "").trim();
    const reviewedText = (reviewedBlocks[i]?.translated_text || "").trim();
    const hasChanges = aiText !== reviewedText;

    const changes = hasChanges ? diffWords(aiText, reviewedText) : [];

    const charDistance = hasChanges ? levenshtein(aiText, reviewedText) : 0;
    const aiWords = tokenize(aiText);
    const reviewedWords = tokenize(reviewedText);
    const wordDistance = hasChanges ? levenshtein(aiWords, reviewedWords) : 0;

    results.push({
      blockIndex: i,
      blockId: aiBlocks[i].id || "b" + (i + 1),
      hasChanges,
      aiText,
      reviewedText,
      changes,
      editDistance: {
        character: charDistance,
        word: wordDistance,
        aiCharCount: aiText.length,
        aiWordCount: aiWords.length,
      },
    });
  }

  return results;
}

/**
 * Levenshtein distance over sequences (strings or arrays).
 *
 * Uses a single-row DP approach — O(min(m, n)) space.
 */
function levenshtein(a, b) {
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  let prev = new Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    const curr = new Array(m + 1);
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,
        prev[i] + 1,
        prev[i - 1] + cost,
      );
    }
    prev = curr;
  }

  return prev[m];
}

function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

module.exports = { diffBlocks, levenshtein, tokenize };
