"""Race-shaped tools: narrative facts, strategy, race control, laps and pit stops.

These are the tools that answer taxonomy classes 3 and 5 ("how did Norris lose
the lead in Hungary?", "why did Ferrari two-stop at Monza?"), and they are the
ones where CP38's lesson bites hardest — a race is where the relational facts
live, and a relational fact is what a model confabulates.

So none of them derives anything the app already derives. `session_recap`
computed teammate pairings, positions gained, the podium and retirements in
Python precisely because a model handed a bare classification invented a
teammate relationship; `strategy_commentary` resolved undercut/overcut by
comparing track position either side of a pit window for the same reason.
Both fact builders are reused **verbatim** here rather than reimplemented, so
what the agent narrates and what the site's own recap narrates come from one
function and cannot drift apart.

The one thing this module adds is `get_lap_summary`, which exists because
`race_laps` is 1000+ rows for a single race and must never reach a context
window (plan §5.1's "context-budget rule that makes or breaks this system").

Every read is Mongo-only. `race_laps.get_race_laps` self-heals through OpenF1
and then FastF1; `session_recap.fetch_race_control` calls OpenF1 live. Neither
is called from here — the FastF1 stage would work locally and silently return
nothing on Cloud Run, and a live HTTP round trip inside an agent turn burns
wall-clock against a gate that admits one run at a time. Race control is
instead read out of the cached `race_replay` document, which the website's own
endpoint populated with the *distilled* event list.
"""

from __future__ import annotations

from app import session_recap, strategy_commentary
from app.driver_directory import _driver_directory

from ..ledger import EvidenceLedger
from .base import (
    as_int,
    bundle,
    fact_tool,
    mongo_source,
    resolve_db,
    unavailable,
)

# A lap trace this long is a chart, not a fact. Six drivers at ten samples each
# is 60 rows — enough to describe how a race moved, small enough that a
# question about four drivers still leaves room for the rest of the answer.
MAX_TRACE_DRIVERS = 6
TRACE_SAMPLES = 10


async def _race_document(db, year: int, round_number: int) -> dict | None:
    return await db.race_results.find_one({"season": year, "round": str(round_number)})


async def _race_control_events(db, year: int, round_number: int) -> tuple[list[dict], dict | None]:
    """The distilled race-control events for a round, from the cached replay.

    `race_replay` stores `summarize_race_control`'s output already grouped by
    lap (`race_replay._events_by_lap`), so this is a flatten rather than a
    re-derivation. Two things that distillation drops are worth stating, since
    an answer must not imply they were absent: events with **no lap number**
    are not in the replay at all, and the per-driver `track_limit_deletions`
    tally is not carried on it. Both remain available from OpenF1 through the
    website's own recap path; neither is reachable from Mongo.
    """
    doc = await db.race_replay.find_one({"season": year, "round": str(round_number)})
    replay = (doc or {}).get("replay") or {}
    events: list[dict] = []
    for lap in replay.get("laps") or []:
        lap_number = as_int(lap.get("lap"))
        for event in lap.get("events") or []:
            events.append(
                {
                    "lap": lap_number,
                    "kind": event.get("kind"),
                    "drivers": event.get("drivers") or [],
                    "message": event.get("message"),
                }
            )
    events.sort(key=lambda e: (e["lap"] is None, e["lap"] or 0))
    return events, doc


