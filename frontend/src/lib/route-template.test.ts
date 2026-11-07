import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Template from "@/app/template";

/**
 * Guards the hydration fix in `app/template.tsx`: its markup must not depend on
 * anything the server cannot know (prefers-reduced-motion), or reduced-motion
 * visitors hydrate into a mismatch. Reduced motion is handled in CSS instead.
 */
describe("route template", () => {
  it("renders a static wrapper with no inline opacity", () => {
    const html = renderToStaticMarkup(createElement(Template, null, "page"));
    expect(html).toBe('<div class="route-fade">page</div>');
  });

  it("does not decide motion in JS", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/template.tsx", import.meta.url)),
      "utf8",
    );
    // Imports and directives only: the doc comment explains the old hook.
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/^["']use client["']/m);
  });

  it("disables the fade for reduced-motion visitors in CSS", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../app/globals.css", import.meta.url)),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.route-fade\s*\{\s*animation:\s*none;/,
    );
  });
});
