import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_LAYOUT,
  HOME_LAYOUT_KEY,
  HOME_LAYOUT_VERSION,
  WIDGET_CATALOGUE,
  WIDGET_TYPES,
  addWidget,
  canAddWidget,
  coerceSize,
  createLocalHomeLayoutStorage,
  isDefaultLayout,
  moveWidget,
  moveWidgetBy,
  nextWidgetId,
  parseHomeLayout,
  placeLayout,
  removeWidget,
  resetHomeLayout,
  resizeWidget,
  serialiseHomeLayout,
  stepSize,
  type HomeLayout,
  type LayoutMigration,
} from "./home-layout";

const types = (layout: HomeLayout) => layout.items.map((item) => item.type);

function fakeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    dump: () => ({ ...data }),
  };
}

function fakeEvents() {
  const handlers = new Set<(e: { key: string | null }) => void>();
  return {
    addEventListener: (_: "storage", h: (e: { key: string | null }) => void) => handlers.add(h),
    removeEventListener: (_: "storage", h: (e: { key: string | null }) => void) => handlers.delete(h),
    fire: (key: string | null) => handlers.forEach((h) => h({ key })),
    size: () => handlers.size,
  };
}

describe("catalogue", () => {
  it("gives every type a default size it actually supports", () => {
    for (const type of WIDGET_TYPES) {
      expect(WIDGET_CATALOGUE[type].sizes).toContain(WIDGET_CATALOGUE[type].defaultSize);
    }
  });

  it("reserves the full-width size for the countdown and the old full-width strips", () => {
    const full = WIDGET_TYPES.filter((t) => WIDGET_CATALOGUE[t].sizes.includes("full"));
    expect(full.sort()).toEqual(["countdown", "explore", "race-week", "tips"]);
  });

  it("flags every result-bearing widget for spoiler mode", () => {
    const revealing = WIDGET_TYPES.filter((t) => WIDGET_CATALOGUE[t].revealsResults);
    expect(revealing.sort()).toEqual(
      [
        "constructor-standings",
        "driver-standings",
        "last-race",
        "leader",
        "race-week",
        "season",
        "title-fight",
      ].sort()
    );
  });

  it("builds the default layout from today's home sections, in today's order", () => {
    expect(types(DEFAULT_HOME_LAYOUT)).toEqual([
      "countdown",
      "race-week",
      "leader",
      "last-race",
      "next-circuit",
      "explore",
      "tips",
    ]);
    expect(DEFAULT_HOME_LAYOUT.items[0].size).toBe("full");
  });
});

describe("coerceSize", () => {
  it("keeps a supported size", () => {
    expect(coerceSize("leader", "s")).toBe("s");
  });

  it("snaps an unsupported size to the nearest supported one", () => {
    expect(coerceSize("leader", "l")).toBe("m");
    expect(coerceSize("leader", "full")).toBe("m");
    expect(coerceSize("title-fight", "s")).toBe("m");
    expect(coerceSize("race-week", "s")).toBe("full");
  });

  it("breaks a tie towards the smaller size", () => {
    // tips supports m and full; l is one step from each.
    expect(coerceSize("tips", "l")).toBe("m");
  });

  it("falls back to the default size for garbage", () => {
    expect(coerceSize("season", "huge")).toBe("m");
    expect(coerceSize("season", 3)).toBe("m");
  });
});

