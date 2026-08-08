# Watch mode: per-second timing, intra-lap positions, and motion

Date: 2026-08-08. Batch 22, CP79.

## The problem, and its actual cause

Watch mode's timing tower only changes when a lap completes. Positions that
change *during* a lap are never shown, and every gap on screen is a per-lap
number. This is not a rendering bug. Three layers are lap-indexed, and the
intra-lap data is discarded at the first one:

1. **Ingest throws it away.** `race_laps.positions_from_openf1` fetches
   OpenF1's `/position` feed — a stream of timestamped position *changes*, 531
   of them across the 146 minutes of 2026 round 1 — and collapses it to one
   answer per driver per lap ("their most recent position event at or before
   their lap-N line crossing"). Everything between two line crossings is read
   and dropped.
2. **There is no interval anywhere in the schema.** `gap_seconds` is one number
   per (driver, lap), the difference of two line-crossing instants. Gap to the
   car *ahead* has never been stored. OpenF1's `/intervals` endpoint — never
   called by this app — carries both `interval` and `gap_to_leader` at a ~3.6s
   median per-driver cadence: 22,276 rows for that same race.
3. **The view renders `laps[lapIndex]`**, and `lapIndex` only advances when
   `RealTimeLapClock` crosses a whole lap duration. The row `transform`
   transition already exists and is correct; it simply has nothing new to
   animate to more than once a lap.

## Data quality, measured before committing to the source

2026 round 1, session key 11234:

| field | rows | quality |
|---|---|---|
| `/position` events | 531 | every one a real position change with a real timestamp |
| `/intervals` rows | 22,276 | `interval` 99.2% numeric, `gap_to_leader` 79.2% numeric |
| non-numeric gaps | 4,552 | `"+1 LAP"` ×3666, `"+2 LAPS"` ×824, `"+3 LAPS"` ×31, … |
| null gaps | 78 | genuinely absent |

The non-numeric remainder is **not** corrupt data — it is broadcast semantics
for a lapped car. It is carried through verbatim.

## Decisions

**Source: real sampled OpenF1 data, never interpolation.** Rejected: deriving
intra-lap numbers by interpolating between lap boundaries. Every such number
would be invented, in a mode whose stated premise (`watch-clock.ts`) is
refusing to fabricate pacing. A round OpenF1 cannot cover degrades to today's
lap-stepped behaviour and says so, rather than silently smoothing.

**Encoding: raw samples at native cadence.** Measured against round 1:

| encoding | raw | gzipped |
|---|---|---|
| naive per-driver-second grid | 3,010 KB | — |
| run-length-encoded 1s grid | 459 KB | 165 KB |
| **raw samples (chosen)** | **454 KB** | **150 KB** |

Smallest *and* the most honest: real measurements at real instants, with the
client interpolating between them, rather than a 1s quantisation baked into
storage.

**Motion: positions swap on the sample; the gap carries the tension.**
Rejected: interpolating a row's vertical travel across an overtake, which would
put a car visually between P5 and P6 at moments the feed says it was
definitively in one of them. Instead the row crossover is discrete (there are
only ~531 in a race, so it stays legible) and the *interval readout* counts
down continuously as an attacker closes, with the pair highlighted under ~1.0s.
The drama comes from the number that is genuinely continuous.

**Modes: toggle decides emphasis, density decides availability.** Compact shows
one toggled column (`INT` or `GAP`) — there is no room for more. Expanded shows
the chosen mode large and the other small beside it. Default is **interval**.
P1 reads `LEADER`. A lapped car reads `+1 LAP` verbatim in whichever mode
reports it.

**One clock.** `RealTimeLapClock` remains the sole authority on time. No second
timer is introduced.

## Contract

`GET /api/race_timing?year=&round=`

```jsonc
{
  "year": 2026, "round": 1, "synced": true,
  "drivers": {
    "1": {
      "timing":    [[t_ms, interval, gap_to_leader], ...],
      "positions": [[t_ms, position], ...]
    }
  }
}
```

- `t_ms` — **integer milliseconds of elapsed race time**, already resolved
  server-side against the leader's lap boundaries. A consumer never sees an
  OpenF1 wall-clock timestamp.
- `interval`, `gap_to_leader` — `number | string | null`. A string is a lapped
  car (`"+1 LAP"`) and must be rendered verbatim, never parsed to a number.
  `null` is "not reported at this instant".
- `position` — integer.
- Both arrays are sorted ascending by `t_ms` and are non-empty for any driver
  present in `drivers`.
- `synced: false` with `drivers: {}` means this round has no per-second track.
  It is not an error — same convention as `race_laps` and `race_replay`.

### Time anchoring

OpenF1 timestamps are wall-clock. `RealTimeLapClock` runs a *synthetic*
timeline built by summing measured lap durations. The two drift, so samples
cannot be placed by subtracting a race-start timestamp.

Instead the backend builds the **leader's** lap-boundary instants (per-driver
line crossings already computed by `race_laps._lap_end_times`), maps each
sample to `(lap_number, fraction_through_that_lap)`, and emits

```
t_ms = round(1000 * (cumulative_measured_seconds[lap] + fraction * lap_seconds[lap]))
```

using the same per-lap durations the frontend clock will use, so a sample lands
in the right place even where a measured duration disagrees with wall-clock.

A sample that cannot be anchored — before the leader's first crossing, or after
the final one — is **dropped**, not clamped. Clamping would pile pre-race grid
events onto t=0 and render as a phantom position shuffle on lights out.

## Degradation

| available | behaviour |
|---|---|
| timing + positions | full per-second tower |
| timing only | per-second gaps; positions from lap boundaries |
| neither / pre-2023 | exactly today's lap-stepped tower, labelled |

## Testing

Backend: anchoring (including the drop-don't-clamp rule), the string-gap
passthrough, empty/None handling, and key parity between what the builder emits
and what the contract above states. Frontend: sample lookup at, between, and
outside sample bounds; the `number | string | null` union at every branch; and
the mode preference round-tripping through `localStorage` like density does.
