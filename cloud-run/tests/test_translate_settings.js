// The Settings tab reader in translate/loaders.js (shared limits; see
// extract/loaders.py for the same rules in Python).

const { settingsFromRows, SETTING_DEFAULTS, loadSettings } = require("../translate/loaders.js");

describe("settingsFromRows", () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, "log").mockImplementation(); });
  afterEach(() => logSpy.mockRestore());
  const logged = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

  test("reads values, keeps defaults for the rest, ignores extra columns and unknown names", () => {
    const settings = settingsFromRows([
      ["Setting", "Value", "Notes"], ["yellow_max_blocks", "250", "pilot"], ["something_else", "9"],
    ]);
    expect(settings.yellow_max_blocks).toBe(250);
    expect(settings.green_max_blocks).toBe(SETTING_DEFAULTS.green_max_blocks);
    expect(settings).not.toHaveProperty("something_else");
  });

  test.each(["0", "-1", "two", "", "1.5"])("invalid value %p: default, logged as an input problem", (bad) => {
    const settings = settingsFromRows([["setting", "value"], ["yellow_max_blocks", bad]]);
    expect(settings.yellow_max_blocks).toBe(SETTING_DEFAULTS.yellow_max_blocks);
    expect(logged()).toContain("settings");
  });

  test("wrong headers: all defaults, logged", () => {
    expect(settingsFromRows([["name", "number"]])).toEqual(SETTING_DEFAULTS);
    expect(logged()).toContain("needs 'setting' and 'value'");
  });

  test("defaults match Extract's", () => {
    const py = require("fs").readFileSync(require("path").join(__dirname, "../extract/loaders.py"), "utf-8");
    for (const [name, value] of Object.entries(SETTING_DEFAULTS)) {
      expect(py).toMatch(new RegExp(`"${name}": ${value},`));
    }
  });

  test("no Model Config sheet (local development): defaults", async () => {
    expect(await loadSettings()).toEqual(SETTING_DEFAULTS);
  });
});
