const { diffBlocks, levenshtein, tokenize } = require("../capture-feedback/differ");
const {
  extractDecisions,
  classifyBlockSignal,
  classifyTab,
  collectFlaggedPhrases,
  TAB_REVIEWED,
  TAB_MODEL_FLAGGED,
  TAB_OTHER_CHANGES,
} = require("../capture-feedback/decisions");
const { computeMetrics } = require("../capture-feedback/metrics");

describe("diffBlocks", () => {
  test("reports no changes when texts match", () => {
    const ai = [{ id: "b1", translated_text: "Hola mundo" }];
    const reviewed = [{ translated_text: "Hola mundo" }];

    const result = diffBlocks(ai, reviewed);

    expect(result).toHaveLength(1);
    expect(result[0].hasChanges).toBe(false);
    expect(result[0].changes).toEqual([]);
  });

  test("detects changes and computes edit distances", () => {
    const ai = [{ id: "b1", translated_text: "Hola mundo" }];
    const reviewed = [{ translated_text: "Hola tierra" }];

    const result = diffBlocks(ai, reviewed);

    expect(result[0].hasChanges).toBe(true);
    expect(result[0].changes.length).toBeGreaterThan(0);
    expect(result[0].aiText).toBe("Hola mundo");
    expect(result[0].reviewedText).toBe("Hola tierra");
    expect(result[0].editDistance.character).toBeGreaterThan(0);
    expect(result[0].editDistance.word).toBe(1);
    expect(result[0].editDistance.aiCharCount).toBe(10);
    expect(result[0].editDistance.aiWordCount).toBe(2);
  });

  test("reports zero edit distance when texts match", () => {
    const ai = [{ id: "b1", translated_text: "Hola mundo" }];
    const reviewed = [{ translated_text: "Hola mundo" }];

    const result = diffBlocks(ai, reviewed);

    expect(result[0].editDistance.character).toBe(0);
    expect(result[0].editDistance.word).toBe(0);
  });

  test("handles missing reviewed block gracefully", () => {
    const ai = [
      { id: "b1", translated_text: "Primero" },
      { id: "b2", translated_text: "Segundo" },
    ];
    const reviewed = [{ translated_text: "Primero" }];

    const result = diffBlocks(ai, reviewed);

    expect(result).toHaveLength(2);
    expect(result[0].hasChanges).toBe(false);
    expect(result[1].hasChanges).toBe(true);
    expect(result[1].reviewedText).toBe("");
  });

  test("assigns blockId from AI block or generates fallback", () => {
    const ai = [
      { id: "section-1", translated_text: "A" },
      { translated_text: "B" },
    ];
    const reviewed = [{ translated_text: "A" }, { translated_text: "B" }];

    const result = diffBlocks(ai, reviewed);

    expect(result[0].blockId).toBe("section-1");
    expect(result[1].blockId).toBe("b2");
  });
});

