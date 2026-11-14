import { describe, expect, it } from "vitest";
import { defaultViewMode, exaggerationFor } from "./view-mode";

describe("defaultViewMode", () => {
  it("opens in Real world, because that is the view worth seeing", () => {
    expect(defaultViewMode()).toBe("real");
    expect(defaultViewMode(null)).toBe("real");
    expect(defaultViewMode({})).toBe("real");
    expect(defaultViewMode({ saveData: false })).toBe("real");
  });

  it("opens the lighter schematic view when the visitor has asked to save data", () => {
    expect(defaultViewMode({ saveData: true })).toBe("schematic");
  });
});

describe("exaggerationFor", () => {
  it("keeps Real world at true scale and the schematic at the gradient-legible 2x", () => {
    expect(exaggerationFor("real")).toBe(1);
    expect(exaggerationFor("schematic")).toBe(2);
  });
});
