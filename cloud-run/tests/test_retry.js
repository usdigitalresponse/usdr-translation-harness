const { withRetry } = require("../translate/retry");

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { retries: 1, delayMs: 10 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and returns result on second attempt", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { retries: 1, delayMs: 10 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws after exhausting retries", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("persistent"));

    await expect(withRetry(fn, { retries: 1, delayMs: 10 })).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws immediately with zero retries", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("fail"));

    await expect(withRetry(fn, { retries: 0, delayMs: 10 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("uses default options when none provided", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("logs warning on retry", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    await withRetry(fn, { retries: 1, delayMs: 10 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Attempt 1 failed")
    );
    warnSpy.mockRestore();
  });
});
