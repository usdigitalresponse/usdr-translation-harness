const { extract } = require("../extract/index.js");

describe("extract", () => {
  test("returns 400 when no fileId provided", async () => {
    const req = { body: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await extract(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test("returns 202 accepted with fileId", async () => {
    const req = { body: { fileId: "abc123", fileName: "test.pdf" } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await extract(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        fileId: "abc123",
        fileName: "test.pdf",
      })
    );
  });
});
