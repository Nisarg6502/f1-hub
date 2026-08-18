"""What actually *happens* on track at a circuit, measured from cached races.

This module exists because of a gap found while closing `ROADMAP.md`'s
"Ask about this circuit" backlog item. Two questions were used as the target:

    "who has won most here?"          -> already answered, exactly,
                                         by `agent/tools/circuits.py`'s
                                         `get_circuit_history` over
                                         `historical_race_index`.
    "what makes Monaco hard to
     overtake at?"                    -> answered by NOTHING in this app.

The second is the interesting one, and it is the one a language model will
answer confidently from its own weights ("Monaco is narrow, a street circuit,
with no real straight") while citing nothing. Every clause of that may be true
and none of it is *retrieved*, which is precisely the failure this project's
whole chat architecture is built to refuse (`CHAT-AGENT-PLAN.md` §1). The fix
is not a better prompt: it is having a number to cite.

**The measurement.** `race_laps` holds a position for every driver on every lap
of 52 races (2024-2026). Summing, per race, every place a driver gained between
one lap and the next, and dividing by the number of racing laps, gives a
per-circuit index of how much the order actually churns. Measured over the 24
circuits that have lap data (2026-08-18, the full cached set):

    monaco          0.846  <- lowest, and 1.6x clear of the next
    albert_park     1.388
    miami           1.561
    jeddah          1.850
    ...
    monza           3.123
    catalunya       3.131
    bahrain         3.579  <- highest
    field median    2.410

Monaco comes out at **35% of the field median**, and it is not a close call.
That number is the grounding: an answer can now say "Monaco produced 0.85
position changes per racing lap against a 24-circuit median of 2.41, the lowest
of the 24 circuits with lap data" and cite the rows it came from, instead of
reciting a received opinion about barriers.

That the ranking independently reproduces the sport's own reputation ordering
(Monaco and Albert Park at the bottom, Monza, Spa and Bahrain at the top) is a
sanity check on the metric, and is the only reason to trust a proxy this
coarse. It is a check, not a result — the numbers below are the result.

**What this index is NOT, stated plainly because the name invites the wrong
reading.** It is *not* an overtake count. A place gained between two lap rows
can come from an on-track pass, from a rival retiring, from a pit cycle
unwinding, or from a safety car shuffling the order. Pit-lap gains are excluded
where `pit_stops` covers the round (29 of 52 races), and the field name says
`position_gains_per_lap` rather than "overtakes" so no answer can quote it as
one. The remaining contamination is real and is reported: `pit_excluded_gains`
and `rounds_with_pit_data` travel with the number.

**Rejected: a lap-1 term.** The start is where the most places change hands,
and including it would roughly double every circuit's figure. It is excluded
because there is no lap-0 row — the first countable pair is lap 1 to lap 2 —
and adding a grid-to-lap-1 term would fold a standing start, which is a
launch-and-first-corner event common to every circuit, into a metric meant to
isolate what the *layout* does over a race distance. The grid-to-flag numbers
that do belong to a circuit are reported separately, from `race_results`.

**Rejected: an embedding index over synthesised sentences.** The stretch item
in `CHAT-AGENT-PLAN.md` §13 proposed Atlas Vector Search here. Atlas Vector
Search is genuinely available on this cluster (verified 2026-08-18 by creating
a `vectorSearch` index from the `.env` credentials alone and watching it reach
`READY` and `queryable`, then dropping it — no Atlas Admin API key needed).
It is still the wrong tool for this corpus, for two measured reasons:

1. **There is no prose to embed.** `circuit_history_cache` is 13 documents of
   five scalar fields; `circuit_details` is 27 documents of four. Everything
   this module produces is numeric. A vector index would mean generating
   sentences from structured rows, embedding them, and retrieving them
   approximately, to answer questions an exact `find` on `circuit_id` answers
   with perfect recall over 24 candidates.
2. **There is no embedding model to call.** Ollama Cloud's catalogue was
   probed live on 2026-08-18 (`GET https://ollama.com/api/tags`): 19 models,
   every one of them a chat/instruct model, none an embedding model. So an
   embedding call means a second provider and a second key — which is exactly
   the "no new infrastructure" claim the stretch item rested on — or a local
   embedding model in the agent image, which `requirements-agent.txt` keeps
   FastF1-free specifically to stay small. And on a tier allowing **one
   concurrent model** metered by GPU time, a per-query embedding call adds a
   model call to every circuit question, against a §4.2 whose entire subject
   is cutting calls per answer from six to two.

The cache below is therefore an ordinary Mongo document read in one round
trip. It is not a compromise forced by a missing capability; it is the cheaper
and more accurate design for 24 rows of numbers.
"""

