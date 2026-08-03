const { notifyDocCreated, notifyDocFailed, DOC_BASE_URL } = require("../translate/notifier");

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

  test("skips silently when webhook URL is not set", async () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;

    await notifyDocCreated({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      docId: "doc123",
    });

    expect(fetch).not.toHaveBeenCalled();
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

  test("skips silently when webhook URL is not set", async () => {
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;

    await notifyDocFailed({
      sourceFileName: "test.pdf",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      error: "some error",
    });

    expect(fetch).not.toHaveBeenCalled();
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
