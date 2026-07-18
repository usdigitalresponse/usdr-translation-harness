const REVIEWED_SIGNALS = new Set([
  "used_alternative",
  "accepted_then_changed",
  "fixed_manually",
  "needs_work",
]);

const TAB_REVIEWED = "Reviewed";
const TAB_MODEL_FLAGGED = "ModelFlagged";
const TAB_OTHER_CHANGES = "OtherChanges";

const SECTION_KEYS = [
  "alt_translations",
  "terms_flagged_for_clarification",
  "back_translation_of_key_phrases",
  "glossary_cross_check",
];

function buildSidebarKeyToBlockMap(translationJson) {
  const blocks = translationJson.blocks || [];
  const map = {};

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockId = block.id || "b" + (i + 1);

    for (const key of SECTION_KEYS) {
      const items = block[key] || [];
      const baseIndex = map._counters?.[key] || 0;
      for (let j = 0; j < items.length; j++) {
        map[key + "::" + (baseIndex + j)] = blockId;
      }
      if (!map._counters) map._counters = {};
      map._counters[key] = baseIndex + items.length;
    }
  }

  delete map._counters;
  return map;
}

/**
 * Extract terminology decisions from block diffs + sidebar review state.
 *
 * @param {Array} diffs - Output from diffBlocks()
 * @param {Object} translationJson - Full translation JSON (for metadata/glossary context)
 * @param {Object} sidebar - { checks: { status: {id: status}, flagged: {id: true} }, orphans: {key: true} }
 * @param {Object} docIds - { documentId, translationFileId } for linking back to source artifacts
 * @returns {Array<Object>} Terminology decisions with classification
 */
function extractDecisions(diffs, translationJson, sidebar = {}, docIds = {}) {
  const { checks = {}, orphans = {} } = sidebar;
  const aiBlocks = translationJson.blocks || [];
  const keyToBlock = buildSidebarKeyToBlockMap(translationJson);
  const decisions = [];

  for (const block of diffs) {
    if (!block.hasChanges) continue;

    const aiBlock = aiBlocks.find((b) => b.id === block.blockId) || {};
    const flaggedPhrases = collectFlaggedPhrases(aiBlock);
    const reviewSignal = classifyBlockSignal(block.blockId, checks, orphans, keyToBlock);

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
 * Determine the strongest review signal for a block from sidebar state.
 *
 * The sidebar persists checks as { status: { key: status }, flagged: { key: true } }
 * where status is "accepted" | "alternative" | "fixed" and flagged means "needs work".
 * Orphans (from checkItemsExist) are { key: true } for items whose text is missing
 * from the doc — indicating the reviewer edited the text.
 *
 * Signal priority (strongest first):
 *   "used_alternative"      — status is "alternative"
 *   "fixed_manually"        — status is "fixed"
 *   "accepted_then_changed" — status is "accepted" + text was edited (orphan)
 *   "needs_work"            — flagged
 *   "accepted"              — status is "accepted" + text unchanged
 *   "changed_without_review" — orphan but no sidebar status
 *   "no_sidebar_interaction" — fallback
 */
function classifyBlockSignal(blockId, checks, orphans, keyToBlock = {}) {
  const status = checks.status || {};
  const flagged = checks.flagged || {};

  const hasKeyMap = Object.keys(keyToBlock).length > 0;
  const blockKeys = Object.keys(keyToBlock).filter((k) => keyToBlock[k] === blockId);
  const allKeys = blockKeys.length
    ? blockKeys
    : hasKeyMap
      ? []
      : [...new Set([...Object.keys(status), ...Object.keys(flagged), ...Object.keys(orphans)])];

  let strongest = "no_sidebar_interaction";
  const PRIORITY = {
    no_sidebar_interaction: 0,
    changed_without_review: 1,
    accepted: 2,
    needs_work: 3,
    accepted_then_changed: 4,
    fixed_manually: 5,
    used_alternative: 6,
  };

  for (const key of allKeys) {
    let signal = "no_sidebar_interaction";
    const itemStatus = status[key];
    const itemFlagged = flagged[key];
    const itemOrphan = orphans[key];

    if (itemStatus === "alternative") {
      signal = "used_alternative";
    } else if (itemStatus === "fixed") {
      signal = "fixed_manually";
    } else if (itemStatus === "accepted" && itemOrphan) {
      signal = "accepted_then_changed";
    } else if (itemFlagged) {
      signal = "needs_work";
    } else if (itemStatus === "accepted") {
      signal = "accepted";
    } else if (itemOrphan) {
      signal = "changed_without_review";
    }

    if (PRIORITY[signal] > PRIORITY[strongest]) {
      strongest = signal;
    }
  }

  return strongest;
}

module.exports = {
  extractDecisions,
  buildSidebarKeyToBlockMap,
  classifyBlockSignal,
  classifyTab,
  collectFlaggedPhrases,
  TAB_REVIEWED,
  TAB_MODEL_FLAGGED,
  TAB_OTHER_CHANGES,
};
