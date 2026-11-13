// Chunked translation of large documents (translate/chunking.js) and the
// completeness check on model output (translate/index.js).

const { planChunks, mergeChunkTranslations, CHUNK_SIZE, MAX_PARALLEL_CHUNKS } = require("../translate/chunking.js");

jest.mock("../translate/loaders.js", () => ({
  loadConfig: jest.fn(),
  loadStatuteUrls: jest.fn(() => ({})),
  writeOutput: jest.fn(),
  logTranslationResult: jest.fn(),
  stripExtension: (name) => name.replace(/\.[^.]+$/, ""),
}));
jest.mock("../translate/doc-writer.js", () => ({ createTranslationDoc: jest.fn() }));
jest.mock("../translate/notifier.js", () => ({ notifyDocCreated: jest.fn(), notifyDocFailed: jest.fn(), DOC_BASE_URL: "" }));
jest.mock("../translate/llm.js", () => ({ ...jest.requireActual("../translate/llm.js"), callLlm: jest.fn() }));

const { callLlm } = require("../translate/llm.js");
const { writeOutput } = require("../translate/loaders.js");
const { translateDocument, findMissingBlockIds, incompleteTranslationMessage,
  isRetryableModelFailure, AlreadyBilledError } = require("../translate/index.js");

/** n blocks b1..bn; ids listed in `context` are translate:false. */
function blocks(n, context = []) {
  return Array.from({ length: n }, (_, i) => {
    const id = `b${i + 1}`;
    return { id, text: `text ${i + 1}`, translate: !context.includes(id) };
  });
}

describe("planChunks", () => {
  test("a document at or under the chunk size is one chunk", () => {
    const chunks = planChunks(blocks(10), 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].expectedBlockIds).toHaveLength(10);
  });

  test("chunking off (0) is one chunk", () => {
    expect(planChunks(blocks(500), 0)).toHaveLength(1);
  });

  test("splits by translatable blocks into contiguous ranges covering every block", () => {
    const all = blocks(25);
    const chunks = planChunks(all, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks.flatMap((c) => c.blocks)).toEqual(all);
    expect(chunks.map((c) => c.expectedBlockIds.length)).toEqual([9, 9, 7]);
  });

  test("context (translate:false) blocks stay with their neighbours but don't count", () => {
    const chunks = planChunks(blocks(6, ["b2", "b3"]), 2);
    expect(chunks.map((c) => c.blocks.map((b) => b.id))).toEqual([["b1", "b2", "b3", "b4"], ["b5", "b6"]]);
    expect(chunks.map((c) => c.expectedBlockIds)).toEqual([["b1", "b4"], ["b5", "b6"]]);
  });

  test("never more than the parallel limit: chunks grow instead", () => {
    const chunks = planChunks(blocks(1000), 110, 4);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.expectedBlockIds.length)).toEqual([250, 250, 250, 250]);
  });

  test("defaults are the tested values", () => {
    expect(CHUNK_SIZE).toBe(110);
    expect(MAX_PARALLEL_CHUNKS).toBe(4);
  });
});

