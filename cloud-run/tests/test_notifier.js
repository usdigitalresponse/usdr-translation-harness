const { notifyDocCreated, notifyDocFailed, DOC_BASE_URL, LOG_PREFIX } = require("../translate/notifier");

describe("notifyDocCreated", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test("sends message with doc link to webhook", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.example.com/webhook";

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://chat.example.com/webhook",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("doc123"),
      })
    );

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain("Translation ready");
    expect(body.text).toContain("test.pdf");
    expect(body.text).toContain("anthropic/claude-sonnet-4-6");
    expect(body.text).toContain(`${DOC_BASE_URL}doc123`);
  });

  test("warns and skips the post when webhook URL is not set", async () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_CHAT_WEBHOOK_URL is unset")
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOG_PREFIX));
    warnSpy.mockRestore();
  });
});

describe("notifyDocFailed", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test("sends failure message to webhook", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.example.com/webhook";

    await notifyDocFailed({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      error: "User rate limit exceeded",
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain("failed");
    expect(body.text).toContain("test.pdf");
    expect(body.text).toContain("User rate limit exceeded");
    expect(body.text).toContain("workflow owner");
  });

  test("warns and skips the post when webhook URL is not set", async () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await notifyDocFailed({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      error: "some error",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_CHAT_WEBHOOK_URL is unset")
    );
    warnSpy.mockRestore();
  });

  test("logs error but does not throw when webhook fails", async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.example.com/webhook";
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await notifyDocFailed({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      error: "some error",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Chat webhook failed")
    );
    errorSpy.mockRestore();
  });
});

describe("postToChat status handling", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GOOGLE_CHAT_WEBHOOK_URL = "https://chat.example.com/webhook";
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test("logs a permanent failure when Chat rejects with 403", async () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "This organization's administrator has disabled Chat apps",
        status: "PERMISSION_DENIED",
      },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: jest.fn().mockResolvedValue(body),
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    const logged = errorSpy.mock.calls[0][0];
    expect(logged).toContain(LOG_PREFIX);
    expect(logged).toContain("403 Forbidden");
    expect(logged).toContain("will keep failing");
    expect(logged).toContain("disabled Chat apps");
    errorSpy.mockRestore();
  });

  test("logs a transient failure without the permanent wording on 500", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("upstream boom"),
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    const logged = errorSpy.mock.calls[0][0];
    expect(logged).toContain("500 Internal Server Error");
    expect(logged).toContain("upstream boom");
    expect(logged).not.toContain("will keep failing");
    errorSpy.mockRestore();
  });

  test("does not read the body or log on success", async () => {
    const text = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    expect(text).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
