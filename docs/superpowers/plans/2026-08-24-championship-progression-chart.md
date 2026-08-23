# Championship Progression Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a line chart to `/standings` showing cumulative points by round for every driver (Drivers tab) or constructor (Constructors tab), with a click-to-highlight legend and a tooltip showing points gained, finish position, and gap to the leader for that round.

**Architecture:** A pure data-shaping function (`buildProgressionRows`) in `src/lib/championship-progression.ts` turns per-entity round logs into Recharts-ready rows; a new presentational component (`ChampionshipProgressionChart`) renders them. Constructor round logs are a new server-side derivation (`buildConstructorSeasonLogs`) parallel to the existing `buildDriverSeasonLogs`, computed from data `standings/page.tsx` already fetches — no new network request anywhere in this feature.

**Tech Stack:** Next.js (App Router), React, Recharts (already a dependency, used by `tire-stints-chart.tsx` and `lap-position-chart.tsx`), Vitest for the pure `lib/` logic (per `frontend/vitest.config.ts`, only `src/lib/**/*.test.ts` runs — components are verified in a real browser, not unit tested).

## Global Constraints

- Only `src/lib/**/*.test.ts` is picked up by `vitest run` (see `frontend/vitest.config.ts`) — all new test coverage must live under `src/lib/`, not beside the component.
- No new network request: constructor logs must be derived from the `rounds`/`sprints` arrays `standings/page.tsx` already loads for the existing driver season logs.
- Team colors come from `getTeamColor` (`src/lib/team-colors.ts`) — do not hardcode hex values in the new component.
- Follow the existing code style: no comments explaining *what* code does, only non-obvious *why* (see any existing file in this repo for the house style).

---

### Task 1: `buildConstructorSeasonLogs`

**Files:**
- Modify: `frontend/src/lib/season-results.ts`
- Test: `frontend/src/lib/season-results.test.ts` (new file)

**Interfaces:**
- Produces: `export interface ConstructorRoundEntry { round: number; raceName: string; shortName: string; points: number; }`, `export interface ConstructorSeasonLog { constructorId: string; entries: ConstructorRoundEntry[]; }`, `export function buildConstructorSeasonLogs(constructors: ConstructorStanding[], rounds: SeasonRoundResults[], sprints: SeasonSprintResults[] = []): Record<string, ConstructorSeasonLog>`

- [ ] **Step 1: Write the failing tests**