describe("mergeChunkTranslations", () => {
  test("joins blocks in order and combines distinct notes", () => {
    const merged = mergeChunkTranslations([
      { blocks: [{ id: "b1" }], metadata: { source_language: "en", overall_notes: "Note A" } },
      { blocks: [{ id: "b2" }], metadata: { source_language: "en", overall_notes: "Note A" } },
      { blocks: [{ id: "b3" }], metadata: { overall_notes: " Note B " } },
    ]);
    expect(merged.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(merged.metadata).toEqual({ source_language: "en", overall_notes: "Note A\n\nNote B" });
  });

  test("tolerates a chunk with no blocks or metadata", () => {
    expect(mergeChunkTranslations([{}, { blocks: [{ id: "b1" }] }])).toEqual({ blocks: [{ id: "b1" }], metadata: { overall_notes: "" } });
  });
});

describe("findMissingBlockIds / incompleteTranslationMessage", () => {
  test("lists expected blocks the model didn't return", () => {
    expect(findMissingBlockIds({ blocks: [{ id: "b1" }, { id: "b3" }] }, ["b1", "b2", "b3"])).toEqual(["b2"]);
    expect(findMissingBlockIds({}, ["b1"])).toEqual(["b1"]);
    expect(findMissingBlockIds({ blocks: [{ id: "b1" }] }, ["b1"])).toEqual([]);
  });

  test("message counts what came back and shows a few missing ids", () => {
    const missing = ["b4", "b5", "b6", "b7", "b8", "b9", "b10"];
    expect(incompleteTranslationMessage(missing, 10, "end_turn"))
      .toBe("Incomplete translation: 3 of 10 blocks returned (missing b4, b5, b6, b7, b8, +2 more; stop_reason=end_turn)");
  });
});

describe("translateDocument", () => {
  const usage = (n) => ({ input_tokens: n, output_tokens: n, thinking_tokens: 0, llm_backend: "vertex" });
  const promptForBlocks = (bs) => `prompt for ${bs.map((b) => b.id).join(",")}`;

  beforeEach(() => {
    callLlm.mockReset();
    writeOutput.mockReset();
    jest.spyOn(console, "log").mockImplementation();
  });
  afterEach(() => console.log.mockRestore());

  test("small documents are one call with the full prompt", async () => {
    callLlm.mockResolvedValue({ text: "{}", usage: usage(1), stop_reason: "end_turn" });
    await translateDocument({ provider: "anthropic", model: "m", chunkSize: 10, prompt: "FULL",
      extractionBlocks: blocks(5), promptForBlocks, saveRawChunk: jest.fn() });
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(callLlm).toHaveBeenCalledWith("anthropic", "m", "FULL", { effort: undefined });
  });

  test("large documents are translated per chunk, merged, with usage summed", async () => {
    callLlm.mockImplementation(async (_p, _m, prompt) => {
      const ids = prompt.replace("prompt for ", "").split(",");
      return { text: JSON.stringify({ blocks: ids.map((id) => ({ id })), metadata: {} }), usage: usage(10), stop_reason: "end_turn" };
    });
    const result = await translateDocument({ provider: "anthropic", model: "m", effort: "high", chunkSize: 2, prompt: "FULL",
      extractionBlocks: blocks(5), promptForBlocks, saveRawChunk: jest.fn() });
    expect(callLlm).toHaveBeenCalledTimes(3);
    expect(result.text.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    expect(result.usage).toEqual(expect.objectContaining({ input_tokens: 30, output_tokens: 30, chunks: 3 }));
    expect(result.stop_reason).toBe("end_turn");
  });

  test("a chunk with invalid JSON saves its raw output and fails the run", async () => {
    callLlm.mockResolvedValue({ text: "not json", usage: usage(1), stop_reason: "max_tokens" });
    const saveRawChunk = jest.fn();
    await expect(translateDocument({ provider: "anthropic", model: "m", chunkSize: 2, prompt: "FULL",
      extractionBlocks: blocks(4), promptForBlocks, saveRawChunk }))
      .rejects.toThrow(/invalid JSON \(chunk \d\/2, stop_reason=max_tokens\)/);
    expect(saveRawChunk).toHaveBeenCalled();
  });

  describe("a failed chunk: retry only if no chunk did any work", () => {
    const Anthropic = jest.requireActual("../translate/node_modules/@anthropic-ai/sdk");
    const rateLimited = () => Anthropic.APIError.generate(429, { type: "error", message: "rate limited" }, "rate limited", new Headers());
    const ok = (prompt) => {
      const ids = prompt.replace("prompt for ", "").split(",");
      return { text: JSON.stringify({ blocks: ids.map((id) => ({ id })), metadata: {} }), usage: usage(10), stop_reason: "end_turn" };
    };
    const run = () => translateDocument({ provider: "anthropic", model: "m", chunkSize: 2, prompt: "FULL",
      extractionBlocks: blocks(4), promptForBlocks, saveRawChunk: jest.fn() });

    test("every chunk failed temporarily: the error stays retryable", async () => {
      const err = rateLimited();
      callLlm.mockRejectedValue(err);
      await expect(run()).rejects.toBe(err);
      expect(isRetryableModelFailure(err)).toBe(true);
    });

    test("one chunk rate limited after another finished: not retryable (the finished chunk is billed)", async () => {
      callLlm
        .mockImplementationOnce(async (_p, _m, prompt) => ok(prompt))
        .mockRejectedValueOnce(rateLimited());
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(AlreadyBilledError);
      expect(err.message).toMatch(/^429 .*\(1 of 2 chunks failed\)$/);
      expect(isRetryableModelFailure(err)).toBe(false);
    });

    test("waits for every chunk before failing (they keep running and billing anyway)", async () => {
      let finished = false;
      callLlm
        .mockRejectedValueOnce(new Error("Request timed out."))
        .mockImplementationOnce(async (_p, _m, prompt) => { await new Promise((r) => setTimeout(r, 20)); finished = true; return ok(prompt); });
      await expect(run()).rejects.toThrow("Request timed out. (1 of 2 chunks failed)");
      expect(finished).toBe(true);
    });
  });
});

describe("geminiThinkingLevel", () => {
  const { geminiThinkingLevel } = jest.requireActual("../translate/llm.js");

  test.each([["low", "LOW"], [" Medium ", "MEDIUM"], ["HIGH", "HIGH"]])("accepts %p", (effort, level) => {
    expect(geminiThinkingLevel(effort)).toBe(level);
  });

  test("rejects values Gemini doesn't support", () => {
    expect(() => geminiThinkingLevel("max")).toThrow(/Unsupported Gemini effort "max"/);
  });
});
