# Watch-party / second-screen mode — design note (not yet scheduled)

Parked deliberately, not forgotten. Raised during Batch 20's planning session (2026-08-08); the user
agreed variants 1 and 2 below are both worth building, and asked that the thinking be written down so
implementation can start from here rather than from scratch. **This is a design note, not a spec** —
the open questions at the end are genuinely open and should be answered before a plan is written.

## The constraint that shapes everything

**This app has no live feed and cannot get one.** Every number in it arrives from a scheduled sync
*after* a session runs (the scheduler's :30 UTC cadence; FastF1's livetiming endpoint is
additionally, intermittently, IP-blocked from Cloud Run — see `f1hub-fastf1-cloud-run-403` and
`HANDOFF.md`). There is no version of this feature where you open it during Melbourne and watch it
update live.

Genuinely-live would require the F1 live timing stream: a commercial licence, or scraping the
SignalR feed at race pace — which is both already unreliable from our infrastructure and a good way
to get an IP permanently blocked. **Not buildable, and not worth attempting.** Everything below
replays stored data; the design's job is to be honest about that while still being useful on a
Sunday afternoon.

## The finding that makes this more than a re-skin

The obvious objection is "this is just the race replay full-screen." That was the initial read, and
it was wrong. `frontend/src/components/race-replay.tsx:42` sets `BASE_MS_PER_LAP = 560` — a fixed
560ms per lap regardless of the lap's real duration — with `SPEEDS = [1, 2, 4]` dividing it further.
Real F1 laps run 80-95 seconds, so the replay's **"1×" is roughly 150× real time** (a 58-lap race in
about 33 seconds), and its speed buttons move *away* from reality rather than toward it.

A watch-party mode therefore needs its own clock: advance on **each lap's own actual duration**, read
from `race_laps`, so lap 12 takes as long as lap 12 really took. That matters most exactly where a
fixed tick is worst — laps behind a safety car run far slower than green-flag laps, and those are the
laps a companion screen is most useful during. This is real engineering, and it is the core of the
feature.

## Variant 1 — Replay watch-party

A full-screen, chrome-free presentation mode over the existing replay data, on a real-time clock.

- New route, `/watch/[raceId]` (or `/watch` with a race picker).
- Timing tower with live-updating gaps, tyre compound and age, position changes flashing as they
  occur, race-control messages appearing on the lap they were issued.
- Large type, dark, legible across a room; landscape-first; a compact and an expanded density.
- Screen Wake Lock so a phone propped against the TV does not sleep.
- Driver favouriting — your driver pins to the top of the tower.
- **No backend work.** Reuses the CP42-44 replay endpoint as-is.

You start it at lap 1 as the lights go out and let it run alongside the broadcast. It will drift, and
a "jump to lap N" control corrects that in one tap.

## Variant 2 — Manual-sync companion

Variant 1 plus the thing that actually earns the phrase "second screen": it tracks the broadcast
rather than merely playing a recording.

- You tell it the current lap once; it advances on that race's own lap cadence from there, and
  re-syncs whenever you correct it.
- Drift correction is a first-class control, not a scrubber buried in a toolbar — correcting sync is
  the interaction this mode is *for*.
- The second-screen dimension proper: the phone acts as a remote for a desktop view (or the reverse).
  **This is the piece with the most unknowns** — it implies either a shared session id with polling,
  or a local-network channel, and it is the only part of this feature that might need backend work.

Variant 1 is a strict subset of variant 2. Build 1, ship it, then add sync — do not build them as one
checkpoint.

## Why this is honest

The framing must never be "live timing." It is "replay, paced like the real thing, that you can line
up with what is on your TV." Written down here because the temptation to describe it as live in UI
copy will be strong, and this project has already had to correct stale/overstated claims in
user-facing copy once (Batch 11 CP39, the OpenF1 paywall claims).

## Open questions — answer these before writing a plan

1. **Does `race_laps` carry a usable per-lap duration for the leader on every synced race**, or are
   there gaps (retirements, lapped cars, the sync gaps documented for `race_laps` in `ROADMAP.md`'s
   Batch 6-7 retrospective) that would stall the clock? This determines whether variant 1 is one
   checkpoint or two, and it is the first thing to check.
2. **Real-time only, or real-time with a "catch me up" fast-forward?** A viewer joining at lap 30
   needs to get there quickly; that is the existing fast clock, which means both clocks coexist and
   the UI has to make clear which one is running.
3. **How does variant 2's remote pairing work** — shared session id via the backend, or local
   network? The first needs backend work and is the only thing in this feature that does.
4. **Does it need its own data at all**, or is the CP42-44 replay payload sufficient at real-time
   pacing? Assumed sufficient; unverified.
5. **What happens for a race that has not been synced yet** — the most likely moment someone reaches
   for this is the race that just ran, which is precisely the one the sync may not have filled in
   yet. The empty state here is the feature's first impression and deserves a real answer.
