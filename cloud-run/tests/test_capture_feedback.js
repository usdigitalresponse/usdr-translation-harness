const { captureFeedback } = require("../capture-feedback/index.js");

describe("captureFeedback", () => {
  test("returns 400 when no document ID provided", async () => {
    const req = { body: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await captureFeedback(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns ok with placeholder response", async () => {
    const req = { body: { documentId: "abc123" } };
    const res = { json: jest.fn() };

    await captureFeedback(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );
  });
});