@fact_tool("get_race_narrative_facts")
async def get_race_narrative_facts(
    year: int,
    round_number: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Podium, movers, retirements, teammates and race control for one race.

    `session_recap.build_facts` is called unchanged — it is the bundle CP38's
    post-mortem produced, and every field in it exists because leaving that
    field to the model went wrong once. Its `race_control` slot is normally
    filled from a live OpenF1 fetch; here it is filled from the cached replay
    instead (see `_race_control_events`), and `build_facts` is handed an empty
    message list so its own `summarize_race_control` call is a no-op rather
    than a bypassed code path.
    """
    db = resolve_db(db)
    doc = await _race_document(db, year, round_number)
    results = (doc or {}).get("results") or []
    if not results:
        return unavailable(
            f"race results for {year} round {round_number} have not been synced"
        )

    facts = session_recap.build_facts((doc or {}).get("race") or {}, results, [])

    events, replay_doc = await _race_control_events(db, year, round_number)
    facts["race_control"] = {
        "events": events,
        "track_limit_deletions": [],
        "source": "race_replay cache" if replay_doc else "not captured",
        # Stated as data rather than left implicit: an empty list here means
        # "not captured", not "nothing happened", and an answer that conflated
        # the two would assert a clean race that may not have been one.
        "complete": bool(replay_doc),
    }

    return bundle(
        data=facts,
        source=mongo_source("race_results", year, round_number),
        docs=[doc, replay_doc],
        ledger=ledger,
        tool="get_race_narrative_facts",
        args={"year": year, "round": round_number},
    )


@fact_tool("get_race_control")
async def get_race_control(
    year: int,
    round_number: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Penalties, investigations, safety cars and red flags, already distilled.

    A race produces ~80 race-control messages, mostly blue flags and sector
    yellow/clear churn. `race_control_facts.summarize_race_control` keeps the
    two or three that shape the story and resolves every car number to a name;
    that distillation is what is cached on the replay and what is returned
    here. Handing the model the raw log instead would bury the penalty that is
    usually the actual answer.
    """
    db = resolve_db(db)
    events, doc = await _race_control_events(db, year, round_number)
    if doc is None:
        return unavailable(
            f"race control for {year} round {round_number} has not been captured; "
            "it is populated when the race replay is first built"
        )

    by_kind: dict[str, int] = {}
    for event in events:
        kind = event.get("kind") or "unknown"
        by_kind[kind] = by_kind.get(kind, 0) + 1

    return bundle(
        data={
            "season": year,
            "round": round_number,
            "event_count": len(events),
            "counts_by_kind": by_kind,
            "events": events,
            "excludes": (
                "events with no lap number, and the per-driver track-limit "
                "deletion tally, are not carried on the cached replay"
            ),
        },
        source=mongo_source("race_replay", year, round_number),
        docs=[doc],
        ledger=ledger,
        tool="get_race_control",
        args={"year": year, "round": round_number},
    )


@fact_tool("get_race_strategy")
async def get_race_strategy(
    year: int,
    round_number: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Stints, stop counts and resolved undercut/overcut events for one race.

    `strategy_commentary.build_facts` is reused whole. Its
    `undercut_overcut_events` list is the reason: whether a stop was an
    undercut is decided by comparing two drivers' track position just before
    the earlier stop against their position a few laps after the later one,
    and that is a judgement a model asked to eyeball lap numbers will make
    confidently and wrongly. An empty list means no pit-window pair flipped
    order — which the prompt contract treats as "say nothing happened", never
    as licence to infer one.

    Requires `race_results`, `race_stints` and `race_laps`. `race_stints` is
    FastF1-sourced and can only be filled by a local sync, so an unsynced round
    reports that specifically rather than a generic miss — the difference
    matters, because it is an operator action rather than a bug.
    """
    db = resolve_db(db)
    key = {"season": year, "round": str(round_number)}

    results_doc = await db.race_results.find_one(key)
    stints_doc = await db.race_stints.find_one(key)
    laps_doc = await db.race_laps.find_one(key)
    stops_doc = await db.pit_stops.find_one(key)

    results = (results_doc or {}).get("results") or []
    stints = (stints_doc or {}).get("stints") or []
    laps = (laps_doc or {}).get("laps") or []
    stops = (stops_doc or {}).get("stops") or []

    missing = [
        name
        for name, value in (
            ("race_results", results),
            ("race_stints", stints),
            ("race_laps", laps),
        )
        if not value
    ]
    if missing:
        return unavailable(
            f"strategy for {year} round {round_number} needs "
            f"{', '.join(missing)}, which {'is' if len(missing) == 1 else 'are'} "
            "not synced for this round"
        )

    facts = strategy_commentary.build_facts(
        (results_doc or {}).get("race") or {}, results, stints, stops, laps
    )
    facts["pit_stop_rows"] = len(stops)

    return bundle(
        data=facts,
        source=mongo_source("race_stints", year, round_number),
        docs=[results_doc, stints_doc, laps_doc, stops_doc],
        ledger=ledger,
        tool="get_race_strategy",
        args={"year": year, "round": round_number},
    )


@fact_tool("get_pit_stops")
async def get_pit_stops(
    year: int,
    round_number: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Every pit stop of a race, plus the aggregates a reader actually asks for.

    Durations are Ergast's **pit lane** time, not stationary time, and a car
    held through a red flag reads as "16:12.356" rather than plain seconds —
    both facts are stated on the bundle, because an answer that calls a 16
    minute pit-lane time "the slowest stop of the race" is technically quoting
    the data and materially misleading.

    Reads the `pit_stops` collection directly. `pit_stops.get_pit_stops`
    self-heals from Ergast on a miss, which is safe from Cloud Run — but it is
    still a live HTTP call inside an agent turn, so it is left to the website's
    own endpoint and the hourly sync.
    """
    db = resolve_db(db)
    doc = await db.pit_stops.find_one({"season": year, "round": str(round_number)})
    stops = (doc or {}).get("stops") or []
    if not stops:
        return unavailable(
            f"pit stops for {year} round {round_number} have not been synced"
        )

    by_driver: dict[str, list[dict]] = {}
    for stop in stops:
        by_driver.setdefault(stop.get("driver_id") or "", []).append(
            {
                "stop": stop.get("stop"),
                "lap": stop.get("lap"),
                "duration": stop.get("duration"),
                "duration_seconds": stop.get("duration_seconds"),
            }
        )

    # Excluded from the "fastest stop" ranking rather than silently included:
    # a red-flag stop is minutes long and would otherwise be the slowest stop
    # of every red-flagged race, which is true and useless.
    timed = [
        s
        for s in stops
        if isinstance(s.get("duration_seconds"), (int, float))
        and s["duration_seconds"] < 60
    ]
    fastest = min(timed, key=lambda s: s["duration_seconds"]) if timed else None

    return bundle(
        data={
            "season": year,
            "round": round_number,
            "total_stops": len(stops),
            "drivers_who_stopped": len(by_driver),
            "fastest_stop": (
                {
                    "driver_id": fastest.get("driver_id"),
                    "lap": fastest.get("lap"),
                    "duration_seconds": fastest.get("duration_seconds"),
                }
                if fastest
                else None
            ),
            "stops_by_driver": by_driver,
            "duration_note": (
                "durations are pit-lane time, not stationary time; a stop held "
                "through a red flag can read as minutes"
            ),
        },
        source=mongo_source("pit_stops", year, round_number),
        docs=[doc],
        ledger=ledger,
        tool="get_pit_stops",
        args={"year": year, "round": round_number},
    )


def _select_numbers(
    requested: list[str] | None, directory: dict[str, dict], numbers_in_laps: list[str]
) -> tuple[list[str], list[str]]:
    """Turn caller-supplied driver references into car numbers.

    Accepts a car number, an Ergast `driver_id` or a three-letter code, because
    those are the three identities the app's own collections use and a caller
    that had to know which one this tool wanted would get it wrong. Returns
    `(numbers, unmatched)` so an unrecognised name is *reported*, never quietly
    dropped — a silently ignored driver produces an answer about the wrong set
    of cars with no sign anything went missing.
    """
    if not requested:
        # Default to whoever finished highest, which is what an unqualified
        # "how did the race unfold" question is about.
        ranked = sorted(
            numbers_in_laps,
            key=lambda n: as_int((directory.get(n) or {}).get("finish_position")) or 99,
        )
        return ranked[:MAX_TRACE_DRIVERS], []

    by_id = {
        (entry.get("driver_id") or "").lower(): number
        for number, entry in directory.items()
        if entry.get("driver_id")
    }
    by_code = {
        (entry.get("code") or "").upper(): number
        for number, entry in directory.items()
        if entry.get("code")
    }

    numbers: list[str] = []
    unmatched: list[str] = []
    for raw in requested:
        token = str(raw).strip()
        number = None
        if token in directory:
            number = token
        elif token.lower() in by_id:
            number = by_id[token.lower()]
        elif token.upper() in by_code:
            number = by_code[token.upper()]
        if number and number not in numbers:
            numbers.append(number)
        elif number is None:
            unmatched.append(token)
    return numbers[:MAX_TRACE_DRIVERS], unmatched


def _downsample(rows: list[dict], samples: int = TRACE_SAMPLES) -> list[dict]:
    """Thin a driver's lap rows to at most `samples`, keeping both ends.

    Evenly spaced rather than "every Nth": an even stride over a 44-lap race
    and a 78-lap race produce different-length traces, and a fixed count keeps
    the context cost of this tool independent of circuit. The first and last
    laps are always kept because a position trace that does not include where
    a driver started and finished cannot answer the question it was called for.
    """
    if len(rows) <= samples:
        return rows
    step = (len(rows) - 1) / (samples - 1)
    picked = {round(i * step) for i in range(samples)}
    picked.add(0)
    picked.add(len(rows) - 1)
    return [rows[i] for i in sorted(picked)]


@fact_tool("get_lap_summary")
async def get_lap_summary(
    year: int,
    round_number: int,
    drivers: list[str] | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """A **downsampled** position and pace picture for a handful of drivers.

    This tool exists to make a rule enforceable rather than aspirational. A
    single race's `race_laps` document is 1000+ rows; put in front of a model
    it would either blow the context window or, worse, fit and crowd out
    everything else in the answer. So the raw rows never leave this function:
    each driver gets a computed summary (start, finish, best, worst, net
    change, how many times their position actually changed) plus a trace
    thinned to at most `TRACE_SAMPLES` points.

    The per-driver summary is the part that matters. "He dropped four places
    and never recovered" is a relational claim, and computing
    `net_positions_gained`, `best_position` and `position_changes` here is what
    stops the model deriving them from a wall of numbers — the same argument
    `session_recap` makes for teammates.
    """
    db = resolve_db(db)
    key = {"season": year, "round": str(round_number)}
    laps_doc = await db.race_laps.find_one(key)
    rows = (laps_doc or {}).get("laps") or []
    if not rows:
        return unavailable(
            f"lap data for {year} round {round_number} has not been synced"
        )

    results_doc = await db.race_results.find_one(key)
    directory = _driver_directory((results_doc or {}).get("results") or [])

    by_number: dict[str, list[dict]] = {}
    for row in rows:
        number = str(row.get("driver_number") or "").strip()
        if not number:
            continue
        by_number.setdefault(number, []).append(row)
    for series in by_number.values():
        series.sort(key=lambda r: as_int(r.get("lap_number")) or 0)

    numbers, unmatched = _select_numbers(drivers, directory, list(by_number))
    if not numbers:
        return unavailable(
            "none of the requested drivers appear in this race's lap data",
            unmatched=unmatched,
        )

    summaries = []
    for number in numbers:
        series = by_number.get(number) or []
        if not series:
            continue
        positions = [as_int(r.get("position")) for r in series]
        positions = [p for p in positions if p is not None]
        if not positions:
            continue
        changes = sum(1 for a, b in zip(positions, positions[1:]) if a != b)
        entry = directory.get(number) or {}
        trace = [
            {
                "lap": as_int(r.get("lap_number")),
                "position": as_int(r.get("position")),
                "gap_to_leader_seconds": r.get("gap_seconds"),
            }
            for r in _downsample(series)
        ]
        summaries.append(
            {
                "driver": entry.get("name") or f"car {number}",
                "driver_id": entry.get("driver_id"),
                "car_number": number,
                "team": entry.get("team"),
                "laps_recorded": len(series),
                "start_position": positions[0],
                "end_position": positions[-1],
                "net_positions_gained": positions[0] - positions[-1],
                "best_position": min(positions),
                "worst_position": max(positions),
                "position_changes": changes,
                "final_gap_to_leader_seconds": series[-1].get("gap_seconds"),
                "trace": trace,
            }
        )

    return bundle(
        data={
            "season": year,
            "round": round_number,
            "total_lap_rows": len(rows),
            "drivers_in_summary": len(summaries),
            "unmatched_requests": unmatched,
            "downsampled_to": TRACE_SAMPLES,
            "sampling": (
                f"each trace is thinned to at most {TRACE_SAMPLES} evenly spaced "
                "laps, always including the first and last; it is a shape, not a "
                "complete record, and no claim should be made about a lap that "
                "is not listed"
            ),
            "drivers": summaries,
        },
        source=mongo_source("race_laps", year, round_number),
        docs=[laps_doc, results_doc],
        ledger=ledger,
        tool="get_lap_summary",
        args={"year": year, "round": round_number, "drivers": drivers},
    )
