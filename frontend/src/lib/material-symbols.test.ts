import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, MATERIAL_SYMBOLS_HREF } from "./material-symbols";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** Icon names drawn in source: the leading word or string literals inside an
 * element with the icon class, plus `icon: "x"` / `icon="x"` props. */
function usedIconNames(): Set<string> {
  const span = /material-symbols-outlined[^>]*>([\s\S]*?)<\//g;
  const lead = /^\s*([a-z][a-z0-9_]*)\s*(?:$|[{<])/;
  const lit = /["']([a-z][a-z0-9_]*)["']/g;
  const prop = /\bicon\w*\s*[:=]\s*\{?\s*["']([a-z][a-z0-9_]*)["']/g;
  const used = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(span)) {
      const body = m[1];
      const first = body.match(lead);
      if (first) used.add(first[1]);
      for (const l of body.matchAll(lit)) used.add(l[1]);
    }
    for (const p of text.matchAll(prop)) used.add(p[1]);
  }
  return used;
}

describe("Material Symbols subset", () => {
  it("includes every icon the source draws", () => {
    const subset = new Set<string>(ICON_NAMES);
    // String literals inside an icon element that are not icons (CSS class
    // fragments and the like) would appear here too; none do today, and a new
    // one is better reviewed than silently allowed.
    const used = usedIconNames();
    // Guards the scan itself: an over-narrow regex would find nothing and pass.
    expect(used.size).toBeGreaterThan(40);
    expect(used.has("trophy") && used.has("more_horiz")).toBe(true);
    const missing = [...used].filter((name) => !subset.has(name));
    expect(missing).toEqual([]);
  });

  it("requests the names sorted, as Google Fonts requires", () => {
    const names = new URL(MATERIAL_SYMBOLS_HREF).searchParams.get("icon_names")!.split(",");
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
