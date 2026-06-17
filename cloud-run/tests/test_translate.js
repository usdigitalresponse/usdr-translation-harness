const { translate } = require("../translate/index.js");

describe("translate", () => {
  test("returns 400 when no extraction URL provided", async () => {
    const req = { body: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await translate(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns ok with placeholder response", async () => {
    const req = { body: { extractionJsonUrl: "https://drive.google.com/file/123" } };
    const res = { json: jest.fn() };

    await translate(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );
  });
});