Add to a new `frontend/src/lib/season-results.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildConstructorSeasonLogs,
  type SeasonRoundResults,
  type SeasonSprintResults,
} from "./season-results";
import type { ConstructorStanding, RaceResult } from "./api";

function constructorStanding(id: string, name: string): ConstructorStanding {
  return {
    position: "1",
    points: "0",
    wins: "0",
    Constructor: { constructorId: id, name, nationality: "—" },
  };
}

function result(driverId: string, constructorId: string, points: string): RaceResult {
  return {
    Driver: { driverId },
    Constructor: { constructorId, name: constructorId },
    points,
  };
}

describe("buildConstructorSeasonLogs", () => {
  it("sums both drivers' points into one entry per round", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Bahrain Grand Prix",
        results: [
          result("max", "red_bull", "25"),
          result("perez", "red_bull", "18"),
          result("hamilton", "mercedes", "15"),
        ],
        qualifying: [],
      },
    ];

    const logs = buildConstructorSeasonLogs(
      [constructorStanding("red_bull", "Red Bull"), constructorStanding("mercedes", "Mercedes")],
      rounds
    );

    expect(logs.red_bull.entries).toEqual([
      { round: 1, raceName: "Bahrain Grand Prix", shortName: "Bahrain", points: 43 },
    ]);
    expect(logs.mercedes.entries[0].points).toBe(15);
  });

  it("adds sprint points into the same round's entry", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Chinese Grand Prix",
        results: [result("max", "red_bull", "25")],
        qualifying: [],
      },
    ];
    const sprints: SeasonSprintResults[] = [
      { round: "1", results: [result("max", "red_bull", "8")] },
    ];

    const logs = buildConstructorSeasonLogs(
      [constructorStanding("red_bull", "Red Bull")],
      rounds,
      sprints
    );

    expect(logs.red_bull.entries[0].points).toBe(33);
  });

  it("skips a round with no results for that constructor rather than inserting a zero", () => {
    const rounds: SeasonRoundResults[] = [
      { round: "1", raceName: "Bahrain Grand Prix", results: [result("max", "red_bull", "25")], qualifying: [] },
      { round: "2", raceName: "Saudi Arabian Grand Prix", results: [], qualifying: [] },
    ];

    const logs = buildConstructorSeasonLogs([constructorStanding("red_bull", "Red Bull")], rounds);

    expect(logs.red_bull.entries).toHaveLength(1);
  });

  it("orders entries ascending by round regardless of input order", () => {
    const rounds: SeasonRoundResults[] = [
      { round: "3", raceName: "Round 3", results: [result("max", "red_bull", "10")], qualifying: [] },
      { round: "1", raceName: "Round 1", results: [result("max", "red_bull", "25")], qualifying: [] },
    ];

    const logs = buildConstructorSeasonLogs([constructorStanding("red_bull", "Red Bull")], rounds);

    expect(logs.red_bull.entries.map((e) => e.round)).toEqual([1, 3]);
  });

  it("skips a constructor with no constructorId", () => {
    const badConstructor: ConstructorStanding = {
      position: "1",
      points: "0",
      wins: "0",
      Constructor: { name: "Unknown" },
    };

    const logs = buildConstructorSeasonLogs([badConstructor], []);

    expect(Object.keys(logs)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/lib/season-results.test.ts`
Expected: FAIL — `buildConstructorSeasonLogs is not a function` (or a TypeScript error if `SeasonRoundResults`/`SeasonSprintResults` aren't yet exported — they already are, per the existing file).

- [ ] **Step 3: Implement `buildConstructorSeasonLogs`**

Add to `frontend/src/lib/season-results.ts`, after `buildDriverSeasonLogs`:

```ts
export interface ConstructorRoundEntry {
  round: number;
  raceName: string;
  shortName: string;
  points: number;
}

export interface ConstructorSeasonLog {
  constructorId: string;
  entries: ConstructorRoundEntry[];
}

/**
 * Constructor points per round, summed across whichever drivers scored for
 * them that round -- built from the same rounds/sprints `buildDriverSeasonLogs`
 * already needs, so a mid-season driver swap still attributes points to the
 * team correctly without tracking driver-to-team history separately.
 */
export function buildConstructorSeasonLogs(
  constructors: ConstructorStanding[],
  rounds: SeasonRoundResults[],
  sprints: SeasonSprintResults[] = []
): Record<string, ConstructorSeasonLog> {
  const sprintByRound = new Map<string, RaceResult[]>();
  for (const sprint of sprints) sprintByRound.set(String(sprint.round), sprint.results);

  const ordered = [...rounds].sort((a, b) => Number(a.round) - Number(b.round));

  const logs: Record<string, ConstructorSeasonLog> = {};

  for (const constructor of constructors) {
    const constructorId = constructor.Constructor?.constructorId;
    if (!constructorId) continue;

    const entries: ConstructorRoundEntry[] = [];
    for (const round of ordered) {
      const raceResults = round.results.filter(
        (r) => r.Constructor?.constructorId === constructorId
      );
      const sprintResults = (sprintByRound.get(String(round.round)) ?? []).filter(
        (r) => r.Constructor?.constructorId === constructorId
      );

      if (raceResults.length === 0 && sprintResults.length === 0) continue;

      const points =
        raceResults.reduce((sum, r) => sum + (toNumber(r.points) ?? 0), 0) +
        sprintResults.reduce((sum, r) => sum + (toNumber(r.points) ?? 0), 0);

      entries.push({
        round: Number(round.round),
        raceName: round.raceName,
        shortName: shortRaceName(round.raceName),
        points,
      });
    }

    logs[constructorId] = { constructorId, entries };
  }

  return logs;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/lib/season-results.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/season-results.ts frontend/src/lib/season-results.test.ts
git commit -m "Add per-round constructor points, parallel to the existing driver season log"
```

---

### Task 2: `buildProgressionRows` — the chart's data shaping

**Files:**
- Create: `frontend/src/lib/championship-progression.ts`
- Test: `frontend/src/lib/championship-progression.test.ts`

**Interfaces:**
- Consumes: any entry shape with `{ round: number; shortName: string; points: number; position?: number | null }` — both `DriverRoundEntry` and `ConstructorRoundEntry` from Task 1 satisfy this structurally.
- Produces: `export interface ProgressionRow { round: number; shortName: string; cumulative: Record<string, number>; gained: Record<string, number>; position: Record<string, number | null>; leaderPoints: number; }`, `export function buildProgressionRows(entityIds: string[], logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>): ProgressionRow[]`, `export interface ProgressionEntry { round: number; shortName: string; points: number; position?: number | null; }`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/championship-progression.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildProgressionRows } from "./championship-progression";

