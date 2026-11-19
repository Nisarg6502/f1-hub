import { describe, expect, it } from "vitest";
import { orbitHint } from "./track-viewer-hints";

describe("orbitHint", () => {
  it("talks about clicking and scrolling for a mouse", () => {
    expect(orbitHint(false)).toBe("Click to orbit · scroll to zoom once active");
  });

  it("talks about tapping, dragging and pinching for a touchscreen", () => {
    expect(orbitHint(true)).toBe("Tap to start · drag to orbit · pinch to zoom");
  });

  it("never tells a touch user to scroll or click", () => {
    expect(orbitHint(true)).not.toMatch(/click|scroll/i);
  });
});
