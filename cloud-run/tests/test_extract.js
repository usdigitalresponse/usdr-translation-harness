const { extract } = require("../extract/index.js");

describe("extract", () => {
  test("returns 400 when no PDF provided", async () => {
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

  test("returns ok with placeholder response", async () => {
    const req = { body: { pdfBase64: "dGVzdA==" } };
    const res = { json: jest.fn() };

    await extract(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );
  });
});
