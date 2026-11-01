import { describe, expect, it } from "vitest";
import { buildProgressionRows } from "./championship-progression";
import {
  buildProgressionGeometry,
  niceTicks,
  pickLabelIndices,
  progressionSeriesLimit,
  spreadLabels,
} from "./share-chart";

const BOX = { width: 600, height: 300, padLeft: 40, padRight: 100, padTop: 10, padBottom: 30 };

describe("niceTicks", () => {
  it("steps in 1/2/2.5/5 × 10ⁿ from zero to at least the max", () => {
    expect(niceTicks(100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(340)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(578)).toEqual([0, 200, 400, 600]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
  });

  it("gives a usable axis when nobody has scored", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  it("always covers the max", () => {
    for (const max of [1, 3, 13, 99, 101, 249, 251, 999, 1234]) {
      const ticks = niceTicks(max);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
    }
  });
});

describe("pickLabelIndices", () => {
  it("shows every label when they fit", () => {
    expect(pickLabelIndices(3, 6)).toEqual([0, 1, 2]);
  });

  it("always keeps the first and last", () => {
    const picked = pickLabelIndices(23, 6);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(22);
    expect(picked.length).toBeLessThanOrEqual(6);
  });

  it("is total at the edges", () => {
    expect(pickLabelIndices(0, 6)).toEqual([]);
    expect(pickLabelIndices(5, 1)).toEqual([4]);
  });
});

describe("spreadLabels", () => {
  it("leaves labels that do not collide where they are", () => {
    expect(spreadLabels([{ id: "a", y: 10 }, { id: "b", y: 100 }], { gap: 20, min: 0, max: 200 })).toEqual({
      a: 10,
      b: 100,
    });
  });

  it("pushes colliding labels apart without reordering them", () => {
    const out = spreadLabels(
      [
        { id: "a", y: 50 },
        { id: "b", y: 52 },
        { id: "c", y: 51 },
      ],
      { gap: 20, min: 0, max: 200 }
    );
    expect(out.a).toBe(50);
    expect(out.c).toBe(70);
    expect(out.b).toBe(90);
  });

  it("pulls the stack back up when it runs off the bottom", () => {
    const out = spreadLabels(
      [
        { id: "a", y: 195 },
        { id: "b", y: 198 },
        { id: "c", y: 199 },
      ],
      { gap: 20, min: 0, max: 200 }
    );
    expect(out.c).toBe(200);
    expect(out.b).toBe(180);
    expect(out.a).toBe(160);
  });

  it("keeps every gap at least the minimum", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, y: 100 + (i % 3) }));
    const out = Object.values(spreadLabels(items, { gap: 18, min: 0, max: 400 })).sort((a, b) => a - b);
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(17.9);
  });
});

describe("buildProgressionGeometry", () => {
  const logs = {
    ant: { entries: [{ round: 1, shortName: "Australian GP", points: 18 }, { round: 2, shortName: "Chinese GP", points: 25 }] },
    rus: { entries: [{ round: 1, shortName: "Australian GP", points: 25 }, { round: 2, shortName: "Chinese GP", points: 18 }] },
    ham: { entries: [{ round: 2, shortName: "Chinese GP", points: 15 }] },
  };
  const series = [
    { id: "ant", label: "ANT", colorHex: "#00D7B6" },
    { id: "rus", label: "RUS", colorHex: "#00D7B6" },
    { id: "ham", label: "HAM", colorHex: "#E80020" },
  ];
  const rows = buildProgressionRows(["ant", "rus", "ham"], logs);

  it("maps the first round to the left edge and the last to the right", () => {
    const g = buildProgressionGeometry(rows, series, BOX);
    const ant = g.paths[0];
    expect(ant.points[0].x).toBe(40);
    expect(ant.points[1].x).toBe(500);
    expect(ant.d.startsWith("M40 ")).toBe(true);
  });

  it("scales y to the nice top tick", () => {
    const g = buildProgressionGeometry(rows, series, BOX);
    // Max is 43 → ticks to 50; the bottom of the plot is 270.
    expect(g.yTicks[0]).toEqual({ value: 0, y: 270 });
    expect(g.yTicks[g.yTicks.length - 1].value).toBe(50);
    expect(g.paths[0].total).toBe(43);
  });

  it("dashes the second entity of a shared colour, as the page chart does", () => {
    const g = buildProgressionGeometry(rows, series, BOX);
    expect(g.paths.map((p) => p.dashed)).toEqual([false, true, false]);
  });

  it("keeps a flat line at zero for a round an entity missed", () => {
    const g = buildProgressionGeometry(rows, series, BOX);
    expect(g.paths[2].points[0].y).toBe(270);
  });

  it("centres a single-round season instead of dividing by zero", () => {
    const one = buildProgressionRows(["ant"], { ant: { entries: [{ round: 1, shortName: "AUS", points: 25 }] } });
    const g = buildProgressionGeometry(one, series.slice(0, 1), BOX);
    expect(g.paths[0].points[0].x).toBe(270);
    expect(g.xLabels).toEqual([{ label: "AUS", x: 270 }]);
  });

  it("is deterministic", () => {
    expect(buildProgressionGeometry(rows, series, BOX)).toEqual(buildProgressionGeometry(rows, series, BOX));
  });

  it("produces no NaN anywhere", () => {
    const g = buildProgressionGeometry(rows, series, BOX);
    expect(JSON.stringify(g)).not.toMatch(/NaN|Infinity/);
  });
});

describe("progressionSeriesLimit", () => {
  it("draws ten drivers and the whole constructors' field", () => {
    expect(progressionSeriesLimit("drivers")).toBe(10);
    expect(progressionSeriesLimit("constructors")).toBe(11);
  });
});