describe("reducers", () => {
  it("adds at the end with the widget's default size", () => {
    const next = addWidget(DEFAULT_HOME_LAYOUT, "driver-standings");
    expect(types(next).at(-1)).toBe("driver-standings");
    expect(next.items.at(-1)).toMatchObject({ id: "driver-standings", size: "m" });
    expect(DEFAULT_HOME_LAYOUT.items).toHaveLength(7); // not mutated
  });

  it("adds at a requested index and coerces the requested size", () => {
    const next = addWidget(DEFAULT_HOME_LAYOUT, "title-fight", "s", 1);
    expect(next.items[1]).toMatchObject({ type: "title-fight", size: "m" });
  });

  it("refuses a second copy of a unique widget", () => {
    expect(canAddWidget(DEFAULT_HOME_LAYOUT, "leader")).toBe(false);
    expect(addWidget(DEFAULT_HOME_LAYOUT, "leader")).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("numbers ids when the plain id is taken", () => {
    const layout: HomeLayout = {
      version: HOME_LAYOUT_VERSION,
      items: [
        { id: "season", type: "leader", size: "m" },
        { id: "season-2", type: "leader", size: "s" },
      ],
    };
    expect(nextWidgetId(layout, "season")).toBe("season-3");
  });

  it("removes by id and is a no-op for an unknown id", () => {
    const next = removeWidget(DEFAULT_HOME_LAYOUT, "leader");
    expect(types(next)).not.toContain("leader");
    expect(removeWidget(DEFAULT_HOME_LAYOUT, "nope")).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("resizes within the supported set and ignores the rest", () => {
    const bigger = resizeWidget(DEFAULT_HOME_LAYOUT, "last-race", "l");
    expect(bigger.items.find((i) => i.id === "last-race")?.size).toBe("l");
    // Leader has no L: coerced to M, which it already is, so nothing changes.
    expect(resizeWidget(DEFAULT_HOME_LAYOUT, "leader", "l")).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("moves by index, clamping out-of-range targets", () => {
    const next = moveWidget(DEFAULT_HOME_LAYOUT, 0, 99);
    expect(types(next).at(-1)).toBe("countdown");
    expect(types(next)[0]).toBe("race-week");
    expect(moveWidget(DEFAULT_HOME_LAYOUT, 2, 2)).toBe(DEFAULT_HOME_LAYOUT);
    expect(moveWidget(DEFAULT_HOME_LAYOUT, -1, 2)).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("moves by a step, and is a no-op at either end", () => {
    const next = moveWidgetBy(DEFAULT_HOME_LAYOUT, "last-race", -1);
    expect(types(next).slice(2, 4)).toEqual(["last-race", "leader"]);
    expect(moveWidgetBy(DEFAULT_HOME_LAYOUT, "countdown", -1)).toBe(DEFAULT_HOME_LAYOUT);
    expect(moveWidgetBy(DEFAULT_HOME_LAYOUT, "tips", 1)).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("collapses back to the default reference when an edit is undone", () => {
    const moved = moveWidgetBy(DEFAULT_HOME_LAYOUT, "leader", 1);
    expect(moved).not.toBe(DEFAULT_HOME_LAYOUT);
    expect(moveWidgetBy(moved, "leader", -1)).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("resets to the default", () => {
    expect(resetHomeLayout()).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("steps sizes within the supported list", () => {
    expect(stepSize("countdown", "l", 1)).toBe("full");
    expect(stepSize("countdown", "s", -1)).toBeNull();
    expect(stepSize("title-fight", "m", -1)).toBeNull();
  });
});

describe("placeLayout (reflow)", () => {
  const order = (layout: HomeLayout, columns: number) =>
    placeLayout(layout.items, columns)
      .slice()
      .sort((a, b) => a.row - b.row || a.column - b.column)
      .map((p) => p.id);

  it("places the default layout without gaps on desktop and phone", () => {
    const desktop = placeLayout(DEFAULT_HOME_LAYOUT.items, 4);
    expect(desktop.map((p) => [p.id, p.row, p.column])).toEqual([
      ["countdown", 0, 0],
      ["race-week", 1, 0],
      ["leader", 2, 0],
      ["last-race", 2, 2],
      ["next-circuit", 2, 3],
      ["explore", 3, 0],
      ["tips", 4, 0],
    ]);
    const phone = placeLayout(DEFAULT_HOME_LAYOUT.items, 2);
    expect(phone.find((p) => p.id === "last-race")).toMatchObject({ row: 3, column: 0 });
    expect(phone.find((p) => p.id === "next-circuit")).toMatchObject({ row: 3, column: 1 });
  });

  it("keeps reading order equal to list order at every column count", () => {
    let layout = addWidget(DEFAULT_HOME_LAYOUT, "driver-standings", "l");
    layout = addWidget(layout, "ask-pitwall", "s");
    layout = addWidget(layout, "season", "s");
    layout = addWidget(layout, "constructor-standings", "m");
    const ids = layout.items.map((i) => i.id);
    expect(order(layout, 4)).toEqual(ids);
    expect(order(layout, 2)).toEqual(ids);
  });

  it("never back-fills a hole with a later widget (sparse, not dense)", () => {
    const layout: HomeLayout = {
      version: HOME_LAYOUT_VERSION,
      items: [
        { id: "a", type: "leader", size: "s" },
        { id: "b", type: "season", size: "l" },
        { id: "c", type: "next-circuit", size: "m" },
        { id: "d", type: "ask-pitwall", size: "s" },
      ],
    };
    const p = placeLayout(layout.items, 2);
    // a sits alone on row 0 (b is 2 wide), leaving column 1 empty; d must
    // not jump back into it.
    expect(p.find((x) => x.id === "a")).toMatchObject({ row: 0, column: 0 });
    expect(p.find((x) => x.id === "b")).toMatchObject({ row: 1, column: 0, rowSpan: 2 });
    expect(p.find((x) => x.id === "c")).toMatchObject({ row: 3, column: 0 });
    expect(p.find((x) => x.id === "d")).toMatchObject({ row: 4, column: 0 });
  });
});

describe("parseHomeLayout", () => {
  const stored = (items: unknown, version: unknown = HOME_LAYOUT_VERSION) =>
    JSON.stringify({ version, items });

  it("returns the default reference when nothing is stored", () => {
    expect(parseHomeLayout(null)).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("round-trips a custom layout", () => {
    const custom = addWidget(removeWidget(DEFAULT_HOME_LAYOUT, "tips"), "title-fight", "l");
    const parsed = parseHomeLayout(serialiseHomeLayout(custom));
    expect(parsed).toEqual(custom);
  });

  it("returns the default reference for a stored copy of the default", () => {
    expect(parseHomeLayout(serialiseHomeLayout(DEFAULT_HOME_LAYOUT))).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("falls back to the default for corrupt JSON and wrong shapes", () => {
    for (const raw of ["{not json", "null", "42", '"layout"', "[]", "{}", stored("nope")]) {
      expect(parseHomeLayout(raw)).toBe(DEFAULT_HOME_LAYOUT);
    }
  });

  it("drops unknown widget types and keeps the rest in order", () => {
    const parsed = parseHomeLayout(
      stored([
        { id: "x", type: "weather-radar", size: "m" },
        { id: "leader", type: "leader", size: "s" },
        null,
        "season",
        { id: "season", type: "season", size: "l" },
      ])
    );
    expect(parsed.items).toEqual([
      { id: "leader", type: "leader", size: "s" },
      { id: "season", type: "season", size: "l" },
    ]);
  });

  it("coerces unsupported sizes", () => {
    const parsed = parseHomeLayout(
      stored([
        { id: "a", type: "race-week", size: "s" },
        { id: "b", type: "title-fight", size: "giant" },
      ])
    );
    expect(parsed.items.map((i) => i.size)).toEqual(["full", "m"]);
  });

  it("drops duplicate unique widgets and repairs bad or clashing ids", () => {
    const parsed = parseHomeLayout(
      stored([
        { id: "dup", type: "leader", size: "m" },
        { id: "dup", type: "season", size: "m" },
        { type: "explore", size: "full" },
        { id: "z", type: "leader", size: "s" },
      ])
    );
    expect(parsed.items).toEqual([
      { id: "dup", type: "leader", size: "m" },
      { id: "season", type: "season", size: "m" },
      { id: "explore", type: "explore", size: "full" },
    ]);
  });

  it("keeps an empty layout — removing everything is a real choice", () => {
    const parsed = parseHomeLayout(stored([]));
    expect(parsed.items).toEqual([]);
    expect(isDefaultLayout(parsed)).toBe(false);
  });

  describe("versions", () => {
    it("refuses data from a newer version rather than guessing", () => {
      expect(parseHomeLayout(stored([{ id: "a", type: "leader", size: "s" }], 2))).toBe(
        DEFAULT_HOME_LAYOUT
      );
    });

    it("refuses a missing or non-integer version", () => {
      expect(parseHomeLayout(JSON.stringify({ items: [] }))).toBe(DEFAULT_HOME_LAYOUT);
      expect(parseHomeLayout(stored([], "1"))).toBe(DEFAULT_HOME_LAYOUT);
      expect(parseHomeLayout(stored([], 0.5))).toBe(DEFAULT_HOME_LAYOUT);
    });

    it("refuses an older version that has no migration path", () => {
      expect(parseHomeLayout(stored([], 0))).toBe(DEFAULT_HOME_LAYOUT);
    });

    it("walks an older version through the migration chain", () => {
      // A hypothetical v0 that stored `widgets: [[type, size]]` tuples.
      const migrations: Record<number, LayoutMigration> = {
        0: (data) => ({
          version: 1,
          items: (data.widgets as [string, string][]).map(([type, size]) => ({
            id: type,
            type,
            size,
          })),
        }),
      };
      const raw = JSON.stringify({ version: 0, widgets: [["leader", "s"], ["ghost", "m"]] });
      expect(parseHomeLayout(raw, migrations).items).toEqual([
        { id: "leader", type: "leader", size: "s" },
      ]);
    });
  });
});

describe("createLocalHomeLayoutStorage", () => {
  it("loads, saves and removes the key when saving the default", () => {
    const store = fakeStorage();
    const storage = createLocalHomeLayoutStorage({ getStorage: () => store, events: null });
    expect(storage.load()).toBe(DEFAULT_HOME_LAYOUT);

    const custom = removeWidget(DEFAULT_HOME_LAYOUT, "tips");
    storage.save(custom);
    expect(JSON.parse(store.dump()[HOME_LAYOUT_KEY]).version).toBe(HOME_LAYOUT_VERSION);
    expect(storage.load()).toEqual(custom);

    storage.save(DEFAULT_HOME_LAYOUT);
    expect(store.dump()).toEqual({});
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const storage = createLocalHomeLayoutStorage({ getStorage: () => throwing, events: null });
    expect(storage.load()).toBe(DEFAULT_HOME_LAYOUT);
    expect(() => storage.save(removeWidget(DEFAULT_HOME_LAYOUT, "tips"))).not.toThrow();
  });

  it("reports changes from other tabs to our key only", () => {
    const events = fakeEvents();
    const storage = createLocalHomeLayoutStorage({ getStorage: () => fakeStorage(), events });
    let calls = 0;
    const unsubscribe = storage.subscribe(() => {
      calls += 1;
    });
    events.fire("apex.watch.density");
    events.fire(HOME_LAYOUT_KEY);
    events.fire(null); // localStorage.clear()
    expect(calls).toBe(2);
    unsubscribe();
    expect(events.size()).toBe(0);
  });
});
