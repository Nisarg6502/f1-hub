# Batch 21, CP76-78 — Watch-party mode (variant 1)

Supersedes the planning half of
[`2026-08-08-watch-party-second-screen-design-note.md`](2026-08-08-watch-party-second-screen-design-note.md),
which stays as the record of *why* the feature is shaped this way. Read its "constraint that shapes
everything" section before touching this: **this app has no live feed and cannot get one.**
Everything here replays stored data.

Scope decided with the user, 2026-08-08: **variant 1 only.** Variant 2 (phone-as-remote pairing) is
a strict superset and lands in a later batch — it is the only part that may need new backend state,
and building it alongside variant 1 would entangle the unknowns.

## The finding this batch is built around

The obvious framing is "make the race replay full-screen." That is wrong, and the reason is
measured, not assumed: `frontend/src/components/race-replay.tsx:42` sets
`BASE_MS_PER_LAP = 560` — a **fixed** 560ms per lap regardless of the lap's real duration — with
`SPEEDS = [1, 2, 4]` dividing it further. Real F1 laps run 80-95 seconds, so the replay's "1×" is
roughly **150× real time** (a 58-lap race in ~33 seconds) and its speed buttons move *away* from
reality.

Worse, the data the honest clock needs does not exist yet. `backend/app/race_laps.py` reads `LapTime`
from FastF1 into a scratch key `_lap_time_seconds`, uses it to compute cumulative time, and then
**pops it** (`_attach_gap_seconds`, ~line 129). The stored row carries only `driver_number`,
`lap_number`, `position` and `gap_seconds`. Every sync computes each lap's duration and throws it
away.

`gap_seconds` cannot substitute. It is *relative* (own cumulative minus the leader's) and null
whenever either the driver or that lap's leader has no usable `LapTime`, so a race with sparse timing
data would produce a clock that stalls rather than one that is merely approximate.

**So this batch starts with a data change, not with UI.** That ordering is the whole plan.

## CP76 — Persist per-lap duration

**Files:** `backend/app/race_laps.py`, `backend/app/race_replay.py`, `backend/app/data_sync.py` if
the sync path needs it, plus tests.

`positions_from_laps` keeps `lap_time_seconds` on each row instead of discarding it. `gap_seconds`
keeps its current meaning and its current null behaviour — this adds a field, it does not change one.
A null `lap_time_seconds` stays null and is a first-class case, not an error: the clock's fallback
behaviour for it is CP77's problem, and CP77 must be written knowing it will happen.

`REPLAY_VERSION` is bumped (3 → 4). This is exactly the data-shape change that counter exists for;
Batch 12 bumped it twice for the same class of fix.

**The re-sync must run locally.** `race_laps` is FastF1-sourced and FastF1's livetiming endpoint is
intermittently IP-blocked from Cloud Run, which is the operational gap that once left Lap Telemetry
reading "not processed yet" for every completed race. Deploying CP76 without running the backfill
ships a schema whose new field is null everywhere.

**Done when:** stored `race_laps` rows carry `lap_time_seconds`; `gap_seconds` is byte-identical to
before for a race with complete timing; the current season is backfilled locally and spot-checked;
`REPLAY_VERSION` is bumped.

## CP77 — The real-time clock and the watch route

**Files:** new `frontend/src/app/watch/[raceId]/page.tsx` and a `watch-view` component; reuses the
CP42-44 replay endpoint. No backend work beyond CP76.

A new full-screen, chrome-free route on a clock that advances each lap by **that lap's own duration**.
This is the feature. Safety-car laps run long and green laps run short, which is the whole point — a
fixed tick is worst exactly where a companion screen is most useful.

Decisions taken with the user rather than left to implementation:

- **Catch-up is an instant jump, not a fast-forward.** Set the lap, the view snaps there, the real
  clock resumes. One clock runs at a time and there is never ambiguity about what is being watched.
- **An unsynced race offers the most recent synced one.** The likeliest moment to open this is right
  after a race, which is precisely when the sync may not have run. The empty state explains the round
  is not processed yet and offers what is available, so the feature is never a dead end. It does
  **not** offer to trigger a sync — FastF1 from Cloud Run would fail unpredictably.

Also in scope: timing tower with live-updating gaps, tyre compound and age, position changes marked
as they happen, race-control messages appearing on the lap they were issued, large type legible
across a room, landscape-first layout, and a Screen Wake Lock so a propped-up phone does not sleep.

**Null `lap_time_seconds` must not stall the clock.** Fall back to that race's median lap for the
missing row and keep moving; a companion screen that freezes is worse than one that is approximate
for one lap. Whatever is chosen, it is stated in the UI's own copy rather than hidden.

**Done when:** a completed race plays at real pace with lap durations visibly varying (a safety-car
stint takes longer than a green-flag lap); jump-to-lap works; an unsynced race offers a synced one;
the wake lock holds; the layout is legible at arm's length in landscape.

## CP78 — Density, favourites and polish

**Files:** the watch view and its components only.

Driver favouriting (your driver pins to the top of the tower), a compact and an expanded density, and
a polish pass from actually running it against a race. Deliberately last and deliberately small —
Batch 15's viewer polish checkpoint earned its place by being informed by real use, and this follows
that precedent rather than guessing at the polish up front.

**Done when:** favourites persist across a reload, both densities are legible, and the mode has been
run end to end against a real race.

## Sequencing

CP76 → CP77 → CP78, strictly. CP77 cannot be built against a field that does not exist, and CP78's
value depends on having used CP77.

## Explicitly out of scope

- **Variant 2, phone-as-remote pairing.** Later batch. It implies either a shared session id with
  polling or a local-network channel, and it is the only part of this feature that needs backend
  state.
- **Anything described as "live."** The framing is "replay, paced like the real thing, that you can
  line up with what is on your TV." This project has already had to correct overstated user-facing
  copy once (Batch 11 CP39, the OpenF1 paywall claims); do not reintroduce the problem here.
- **Track-position animation.** No coordinate data source exists, as `ROADMAP.md` has recorded since
  Batch 12.
