import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Regression guard for the CSP the share sheet depends on.
 *
 * Three image sources, all already allowed, all of which fail silently if a
 * later tidy-up narrows `img-src`:
 *
 *   - `blob:` — the sheet's preview `<img>` and its Download link point at
 *     `URL.createObjectURL` of the PNG;
 *   - `data:` — the answer card decodes the chart snapshot from a
 *     `data:image/svg+xml` URL before drawing it onto the canvas;
 *   - `'self'` — nothing in the sheet loads the `/api/share/**` routes as an
 *     image directly (they are fetched), but a link preview or an <img> on
 *     another page will.
 *
 * A refused image is the same quiet failure `csp-media.test.ts` documents for
 * audio: a broken preview with nothing in the network panel.
 */
async function directive(name: string): Promise<string | undefined> {
  const groups = await nextConfig.headers!();
  const csp = groups.flatMap((g) => g.headers).find((h) => h.key === "Content-Security-Policy")!.value;
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
}

describe("Content-Security-Policy: share cards", () => {
  it("lets the share preview and chart snapshot load from blob: and data:", async () => {
    const img = await directive("img-src");
    expect(img).toBeDefined();
    expect(img).toContain("'self'");
    expect(img).toContain("blob:");
    expect(img).toContain("data:");
  });

  it("keeps the snapshot frame inside the frame-src the visible chart uses", async () => {
    // The snapshot is a srcdoc frame like the visible one; it needs no more.
    expect(await directive("frame-src")).toBe("frame-src 'self'");
  });
});
