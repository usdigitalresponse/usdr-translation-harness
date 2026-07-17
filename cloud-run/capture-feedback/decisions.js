const REVIEWED_SIGNALS = new Set(["reviewed_and_changed", "reviewed_and_accepted"]);

const TAB_REVIEWED = "Reviewed";
const TAB_MODEL_FLAGGED = "ModelFlagged";
const TAB_OTHER_CHANGES = "OtherChanges";

/**
 * Extract terminology decisions from block diffs + sidebar review state.
 *
 * Each decision is classified into a tab for the derived glossary:
 *   1. "Reviewed" — reviewer interacted with the sidebar (highest priority)
 *   2. "ModelFlagged" — changed text overlaps with a model-flagged phrase
 *   3. "OtherChanges" — everything else (short words, grammar, incidental)
 *
 * @param {Array} diffs - Output from diffBlocks()
 * @param {Object} translationJson - Full translation JSON (for metadata/glossary context)
 * @param {Object} sidebar - { checks: {key: true}, orphans: {key: true} }
 * @param {Object} docIds - { documentId, translationFileId } for linking back to source artifacts
 * @returns {Array<Object>} Terminology decisions with classification
 */
function extractDecisions(diffs, translationJson, sidebar = {}, docIds = {}) {
  const { checks = {}, orphans = {} } = sidebar;
  const aiBlocks = translationJson.blocks || [];
  const decisions = [];

  for (const block of diffs) {
    if (!block.hasChanges) continue;

    const aiBlock = aiBlocks.find((b) => b.id === block.blockId) || {};
    const flaggedPhrases = collectFlaggedPhrases(aiBlock);
    const reviewSignal = classifyBlockSignal(block.blockId, checks, orphans);

    const changes = block.changes || [];
    let i = 0;
    while (i < changes.length) {
      const change = changes[i];
      if (change.removed) {
        const next = changes[i + 1];
        if (next?.added) {
          const aiTerm = change.value.trim();
          const reviewerTerm = next.value.trim();
          const tab = classifyTab(reviewSignal, aiTerm, flaggedPhrases);

          decisions.push({
            aiTerm,
            reviewerTerm,
            blockId: block.blockId,
            reviewSignal,
            tab,
            documentId: docIds.documentId || "document ID not available",
            translationFileId: docIds.translationFileId || "translation file ID not available",
          });
          i += 2;
          continue;
        }
      }
      i++;
    }
  }

  return decisions;
}

/**
 * Collect all model-flagged translation phrases from a block's metadata.
 * Returns a Set of lowercased phrases for overlap matching.
 */
function collectFlaggedPhrases(aiBlock) {
  const phrases = new Set();

  for (const item of aiBlock.alt_translations || []) {
    if (item.primary_translation) phrases.add(item.primary_translation.toLowerCase());
    if (item.alt_translation) phrases.add(item.alt_translation.toLowerCase());
  }
  for (const item of aiBlock.terms_flagged_for_clarification || []) {
    if (item.translation) phrases.add(item.translation.toLowerCase());
  }
  for (const item of aiBlock.back_translation_of_key_phrases || []) {
    if (item.translation) phrases.add(item.translation.toLowerCase());
  }
  for (const item of aiBlock.glossary_cross_check || []) {
    if (item.translation) phrases.add(item.translation.toLowerCase());
  }

  return phrases;
}

/**
 * Determine which glossary tab a decision belongs to.
 * Priority: sidebar review signal > model-flag overlap > catch-all.
 */
function classifyTab(reviewSignal, aiTerm, flaggedPhrases) {
  if (REVIEWED_SIGNALS.has(reviewSignal)) {
    return TAB_REVIEWED;
  }

  if (overlapsWithFlagged(aiTerm, flaggedPhrases)) {
    return TAB_MODEL_FLAGGED;
  }

  return TAB_OTHER_CHANGES;
}

/**
 * Check whether a changed term overlaps with any model-flagged phrase.
 *
 * Matches when:
 *   - The term exactly equals a flagged phrase, OR
 *   - The term contains a flagged phrase as a whole word, OR
 *   - A flagged phrase contains the term as a whole word
 *
 * Word boundary matching prevents false positives like "el" matching
 * "elegibilidad".
 */
function overlapsWithFlagged(term, flaggedPhrases) {
  const lower = term.toLowerCase();
  for (const phrase of flaggedPhrases) {
    if (lower === phrase) return true;
    if (containsWholeWord(lower, phrase)) return true;
    if (containsWholeWord(phrase, lower)) return true;
  }
  return false;
}

function containsWholeWord(haystack, needle) {
  if (!needle || !haystack) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:^|\\s)" + escaped + "(?:\\s|$)");
  return pattern.test(haystack);
}

/**
 * Check sidebar state for any items associated with this block.
 *
 * Sidebar keys are formatted as "sectionKey::index". Items carry a block_id,
 * but the sidebar keys use flat indices per section, not block IDs. So we
 * look for any sidebar interaction on items from this block by checking
 * if any checked or orphaned key exists.
 *
 * Returns the strongest signal found for the block:
 *   "reviewed_and_changed" — checked + orphan (strongest)
 *   "reviewed_and_accepted" — checked + not orphan
 *   "changed_without_review" — orphan + not checked
 *   "no_sidebar_interaction" — fallback
 */
function classifyBlockSignal(blockId, checks, orphans) {
  let hasChecked = false;
  let hasOrphan = false;

  const allKeys = new Set([...Object.keys(checks), ...Object.keys(orphans)]);
  for (const key of allKeys) {
    if (checks[key]) hasChecked = true;
    if (orphans[key]) hasOrphan = true;
  }

  // TODO: Once we can map sidebar keys back to block IDs, filter to
  // only items from this specific block. For now, we report the
  // aggregate signal across all sidebar items.

  if (hasChecked && hasOrphan) return "reviewed_and_changed";
  if (hasChecked) return "reviewed_and_accepted";
  if (hasOrphan) return "changed_without_review";
  return "no_sidebar_interaction";
}

module.exports = {
  extractDecisions,
  classifyBlockSignal,
  classifyTab,
  collectFlaggedPhrases,
  TAB_REVIEWED,
  TAB_MODEL_FLAGGED,
  TAB_OTHER_CHANGES,
};