describe("buildProgressionRows", () => {
  it("accumulates points round over round per entity", () => {
    const rows = buildProgressionRows(["max", "lewis"], {
      max: {
        entries: [
          { round: 1, shortName: "Bahrain", points: 25, position: 1 },
          { round: 2, shortName: "Jeddah", points: 18, position: 2 },
        ],
      },
      lewis: {
        entries: [
          { round: 1, shortName: "Bahrain", points: 15, position: 3 },
          { round: 2, shortName: "Jeddah", points: 25, position: 1 },
        ],
      },
    });

    expect(rows).toEqual([
      {
        round: 1,
        shortName: "Bahrain",
        cumulative: { max: 25, lewis: 15 },
        gained: { max: 25, lewis: 15 },
        position: { max: 1, lewis: 3 },
        leaderPoints: 25,
      },
      {
        round: 2,
        shortName: "Jeddah",
        cumulative: { max: 43, lewis: 40 },
        gained: { max: 18, lewis: 25 },
        position: { max: 2, lewis: 1 },
        leaderPoints: 43,
      },
    ]);
  });

  it("treats a round an entity has no entry for as zero points gained, carrying the total forward", () => {
    const rows = buildProgressionRows(["max", "sub"], {
      max: { entries: [{ round: 1, shortName: "R1", points: 25, position: 1 }] },
      sub: { entries: [{ round: 2, shortName: "R2", points: 4, position: 8 }] },
    });

    expect(rows[0]).toEqual({
      round: 1,
      shortName: "R1",
      cumulative: { max: 25, sub: 0 },
      gained: { max: 25, sub: 0 },
      position: { max: 1, sub: null },
      leaderPoints: 25,
    });
    expect(rows[1].cumulative).toEqual({ max: 25, sub: 4 });
  });

  it("unions the round set across entities rather than requiring every entity to share every round", () => {
    const rows = buildProgressionRows(["a", "b"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
      b: { entries: [{ round: 3, shortName: "R3", points: 5 }] },
    });

    expect(rows.map((r) => r.round)).toEqual([1, 3]);
  });

  it("defaults a missing position to null rather than omitting the key", () => {
    const rows = buildProgressionRows(["a"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
    });

    expect(rows[0].position).toEqual({ a: null });
  });

  it("handles an entity absent from the log map entirely as scoring nothing", () => {
    const rows = buildProgressionRows(["a", "ghost"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
    });

    expect(rows[0].cumulative).toEqual({ a: 10, ghost: 0 });
  });

  it("returns an empty array when no entity has any entries", () => {
    expect(buildProgressionRows(["a"], { a: { entries: [] } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/lib/championship-progression.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `buildProgressionRows`**

Create `frontend/src/lib/championship-progression.ts`:

```ts
export interface ProgressionEntry {
  round: number;
  shortName: string;
  points: number;
  position?: number | null;
}

export interface ProgressionRow {
  round: number;
  shortName: string;
  cumulative: Record<string, number>;
  gained: Record<string, number>;
  position: Record<string, number | null>;
  leaderPoints: number;
}

/**
 * Reshapes per-entity round logs (driver or constructor) into one row per
 * round, each carrying every entity's running total -- the shape Recharts'
 * `data` prop and this feature's custom tooltip both need.
 *
 * A round an entity has no entry for (missed a race, hadn't started the
 * season yet) is treated as zero points gained rather than omitted, so the
 * entity's line stays flat instead of breaking -- `buildDriverSeasonLogs` and
 * `buildConstructorSeasonLogs` already chose not to insert a zero entry for
 * exactly this case, so the flattening happens here instead.
 */
export function buildProgressionRows(
  entityIds: string[],
  logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>
): ProgressionRow[] {
  const roundSet = new Set<number>();
  const shortNameByRound = new Map<number, string>();
  const entryByEntityRound = new Map<string, Map<number, ProgressionEntry>>();

  for (const id of entityIds) {
    const perRound = new Map<number, ProgressionEntry>();
    for (const entry of logsByEntityId[id]?.entries ?? []) {
      roundSet.add(entry.round);
      if (!shortNameByRound.has(entry.round)) {
        shortNameByRound.set(entry.round, entry.shortName);
      }
      perRound.set(entry.round, entry);
    }
    entryByEntityRound.set(id, perRound);
  }

  const rounds = Array.from(roundSet).sort((a, b) => a - b);
  const running: Record<string, number> = {};
  for (const id of entityIds) running[id] = 0;

  return rounds.map((round) => {
    const cumulative: Record<string, number> = {};
    const gained: Record<string, number> = {};
    const position: Record<string, number | null> = {};

    for (const id of entityIds) {
      const entry = entryByEntityRound.get(id)?.get(round);
      const points = entry?.points ?? 0;
      running[id] += points;
      cumulative[id] = running[id];
      gained[id] = points;
      position[id] = entry?.position ?? null;
    }

    const leaderPoints = Math.max(...entityIds.map((id) => cumulative[id]));

    return {
      round,
      shortName: shortNameByRound.get(round) ?? `R${round}`,
      cumulative,
      gained,
      position,
      leaderPoints,
    };
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/lib/championship-progression.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/championship-progression.ts frontend/src/lib/championship-progression.test.ts
git commit -m "Add pure row-shaping for the championship progression chart"
```

---

### Task 3: `ChampionshipProgressionChart` component

**Files:**
- Create: `frontend/src/components/championship-progression-chart.tsx`

**Interfaces:**
- Consumes: `buildProgressionRows` and `ProgressionRow`/`ProgressionEntry` from Task 2; `getTeamColor` from `src/lib/team-colors.ts`.
- Produces: `export interface ProgressionEntity { id: string; name: string; colorHex: string; }`, `export default function ChampionshipProgressionChart(props: { entities: ProgressionEntity[]; logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>; }): JSX.Element`

No unit test for this file — per the Global Constraints, `vitest.config.ts` only runs `src/lib/**/*.test.ts`; this component is verified visually in Task 4.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/championship-progression-chart.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import {
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  buildProgressionRows,
  type ProgressionEntry,
  type ProgressionRow,
} from "@/lib/championship-progression";

export interface ProgressionEntity {
  id: string;
  name: string;
  colorHex: string;
}

interface ChampionshipProgressionChartProps {
  entities: ProgressionEntity[];
  logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>;
}

interface ProgressionTooltipProps {
  active?: boolean;
  payload?: { payload: ProgressionRow }[];
  entities: ProgressionEntity[];
  highlighted: Set<string>;
}

function ProgressionTooltip({ active, payload, entities, highlighted }: ProgressionTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const visible = entities.filter((e) => highlighted.size === 0 || highlighted.has(e.id));

  return (
    <div className="rounded-xl bg-surface-container/95 border border-white/10 p-4 shadow-xl max-h-80 overflow-y-auto">
      <p className="font-[family-name:var(--font-headline)] font-bold text-lg mb-2">
        {row.shortName}
      </p>
      <div className="space-y-2">
        {visible
          .slice()
          .sort((a, b) => row.cumulative[b.id] - row.cumulative[a.id])
          .map((entity) => (
            <div key={entity.id} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full flex-none"
                style={{ backgroundColor: entity.colorHex }}
              />
              <span className="font-bold w-24 truncate">{entity.name}</span>
              <span className="tabular-nums font-bold">{row.cumulative[entity.id]} pts</span>
              <span className="text-xs text-warm-500 tabular-nums">
                +{row.gained[entity.id]}
              </span>
              {row.position[entity.id] !== null && (
                <span className="text-xs text-warm-500">P{row.position[entity.id]}</span>
              )}
              {row.cumulative[entity.id] < row.leaderPoints && (
                <span className="text-xs text-warm-500 tabular-nums">
                  -{row.leaderPoints - row.cumulative[entity.id]}
                </span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

export default function ChampionshipProgressionChart({
  entities,
  logsByEntityId,
}: ChampionshipProgressionChartProps) {
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => buildProgressionRows(entities.map((e) => e.id), logsByEntityId),
    [entities, logsByEntityId]
  );

  const chartData = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        ...Object.fromEntries(entities.map((e) => [e.id, row.cumulative[e.id]])),
      })),
    [rows, entities]
  );

  const toggle = (id: string) => {
    setHighlighted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <div className="apex-glass-soft rounded-2xl p-8 text-center text-sm text-warm-400 font-medium">
        No rounds scored yet this season.
      </div>
    );
  }

  return (
    <div className="apex-glass-soft rounded-2xl p-6">
      <h3 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-500 mb-4">
        Championship progression
      </h3>
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" />
          <XAxis
            dataKey="shortName"
            stroke="#5c554b"
            tick={{ fill: "var(--color-warm-400)", fontSize: 11 }}
            interval={0}
          />
          <YAxis
            stroke="#5c554b"
            tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.15)" }}
            content={<ProgressionTooltip entities={entities} highlighted={highlighted} />}
          />
          {entities.map((entity) => {
            const dimmed = highlighted.size > 0 && !highlighted.has(entity.id);
            return (
              <Line
                key={entity.id}
                type="monotone"
                dataKey={entity.id}
                stroke={entity.colorHex}
                strokeWidth={2}
                strokeOpacity={dimmed ? 0.15 : 1}
                dot={dimmed ? false : { r: 2, fill: entity.colorHex }}
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-2 mt-5">
        {entities.map((entity) => {
          const dimmed = highlighted.size > 0 && !highlighted.has(entity.id);
          return (
            <button
              key={entity.id}
              onClick={() => toggle(entity.id)}
              className={`flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-md transition-opacity duration-150 ${
                dimmed ? "opacity-40" : "opacity-100"
              }`}
            >
              <div
                className="w-2.5 h-2.5 rounded-full flex-none"
                style={{ backgroundColor: entity.colorHex }}
              />
              {entity.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/championship-progression-chart.tsx
git commit -m "Add ChampionshipProgressionChart component"
```

---

### Task 4: Wire into `/standings`

**Files:**
- Modify: `frontend/src/app/standings/page.tsx`
- Modify: `frontend/src/components/standings-view.tsx`

**Interfaces:**
- Consumes: `buildConstructorSeasonLogs` (Task 1), `ChampionshipProgressionChart` + `ProgressionEntity` (Task 3), existing `seasonLogs: Record<string, DriverSeasonLog>` prop.

- [ ] **Step 1: Compute and pass `constructorLogs` server-side**

In `frontend/src/app/standings/page.tsx`, add the import and computation:

```ts
import {
  buildDriverSeasonLogs,
  buildConstructorSeasonLogs,
  buildTeammateBattles,
  fetchSeasonResults,
  fetchSeasonSprints,
  type DriverSeasonLog,
  type ConstructorSeasonLog,
  type TeammateBattle,
} from "@/lib/season-results";
```

Change the `seasonLogs` state block:

```ts
  let seasonLogs: Record<string, DriverSeasonLog> = {};
  let constructorLogs: Record<string, ConstructorSeasonLog> = {};
  if ((drivers ?? []).length > 0) {
    try {
      const [rounds, sprints] = await Promise.all([
        fetchSeasonResults(year, { includeQualifying: false }),
        fetchSeasonSprints(year).catch(() => []),
      ]);
      teammateBattles = buildTeammateBattles(drivers ?? [], rounds);
      seasonLogs = buildDriverSeasonLogs(drivers ?? [], rounds, sprints);
      constructorLogs = buildConstructorSeasonLogs(constructors ?? [], rounds, sprints);
    } catch {
      // Leave the panel empty rather than failing the page.
    }
  }
```

And pass it to `StandingsView`:

```tsx
    <StandingsView
      drivers={drivers ?? []}
      constructors={constructors ?? []}
      teammateBattles={teammateBattles}
      seasonLogs={seasonLogs}
      constructorLogs={constructorLogs}
      year={year}
      maxYear={getActiveSeasonYear()}
      renderedAtMs={Date.now()}
    />
```

- [ ] **Step 2: Accept the new prop and render the chart in `StandingsView`**

In `frontend/src/components/standings-view.tsx`, add a new import for the chart:

```tsx
import ChampionshipProgressionChart, {
  type ProgressionEntity,
} from "@/components/championship-progression-chart";
```

Extend the existing `@/lib/season-results` import (do not add a second import from the same module) to also bring in `ConstructorSeasonLog`:

```tsx
import type { DriverSeasonLog, TeammateBattle, ConstructorSeasonLog } from "@/lib/season-results";
```

Add `constructorLogs: Record<string, ConstructorSeasonLog>;` to `StandingsViewProps`, next to `seasonLogs`, and destructure it in the function signature.

Immediately above the `{/* DRIVERS */}` block, add:

```tsx
      {tab === "drivers" && drivers.length > 1 && (
        <div className="mb-6">
          <ChampionshipProgressionChart
            entities={drivers.map((d): ProgressionEntity => ({
              id: d.Driver.driverId ?? "",
              name: d.Driver.code || d.Driver.familyName || "—",
              colorHex: getTeamColor(d.Constructors?.[0]?.name ?? "—").hex,
            }))}
            logsByEntityId={seasonLogs}
          />
        </div>
      )}

      {tab === "cons" && constructors.length > 1 && (
        <div className="mb-6">
          <ChampionshipProgressionChart
            entities={constructors.map((c): ProgressionEntity => ({
              id: c.Constructor.constructorId ?? "",
              name: c.Constructor.name ?? "—",
              colorHex: getTeamColor(c.Constructor.name).hex,
            }))}
            logsByEntityId={constructorLogs}
          />
        </div>
      )}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Visual verification in the browser**

Start the dev server (`preview_start` with the project's frontend launch config), navigate to `/standings`, and confirm:
- The chart renders above the drivers table with one line per driver, colored by team.
- Switching to the Constructors tab swaps the chart to constructor lines.
- Clicking a legend chip dims every other line; clicking it again restores all lines.
- Hovering a point on the X-axis shows the tooltip with cumulative points, points gained, position, and gap to leader.
- Take a screenshot of both tabs.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/standings/page.tsx frontend/src/components/standings-view.tsx
git commit -m "Show championship progression chart on the standings page"
```