describe("extractDecisions", () => {
  test("returns empty array when no blocks changed", () => {
    const diffs = [{ hasChanges: false, changes: [] }];
    const result = extractDecisions(diffs, {});
    expect(result).toEqual([]);
  });

  test("pairs removed/added segments as decisions with default signal and doc IDs", () => {
    const ai = [{ id: "b1", translated_text: "elegibilidad" }];
    const reviewed = [{ translated_text: "idoneidad" }];
    const diffs = diffBlocks(ai, reviewed);
    const docIds = { documentId: "doc123", translationFileId: "tf456" };

    const result = extractDecisions(diffs, {}, {}, docIds);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].aiTerm).toBe("elegibilidad");
    expect(result[0].reviewerTerm).toBe("idoneidad");
    expect(result[0].blockId).toBe("b1");
    expect(result[0].reviewSignal).toBe("no_sidebar_interaction");
    expect(result[0].tab).toBe(TAB_OTHER_CHANGES);
    expect(result[0].documentId).toBe("doc123");
    expect(result[0].translationFileId).toBe("tf456");
  });

  test("classifies as Reviewed tab when sidebar signal is reviewed_and_changed", () => {
    const diffs = [{
      hasChanges: true,
      blockId: "b1",
      reviewedText: "idoneidad",
      changes: [
        { removed: true, value: "elegibilidad" },
        { added: true, value: "idoneidad" },
      ],
    }];
    const sidebar = {
      checks: { "alt_translations::0": true },
      orphans: { "alt_translations::0": true },
    };

    const result = extractDecisions(diffs, {}, sidebar);

    expect(result[0].reviewSignal).toBe("reviewed_and_changed");
    expect(result[0].tab).toBe(TAB_REVIEWED);
  });

  test("classifies as ModelFlagged tab when term overlaps with model-flagged phrase", () => {
    const translationJson = {
      blocks: [{
        id: "b1",
        translated_text: "elegibilidad",
        alt_translations: [{
          original_phrase: "eligibility",
          primary_translation: "elegibilidad",
          alt_translation: "idoneidad",
          rationale: "more natural",
        }],
        terms_flagged_for_clarification: [],
        back_translation_of_key_phrases: [],
        glossary_cross_check: [],
      }],
    };
    const diffs = [{
      hasChanges: true,
      blockId: "b1",
      reviewedText: "idoneidad",
      changes: [
        { removed: true, value: "elegibilidad" },
        { added: true, value: "idoneidad" },
      ],
    }];

    const result = extractDecisions(diffs, translationJson);

    expect(result[0].tab).toBe(TAB_MODEL_FLAGGED);
  });

  test("sidebar review signal takes priority over model-flag overlap", () => {
    const translationJson = {
      blocks: [{
        id: "b1",
        translated_text: "elegibilidad",
        alt_translations: [{
          original_phrase: "eligibility",
          primary_translation: "elegibilidad",
          alt_translation: "idoneidad",
          rationale: "more natural",
        }],
        terms_flagged_for_clarification: [],
        back_translation_of_key_phrases: [],
        glossary_cross_check: [],
      }],
    };
    const diffs = [{
      hasChanges: true,
      blockId: "b1",
      reviewedText: "idoneidad",
      changes: [
        { removed: true, value: "elegibilidad" },
        { added: true, value: "idoneidad" },
      ],
    }];
    const sidebar = {
      checks: { "alt_translations::0": true },
      orphans: { "alt_translations::0": true },
    };

    const result = extractDecisions(diffs, translationJson, sidebar);

    expect(result[0].tab).toBe(TAB_REVIEWED);
  });

  test("skips blocks with no changes", () => {
    const diffs = [
      { hasChanges: false, blockId: "b1", changes: [] },
      {
        hasChanges: true,
        blockId: "b2",
        reviewedText: "corrected",
        changes: [
          { removed: true, value: "wrong" },
          { added: true, value: "corrected" },
        ],
      },
    ];

    const result = extractDecisions(diffs, {});

    expect(result).toHaveLength(1);
    expect(result[0].blockId).toBe("b2");
  });
});

describe("collectFlaggedPhrases", () => {
  test("collects phrases from all metadata sections", () => {
    const block = {
      alt_translations: [
        { primary_translation: "elegibilidad", alt_translation: "idoneidad" },
      ],
      terms_flagged_for_clarification: [
        { translation: "formulario" },
      ],
      back_translation_of_key_phrases: [
        { translation: "programa de asistencia" },
      ],
      glossary_cross_check: [
        { translation: "departamento" },
      ],
    };

    const phrases = collectFlaggedPhrases(block);

    expect(phrases.has("elegibilidad")).toBe(true);
    expect(phrases.has("idoneidad")).toBe(true);
    expect(phrases.has("formulario")).toBe(true);
    expect(phrases.has("programa de asistencia")).toBe(true);
    expect(phrases.has("departamento")).toBe(true);
  });

  test("returns empty set for block with no metadata", () => {
    expect(collectFlaggedPhrases({}).size).toBe(0);
  });
});

describe("classifyTab", () => {
  const flagged = new Set(["elegibilidad", "formulario"]);

  test("returns Reviewed for reviewed signals", () => {
    expect(classifyTab("reviewed_and_changed", "elegibilidad", flagged)).toBe(TAB_REVIEWED);
    expect(classifyTab("reviewed_and_accepted", "anything", new Set())).toBe(TAB_REVIEWED);
  });

  test("returns ModelFlagged when term overlaps with flagged phrase", () => {
    expect(classifyTab("no_sidebar_interaction", "elegibilidad", flagged)).toBe(TAB_MODEL_FLAGGED);
  });

  test("returns ModelFlagged for substring overlap", () => {
    const phrases = new Set(["programa de asistencia"]);
    expect(classifyTab("no_sidebar_interaction", "programa de asistencia médica", phrases)).toBe(TAB_MODEL_FLAGGED);
  });

  test("returns OtherChanges when no signal and no overlap", () => {
    expect(classifyTab("no_sidebar_interaction", "el", flagged)).toBe(TAB_OTHER_CHANGES);
    expect(classifyTab("changed_without_review", "la", new Set())).toBe(TAB_OTHER_CHANGES);
  });
});

