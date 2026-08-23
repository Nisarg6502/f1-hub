# Championship Progression, Sector Battles & Tire Stints Fix — Design

**Date:** 2026-08-23
**Status:** Approved, not yet implemented

## Problem

Three unrelated gaps, bundled because they landed in the same request:

1. **Standings has no progression view.** The `/standings` page shows only the
   current table. There is no way to see *how* a driver or constructor got to
   their points total — whether it was a steady climb or a late collapse.
   `DriverSeasonLog` (round-by-round points) already exists per driver for the
   season-log disclosure on each row, but nothing plots it, and there is no
   constructor equivalent at all.
2. **No sector-time comparison for non-race sessions.** FP1–FP3, Qualifying
   and Sprint Qualifying only ever show a finishing-order classification
   table. There is no way to see who actually had the pace in a given sector —
   the purple/green/yellow breakdown every broadcast overlay has.
3. **Bug: `TireStintsChart` drops driver labels and clips the X-axis label.**
   With "Select all" (~20 drivers) on a race with a large field, only about
   half the driver names render on the Y-axis, and "Lap number" under the
   X-axis is invisible.

## 3. Tire stints fix — already implemented

Root cause, confirmed by reading Recharts' `CartesianAxis` default props
(`node_modules/recharts/es6/cartesian/CartesianAxis.js`): `interval` defaults
to `'preserveEnd'`, which thins ticks to fit whatever pixel space is
available. The chart's `ResponsiveContainer` sat in a `min-h-[500px]` box that
never grew with the driver count, so at ~20 drivers each row was only a few
pixels tall and Recharts silently dropped every other label. The X-axis
"Lap number" label was pushed past the 20px bottom margin by its `dy: 10`
offset and clipped by the SVG viewBox.

Fix, in [tire-stints-chart.tsx](../../../frontend/src/components/tire-stints-chart.tsx):
- `YAxis interval={0}` — always render every driver's tick, never thin.
- `ResponsiveContainer height={Math.max(500, activeDrivers.length * 34 + 60)}`
  — the chart grows with the selection instead of squeezing into a fixed box.
- Bottom margin raised from 20 to 36px so the X-axis label has room.

No further work needed here.

## 2. Championship progression graph

### Data

**Drivers**: `DriverSeasonLog.entries` (in
[season-results.ts](../../../frontend/src/lib/season-results.ts)) already has
one `DriverRoundEntry` per round with `points` (that round's race+sprint
total) and `position`. Cumulative points are a running sum computed client-side
in the chart component — no new data needed.

**Constructors**: no equivalent exists. Add `buildConstructorSeasonLogs` next
to `buildDriverSeasonLogs`, built from the same `rounds`/`sprints` arrays
`standings/page.tsx` already fetches (no new request):

```ts
export interface ConstructorRoundEntry {
  round: number;
  raceName: string;
  shortName: string;
  points: number; // summed across every driver who scored for this constructor that round
}

export interface ConstructorSeasonLog {
  constructorId: string;
  entries: ConstructorRoundEntry[];
}

export function buildConstructorSeasonLogs(
  constructors: ConstructorStanding[],
  rounds: SeasonRoundResults[],
  sprints: SeasonSprintResults[] = []
): Record<string, ConstructorSeasonLog>
```