from __future__ import annotations

import datetime
import statistics
from collections import defaultdict

# Bumped whenever a stored field's *meaning* changes, so a cache written by an
# older definition is rebuilt rather than silently mixed with a newer one.
# Same discipline as `race_timing.TIMING_VERSION`, and for the same reason:
# `HANDOFF.md` records 59 of 70 dead `race_timing` documents surviving version
# bumps unnoticed, so a version that is not checked on read is decoration.
CHARACTER_VERSION = 1

CACHE_COLLECTION = "circuit_character_cache"
CACHE_ID = "circuit_character"


# --- pure computation ------------------------------------------------------
#
# Everything below takes plain documents and returns plain values, so the whole
# metric is unit-testable with no database. That is not a style preference: the
# discriminating test for this feature is that the ranking *inverts* when the
# underlying laps are inverted, and that test needs to hand the computation a
# fabricated race.


def as_int(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def classify_result(row: dict) -> str:
    """`classified` / `retired` / `did_not_start` / `disqualified` for one row.

    Reads **`positionText`**, not `status`. The two disagree in this database
    and `positionText` is the one that is right: a cross-tab over all 801
    stored result rows (2026-08-18) found 13 rows with a numeric position and
    a `"Retired"` status — drivers who stopped near the end having completed
    enough distance to be classified — and 2 rows with `positionText: "R"` and
    a `"Lapped"` status. Counting the first group as retirements inflates the
    retirement rate at exactly the circuits where cars break.

    The status vocabulary here is also not raw Ergast: this database stores
    `"Lapped"` (222 rows) where Ergast writes `"+1 Lap"`, and both spellings
    are present (5 rows). A classifier keyed on status strings would have to
    know both; `positionText` needs neither.
    """
    text = str(row.get("positionText") or "").strip()
    if text.isdigit():
        return "classified"
    return {
        "R": "retired",
        "D": "disqualified",
        "W": "did_not_start",
        "E": "did_not_start",
        "F": "did_not_start",
        "N": "retired",
    }.get(text.upper(), "retired")


def count_position_gains(
    lap_rows: list[dict], pit_laps: dict[int, set[int]] | None = None
) -> tuple[int, int, int]:
    """`(gains, gains_on_pit_laps, racing_laps)` for one race's lap rows.

    A "gain" is a place improved between two *consecutive* lap rows for the
    same driver. Non-consecutive pairs are skipped rather than bridged: a
    missing lap row usually means a driver's timing dropped out, and bridging
    the gap would credit them with every place that changed hands while they
    were invisible.

    `racing_laps` is the highest lap number seen, i.e. the winner's distance —
    the denominator that makes a 71-lap race comparable with a 44-lap one.

    Pit-lap gains are counted in the total *and* reported separately rather
    than subtracted here. The caller decides, because whether the exclusion is
    even possible varies by round (`pit_stops` covers 29 of 52 races), and a
    number that is silently corrected on some circuits and not others is worse
    than one that reports its own coverage.
    """
    pit_laps = pit_laps or {}
    by_driver: dict[int, dict[int, int]] = defaultdict(dict)
    racing_laps = 0
    for row in lap_rows:
        number = as_int(row.get("driver_number"))
        lap = as_int(row.get("lap_number"))
        position = as_int(row.get("position"))
        if number is None or lap is None or position is None:
            continue
        by_driver[number][lap] = position
        racing_laps = max(racing_laps, lap)

    gains = 0
    pit_gains = 0
    for number, series in by_driver.items():
        stops = pit_laps.get(number) or set()
        ordered = sorted(series)
        for previous, current in zip(ordered, ordered[1:]):
            if current != previous + 1:
                continue
            gained = series[previous] - series[current]
            if gained <= 0:
                continue
            gains += gained
            if current in stops or previous in stops:
                pit_gains += gained
    return gains, pit_gains, racing_laps


def summarise_results(result_docs: list[dict]) -> dict:
    """Grid-to-flag facts for one circuit, from `race_results` documents.

    Deliberately narrow. This does **not** tally who has won here — that is
    `get_circuit_history`'s job over the full 1950-present index, and a second,
    quieter winner tally computed over the three or four seasons this app
    happens to have synced is the most dangerous thing this module could
    return. "Verstappen has won here twice" (2024-2026) sitting beside "Senna
    won here six times" (all time) invites exactly the conflation the Indy-500
    note in `tools/circuits.py` exists to prevent. Winners are not here on
    purpose.

    `grid == 0` is a pit-lane start, and it is excluded from the delta rather
    than treated as 0th on the grid — 2 of 801 stored rows have it, and each
    would otherwise contribute a fabricated ~+18 place gain.
    """
    deltas: list[int] = []
    outcomes: dict[str, int] = {
        "classified": 0,
        "retired": 0,
        "did_not_start": 0,
        "disqualified": 0,
    }
    winner_grid_slots: list[int] = []
    entries = 0

    for doc in result_docs:
        for row in doc.get("results") or []:
            entries += 1
            outcomes[classify_result(row)] += 1
            grid = as_int(row.get("grid"))
            position = as_int(row.get("position"))
            if position == 1 and grid is not None:
                winner_grid_slots.append(grid)
            if (
                classify_result(row) == "classified"
                and grid is not None
                and grid > 0
                and position is not None
            ):
                deltas.append(grid - position)

    finishers = outcomes["classified"]
    return {
        "races_sampled": len(result_docs),
        "entries": entries,
        "outcomes": outcomes,
        "retirement_rate": round(outcomes["retired"] / entries, 3) if entries else None,
        "mean_abs_grid_to_finish": (
            round(statistics.fmean(abs(d) for d in deltas), 2) if deltas else None
        ),
        "median_places_gained": statistics.median(deltas) if deltas else None,
        "drivers_who_gained_places": sum(1 for d in deltas if d > 0),
        "drivers_compared": len(deltas),
        "winner_grid_slots": winner_grid_slots,
        "pole_to_win": sum(1 for slot in winner_grid_slots if slot == 1),
        "finishers": finishers,
    }


def rank_and_median(values: dict[str, float]) -> tuple[dict[str, int], float | None]:
    """Ascending rank per key (1 = smallest) and the median over all values.

    Ascending because the question this serves is "is it hard to overtake
    here", so rank 1 should be the hardest circuit rather than the easiest.
    """
    if not values:
        return {}, None
    ordered = sorted(values.items(), key=lambda kv: (kv[1], kv[0]))
    ranks = {key: index + 1 for index, (key, _) in enumerate(ordered)}
    return ranks, round(statistics.median(values.values()), 3)


# --- cache -----------------------------------------------------------------


async def _round_key_to_circuit(db) -> dict[tuple[int, str], str]:
    """`(season, round)` -> `circuitId`, from the calendar.

    `round` is stored as a string in `races`, `race_laps`, `race_results` and
    `pit_stops` alike, but as an int in a few older writes; every lookup here
    normalises with `str()` rather than trusting one side.
    """
    mapping: dict[tuple[int, str], str] = {}
    async for doc in db.races.find({}, {"season": 1, "round": 1, "Circuit.circuitId": 1}):
        circuit_id = ((doc.get("Circuit") or {}).get("circuitId") or "").strip().lower()
        if circuit_id and doc.get("season") is not None:
            mapping[(doc["season"], str(doc.get("round")))] = circuit_id
    return mapping


async def _pit_laps_by_round(db, numbers_by_round) -> dict[tuple[int, str], dict[int, set[int]]]:
    """Laps on which each car pitted, keyed by car number.

    `pit_stops` records a `driver_id`; `race_laps` records a `driver_number`.
    Bridging them needs `race_results`, which carries both — so a round with no
    stored classification cannot have its pit laps excluded at all, and is
    reported as such rather than silently counted raw.

    The stop lap *and the one after it* are both marked. A stop on lap 20 costs
    places on lap 20 (the in-lap) and hands some back on lap 21 (the out-lap
    and the rivals' own stops unwinding), and marking only one of the two
    leaves half of a pit cycle inside a metric about racing.
    """
    out: dict[tuple[int, str], dict[int, set[int]]] = {}
    async for doc in db.pit_stops.find({}):
        key = (doc.get("season"), str(doc.get("round")))
        numbers = numbers_by_round.get(key)
        if not numbers:
            continue
        laps: dict[int, set[int]] = defaultdict(set)
        for stop in doc.get("stops") or []:
            number = numbers.get(stop.get("driver_id"))
            lap = as_int(stop.get("lap"))
            if number is not None and lap is not None:
                laps[number].add(lap)
                laps[number].add(lap + 1)
        out[key] = dict(laps)
    return out


async def _numbers_by_round(db) -> dict[tuple[int, str], dict[str, int]]:
    out: dict[tuple[int, str], dict[str, int]] = {}
    async for doc in db.race_results.find({}, {"season": 1, "round": 1, "results": 1}):
        key = (doc.get("season"), str(doc.get("round")))
        mapping: dict[str, int] = {}
        for row in doc.get("results") or []:
            driver_id = ((row.get("Driver") or {}).get("driverId") or "").strip()
            number = as_int(row.get("number"))
            if driver_id and number is not None:
                mapping[driver_id] = number
        out[key] = mapping
    return out


async def _safety_cars_by_round(db) -> dict[tuple[int, str], int]:
    """Safety-car and VSC deployments per round, from the cached replay.

    Read off `race_replay` rather than OpenF1 for the reason
    `agent/tools/race.py` gives at length: the distilled events are already on
    the replay document, and a live fetch inside a question is the exact path
    that works locally and returns nothing on Cloud Run.
    """
    out: dict[tuple[int, str], int] = {}
    async for doc in db.race_replay.find({}, {"season": 1, "round": 1, "replay.laps": 1}):
        key = (doc.get("season"), str(doc.get("round")))
        laps = ((doc.get("replay") or {}).get("laps")) or []
        out[key] = sum(
            1
            for lap in laps
            for event in (lap.get("events") or [])
            if event.get("kind") == "safety_car_deployed"
        )
    return out


async def build_index(db) -> dict:
    """Compute every circuit's character from the cached collections.

    One pass over `race_laps` (52 documents of ~1000 rows each) and one over
    each of four small collections. **Measured against the live Atlas cluster
    on 2026-08-18: 1.50s to build, 0.03s to read back from the cache.** That
    50x gap is the whole reason the cache exists, and the 1.50s is why
    `load_index` is allowed to rebuild inside an agent turn rather than
    refusing — it is a fraction of one model call on a turn budget measured in
    tens of seconds.
    """
    circuits = await _round_key_to_circuit(db)
    numbers = await _numbers_by_round(db)
    pit_laps = await _pit_laps_by_round(db, numbers)
    safety_cars = await _safety_cars_by_round(db)

    per_circuit: dict[str, dict] = defaultdict(
        lambda: {
            "gains": 0,
            "pit_excluded_gains": 0,
            "racing_laps": 0,
            "rounds_with_laps": 0,
            "rounds_with_pit_data": 0,
            "seasons": set(),
            "safety_car_deployments": 0,
            "rounds_with_replay": 0,
        }
    )

    async for doc in db.race_laps.find({}):
        key = (doc.get("season"), str(doc.get("round")))
        circuit_id = circuits.get(key)
        if not circuit_id:
            continue
        stops = pit_laps.get(key)
        gains, pit_gains, racing_laps = count_position_gains(
            doc.get("laps") or [], stops
        )
        if racing_laps <= 0:
            continue
        row = per_circuit[circuit_id]
        row["gains"] += gains
        row["pit_excluded_gains"] += pit_gains
        row["racing_laps"] += racing_laps
        row["rounds_with_laps"] += 1
        row["rounds_with_pit_data"] += 1 if stops else 0
        if doc.get("season") is not None:
            row["seasons"].add(doc["season"])
        if key in safety_cars:
            row["safety_car_deployments"] += safety_cars[key]
            row["rounds_with_replay"] += 1

    results_by_circuit: dict[str, list[dict]] = defaultdict(list)
    async for doc in db.race_results.find({}):
        circuit_id = circuits.get((doc.get("season"), str(doc.get("round"))))
        if circuit_id:
            results_by_circuit[circuit_id].append(doc)

    indices: dict[str, float] = {}
    for circuit_id, row in per_circuit.items():
        net = row["gains"] - row["pit_excluded_gains"]
        indices[circuit_id] = round(net / row["racing_laps"], 3)
    ranks, field_median = rank_and_median(indices)

    circuits_out: dict[str, dict] = {}
    for circuit_id in set(per_circuit) | set(results_by_circuit):
        row = per_circuit.get(circuit_id)
        entry: dict = {"circuit_id": circuit_id}
        if row and row["racing_laps"]:
            entry["position_gains_per_lap"] = indices[circuit_id]
            entry["rank_least_position_change"] = ranks[circuit_id]
            entry["raw_gains"] = row["gains"]
            entry["pit_excluded_gains"] = row["pit_excluded_gains"]
            entry["racing_laps"] = row["racing_laps"]
            entry["rounds_with_laps"] = row["rounds_with_laps"]
            entry["rounds_with_pit_data"] = row["rounds_with_pit_data"]
            entry["lap_data_seasons"] = sorted(row["seasons"])
            if row["rounds_with_replay"]:
                entry["safety_car_deployments"] = row["safety_car_deployments"]
                entry["rounds_with_race_control"] = row["rounds_with_replay"]
        if results_by_circuit.get(circuit_id):
            entry["results"] = summarise_results(results_by_circuit[circuit_id])
        circuits_out[circuit_id] = entry

    return {
        "_id": CACHE_ID,
        "version": CHARACTER_VERSION,
        "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        # The freshness key (see `load_index`). Counted from the collection
        # rather than summed from `rounds_folded` below, because the two are
        # allowed to differ — a `race_laps` document for a round missing from
        # the calendar folds into no circuit — and a freshness key that drifts
        # from the thing it is watching rebuilds on every single read.
        "source_lap_documents": await db.race_laps.count_documents({}),
        "rounds_folded": sum(row["rounds_with_laps"] for row in per_circuit.values()),
        "field": {
            "circuits_with_lap_data": len(indices),
            "median_position_gains_per_lap": field_median,
            "lowest": min(indices, key=indices.get) if indices else None,
            "highest": max(indices, key=indices.get) if indices else None,
        },
        "circuits": circuits_out,
    }


async def load_index(db, *, rebuild: bool = True) -> dict | None:
    """The cached index, rebuilt when it is missing, stale or a version behind.

    **Freshness is keyed on the source document count, not on a clock.** The
    inputs only change when a race is synced, so a 24-hour staleness check like
    `circuit_history.py`'s would do both wrong things at once: rebuild 23 times
    for nothing between rounds, and serve a stale index for up to a day after a
    new race lands. Counting `race_laps` is one cheap server-side count and
    rebuilds exactly when there is something new to fold in.

    `rebuild=False` exists for the agent tool's own use — see
    `agent/tools/circuit_scope.py`, which will not spend an agent turn's
    wall-clock budget on a full rebuild and reports the cache as unavailable
    instead.
    """
    doc = await db[CACHE_COLLECTION].find_one({"_id": CACHE_ID})
    current = await db.race_laps.count_documents({})
    fresh = (
        doc is not None
        and doc.get("version") == CHARACTER_VERSION
        and doc.get("source_lap_documents") == current
    )
    if fresh:
        return doc
    if not rebuild:
        return None
    built = await build_index(db)
    await db[CACHE_COLLECTION].replace_one({"_id": CACHE_ID}, built, upsert=True)
    return built