describe("levenshtein", () => {
  test("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("returns correct distance for single edit", () => {
    expect(levenshtein("kitten", "sitten")).toBe(1);
  });

  test("returns length of other string when one is empty", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });

  test("works on arrays for word-level distance", () => {
    expect(levenshtein(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(levenshtein(["hello", "world"], ["hello", "earth"])).toBe(1);
  });
});

describe("computeMetrics", () => {
  test("computes acceptance rate from diffs", () => {
    const ai = [
      { id: "b1", translated_text: "unchanged" },
      { id: "b2", translated_text: "original" },
      { id: "b3", translated_text: "also unchanged" },
    ];
    const reviewed = [
      { translated_text: "unchanged" },
      { translated_text: "modified" },
      { translated_text: "also unchanged" },
    ];
    const diffs = diffBlocks(ai, reviewed);
    const metrics = computeMetrics(diffs, { provider: "claude", model: "sonnet" });

    expect(metrics.totalBlocks).toBe(3);
    expect(metrics.unchangedBlocks).toBe(2);
    expect(metrics.changedBlocks).toBe(1);
    expect(metrics.acceptanceRate).toBeCloseTo(2 / 3);
    expect(metrics.provider).toBe("claude");
    expect(metrics.model).toBe("sonnet");
  });

  test("includes per-block edit distances", () => {
    const ai = [{ id: "b1", translated_text: "Hola mundo" }];
    const reviewed = [{ translated_text: "Hola tierra" }];
    const diffs = diffBlocks(ai, reviewed);
    const metrics = computeMetrics(diffs, {});

    expect(metrics.perBlock).toHaveLength(1);
    expect(metrics.perBlock[0].characterEditDistance).toBeGreaterThan(0);
    expect(metrics.perBlock[0].wordEditDistance).toBe(1);
  });

  test("computes normalized edit distances", () => {
    const ai = [{ id: "b1", translated_text: "abcde" }];
    const reviewed = [{ translated_text: "abxde" }];
    const diffs = diffBlocks(ai, reviewed);
    const metrics = computeMetrics(diffs, {});

    expect(metrics.editDistance.normalizedCharacter).toBeCloseTo(1 / 5);
  });

  test("returns 100% acceptance when nothing changed", () => {
    const ai = [{ id: "b1", translated_text: "same" }];
    const reviewed = [{ translated_text: "same" }];
    const diffs = diffBlocks(ai, reviewed);
    const metrics = computeMetrics(diffs, {});

    expect(metrics.acceptanceRate).toBe(1);
    expect(metrics.editDistance.totalCharacter).toBe(0);
  });
});

describe("classifyBlockSignal", () => {
  test("returns reviewed_and_changed when checked and orphan", () => {
    const checks = { "alt_translations::0": true };
    const orphans = { "alt_translations::0": true };
    expect(classifyBlockSignal("b1", checks, orphans)).toBe("reviewed_and_changed");
  });

  test("returns reviewed_and_accepted when checked only", () => {
    const checks = { "alt_translations::0": true };
    expect(classifyBlockSignal("b1", checks, {})).toBe("reviewed_and_accepted");
  });

  test("returns changed_without_review when orphan only", () => {
    const orphans = { "terms_flagged_for_clarification::1": true };
    expect(classifyBlockSignal("b1", {}, orphans)).toBe("changed_without_review");
  });

  test("returns no_sidebar_interaction when neither", () => {
    expect(classifyBlockSignal("b1", {}, {})).toBe("no_sidebar_interaction");
  });
});

describe("captureFeedback HTTP handler", () => {
  const { captureFeedback } = require("../capture-feedback/index");

  test("returns 400 when no document ID provided", async () => {
    const req = { body: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await captureFeedback(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Provide documentId" })
    );
  });
});