For each round, group `round.results` (and the matching sprint's results) by
`result.Constructor.constructorId` and sum `points`. This correctly handles a
mid-season driver swap — the constructor's own row's points are whoever
actually scored for them that round, regardless of which driver it was.

`standings/page.tsx` computes this alongside `seasonLogs` and passes it to
`StandingsView` as a new `constructorLogs` prop.

### Component

New `ChampionshipProgressionChart` (`frontend/src/components/championship-progression-chart.tsx`),
a Recharts `LineChart`:

- **Props**: `entities` (drivers or constructors with id, display name, team
  color), `logsByEntityId` (the `Record<string, DriverSeasonLog |
  ConstructorSeasonLog>` for whichever tab is active), `mode: "drivers" |
  "constructors"`.
- **X-axis**: round number / short race name. **Y-axis**: cumulative points.
- One `<Line>` per entity, `stroke` = team color (`getTeamColor`, same
  helper the rest of the page uses), all rendered at once.
- **Legend**: a wrapped row of small chip buttons (driver code or constructor
  short name, team-colored dot) below the chart — not Recharts' built-in
  legend, so it can double as the highlight control. Clicking a chip toggles
  a `highlighted` set in local state; when non-empty, every line not in the
  set drops to `strokeOpacity: 0.15` and loses its dot. Clicking an
  already-highlighted chip clears the set back to "all normal."
- **Tooltip** (custom, matching `StintTooltip`'s card style): on hover over a
  round, shows every visible entity's cumulative points and finish position
  that round, points gained that round, and gap to whoever led the
  championship after that round (`leaderPoints - thisEntity'sPoints`,
  computed from the same round's cumulative totals across all entities).
- Reduced-motion respecting, `isAnimationActive={false}` like the tire chart,
  since Recharts re-mounts on tab switch already provide the transition.

### Placement

In [standings-view.tsx](../../../frontend/src/components/standings-view.tsx),
a new card between the `TitleDeciderPanel` and the drivers/constructors grid,
switching its data source with the existing `tab` state — no new tab, no new
route.

## 1. Sector classification battles

### Color rule

- **Purple** — the single fastest time in that sector across every lap of the
  session, by any driver.
- **Green** — a driver's own personal-best time in that sector this session,
  when it is not also the session's best (i.e., not purple).
- **Yellow** — any other sector time (slower than that driver's own best).

Applies independently per sector (S1/S2/S3), not per lap — a driver can be
purple in S1 and yellow in S3 on the same lap.

### Data source

New backend endpoint `GET /api/session_sectors?year=&round=&session=` (`session`
one of `FP1`, `FP2`, `FP3`, `Q`, `SQ`, mirroring `session_classification`'s
existing convention) in a new `backend/app/session_sectors.py`.

Sourced from OpenF1's `/laps` endpoint (`duration_sector_1/2/3` per lap),
chosen over FastF1 specifically because OpenF1 is reachable from Cloud Run —
FastF1's livetiming source intermittently 403s datacenter IPs (see
`race_laps.py`'s own docstring on the same problem) and this endpoint has no
local-sync fallback path the way `race_laps`/`race_stints` do. OpenF1 only covers
2023-onward; earlier seasons get an explicit `{"available": false}` response
the frontend renders as a "Sector data isn't available for this season" empty
state, not a blank panel.

Session resolution: reuse the meeting-then-session lookup already proven in
`race_stints.fetch_openf1_session_key`, extended to take a `session_name`
(`"Practice 1"`, `"Practice 2"`, `"Practice 3"`, `"Qualifying"`, `"Sprint
Qualifying"`) instead of hardcoding `"Race"`, and matched against the
session's own date rather than the race date — OpenF1's `/sessions` supports
filtering by `year` + `session_name`; narrow further by finding the entry
whose `date_start` falls within the race weekend (the Thursday–Sunday window
around the round's race `date`, which `db.races` already stores).

Response shape:

```json
{
  "available": true,
  "sectors": {
    "1": [{ "driverNumber": "1", "code": "VER", "teamColor": "#3671C6", "bestSeconds": 28.412, "classification": "purple" }, ...],
    "2": [...],
    "3": [...]
  }
}
```

Each sector's array is every driver who set a valid time, sorted ascending by
`bestSeconds`. `classification` is computed server-side using the color rule
above so the frontend does no timing math, just rendering. Cached in Mongo
(`session_sectors` collection, keyed by `season`/`round`/`session`) the same
way `practice_results` is, since OpenF1 data for a finished session does not
change.

### Component

New `SectorBattlePanel` (`frontend/src/components/sector-battle-panel.tsx`),
client-fetched (the page doesn't currently prefetch per-session sector data
and this is opt-in detail, not above-the-fold content). Three columns, one
per sector, each a ranked list: position number, team-color bar, driver code,
best time, gap to the sector leader, colored badge (purple/green — yellow
rows get no badge, just default text color, since "yellow" here means
"nothing special" rather than a flag state worth highlighting visually as
loudly as the other two).

### Placement

In [session-tabs.tsx](../../../frontend/src/components/session-tabs.tsx),
rendered inside the existing non-race branch, only when `activeSession` is
`FirstPractice`, `SecondPractice`, `ThirdPractice`, `Qualifying`, or
`SprintQualifying` (not `Race`, not `Sprint` — those already have their own
race-shaped analysis surfaces on the Pitwall page). Placed below the existing
`SessionInfo` results table, since the classification table is the primary
"what happened" view and the sector battle is supporting detail.

## Explicitly excluded

- **Lap-by-lap sector evolution chart.** The board shows each driver's best
  sector time for the session, not how it changed lap to lap. A time-series
  view is a materially bigger surface (needs every lap, not just the best)
  and nothing in the request asked for trend over time — "battles" reads as
  a leaderboard, not a chart.
- **Sector battles for completed Race / Sprint sessions.** Those already have
  dedicated Pitwall modules (lap telemetry, position/gap, tire stints); this
  request was specifically FP/Quali/Sprint-Quali, the sessions with no
  existing per-driver pace comparison at all.
- **Syncing standings-row hover with the progression chart's highlight.**
  Two independent highlight controls (table row hover, chart legend chips)
  is simpler to build and reason about than wiring them together, and the
  chart's own legend is enough to answer "which line is who."
