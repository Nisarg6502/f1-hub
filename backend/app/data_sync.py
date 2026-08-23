"""Data sync job — pulls the season from Ergast/FastF1/OpenF1 into MongoDB.

Runs as a Cloud Run Job on an hourly schedule, or locally:

    MONGODB_URI="mongodb+srv://..." python -m app.data_sync

The schedule and standings are refreshed on every run because they change
between races. Everything keyed to a specific session — results, practice
classifications, circuit details, weather — is only fetched once that session
has been run and isn't in Mongo yet. That keeps a routine run to a handful of
requests and well inside the job timeout, while still filling a Friday
practice on Friday rather than after the race.

Set SYNC_YEARS ("2025,2026") to sync specific seasons, or FORCE_RESYNC=1 to
refetch sessions that are already stored.
"""

import datetime
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pymongo import MongoClient

from .f1_results import (
    enable_cache,
    has_classification,
    load_session,
    safe_str,
    session_total_laps,
)
from .historical_index import normalize_races

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"
FORCE_RESYNC = os.getenv("FORCE_RESYNC", "").lower() in ("1", "true", "yes")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
OPENF1_BASE = "https://api.openf1.org/v1"
USER_AGENT = "f1-scratch-sync/1.0"

# Schedule field on the race document -> FastF1 session code.
PRACTICE_SESSIONS = {
    "FirstPractice": "FP1",
    "SecondPractice": "FP2",
    "ThirdPractice": "FP3",
    "SprintQualifying": "SQ",
}


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def fetch_json(url: str, max_retries: int = 3):
    """Fetch JSON, backing off on rate limits."""
    for attempt in range(1, max_retries + 1):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if error.code == 429:
                wait = 5 * attempt
                print(f"    rate limited, waiting {wait}s (attempt {attempt}/{max_retries})")
                time.sleep(wait)
                continue
            print(f"    HTTP {error.code} for {url} (attempt {attempt}/{max_retries})")
        except (URLError, json.JSONDecodeError, OSError) as error:
            print(f"    error fetching {url}: {error} (attempt {attempt}/{max_retries})")
        if attempt < max_retries:
            time.sleep(2 * attempt)
    return None


def _session_start(date: str | None, time_str: str | None) -> datetime.datetime | None:
    if not date:
        return None
    base = time_str or "12:00:00Z"
    iso = f"{date}T{base}" if base.endswith("Z") else f"{date}T{base}Z"
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def _ergast_table(data, table: str, key: str) -> list:
    return (data or {}).get("MRData", {}).get(table, {}).get(key, [])


# --- Schedule, standings and entry lists (refreshed every run) ---


def sync_races(db, year: int) -> None:
    print("  races...")
    races = _ergast_table(fetch_json(f"{ERGAST_BASE}/{year}/races/"), "RaceTable", "Races")
    if not races:
        print("    no races returned")
        return

    for race in races:
        db.races.update_one(
            {"season": year, "round": race.get("round")},
            {"$set": {**race, "season": year, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
    print(f"    synced {len(races)} races")


def _sync_standings(db, year: int, path: str, key: str, collection, label: str) -> None:
    print(f"  {label}...")
    lists = _ergast_table(
        fetch_json(f"{ERGAST_BASE}/{year}/{path}/"), "StandingsTable", "StandingsLists"
    )
    standings = lists[0].get(key, []) if lists else []
    if not standings:
        print(f"    no {label} returned")
        return

    collection.update_one(
        {"season": year},
        {"$set": {"season": year, "standings": standings, "synced_at": _utcnow_iso()}},
        upsert=True,
    )
    print(f"    synced {len(standings)} {label}")


# --- Per-round data (only for completed rounds we haven't stored yet) ---


def _round_key(race: dict) -> int:
    try:
        return int(race.get("round", 0))
    except (TypeError, ValueError):
        return 0


# A grand prix runs roughly two hours. Anything derived from the finished race —
# its fastest lap, its mid-race weather — must wait for the flag, or the value
# gets computed from a partial session and then cached as if it were final.
RACE_DURATION_HOURS = 4

# Schedule field -> how long after its start that session's result should
# exist. Only used to decide when it is worth ASKING an upstream for a result,
# so it is deliberately generous rather than exact: asking an hour early costs
# one request that returns nothing and is retried on the next run, whereas
# asking too late leaves a finished session missing from the site for hours.
SESSION_SETTLE_HOURS: dict[str, float] = {
    "FirstPractice": 1.5,
    "SecondPractice": 1.5,
    "ThirdPractice": 1.5,
    "SprintQualifying": 1.5,
    "Sprint": 1.5,
    "Qualifying": 1.5,
    # Shorter than RACE_DURATION_HOURS on purpose. That constant guards things
    # COMPUTED from the whole race (fastest lap, weather), which must not be
    # derived from a half-run session. This one only decides when to ask Ergast
    # for a results table it either has or does not — a race is over inside two
    # hours barring a suspension, and an early ask returns nothing and retries.
    "Race": 2.0,
}

# Every session a weekend can contain, in the order they are run. `Race` is the
# race document's own `date`/`time`, not a sub-document, which is why
# `_session_window` special-cases it.
WEEKEND_SESSIONS = (
    "FirstPractice",
    "SecondPractice",
    "ThirdPractice",
    "SprintQualifying",
    "Sprint",
    "Qualifying",
    "Race",
)


def _session_window(race: dict, field: str) -> datetime.datetime | None:
    """Start time of one session of `race`, or None if the weekend has no such session."""
    if field == "Race":
        return _session_start(race.get("date"), race.get("time"))
    session = race.get(field)
    if not isinstance(session, dict):
        return None
    return _session_start(session.get("date"), session.get("time"))


def _has_session_schedule(race: dict) -> bool:
    """True if this race document carries any per-session times at all.

    Ergast only began publishing them around 2021 — every season in this
    database has them on every round (checked 2026-08-21: 2021, 2024, 2025 and
    2026 all carry `FirstPractice` and `Qualifying` on 100% of rounds). But
    `SYNC_YEARS` will happily accept 2010, and there an absent `Qualifying`
    means "we don't know when it was", not "the weekend had no qualifying".
    Without this distinction that season's qualifying would never sync, and it
    would fail silently.
    """
    return any(
        isinstance(race.get(field), dict)
        for field in WEEKEND_SESSIONS
        if field != "Race"
    )


def _session_has_run(race: dict, field: str) -> bool:
    """True once `field`'s result should be published and is worth fetching."""
    start = _session_window(race, field)
    if start is None:
        # An absent session on a weekend we DO have times for is a session that
        # weekend genuinely never had — a sprint weekend has no FP3. With no
        # times at all, fall back to the old race-start gate rather than
        # skipping the season entirely.
        if field == "Race" or _has_session_schedule(race):
            return False
        return _session_has_run(race, "Race")
    settle = SESSION_SETTLE_HOURS.get(field, RACE_DURATION_HOURS)
    return start + datetime.timedelta(hours=settle) < _utcnow()


def _rounds_in_play(db, year: int) -> list[dict]:
    """Rounds whose weekend has begun — the earliest session has started.

    **This is the gate for anything session-scoped, and `_completed_rounds` is
    not.** Practice, qualifying and sprint results used to be synced only for
    rounds whose *race* had started, which meant a session run on Friday was
    not even asked for until Sunday afternoon. Verified against production: on
    2026-08-21, every practice document in the database had a `synced_at`
    AFTER its round's race start — round 11's Friday practice was written on
    the Monday, round 10's on the Tuesday — and the Dutch GP's completed FP1
    and sprint qualifying had no document at all while the race was still two
    days away. The site showed "timing not published yet" for sessions that had
    finished hours earlier, and the cause was here, not upstream.

    Callers still filter per session with `_session_has_run`; this only decides
    which rounds are worth looking at.
    """
    races = list(db.races.find({"season": year}, {"_id": 0, "synced_at": 0}))
    now = _utcnow()
    in_play = []
    for race in races:
        starts = [
            start
            for field in WEEKEND_SESSIONS
            if (start := _session_window(race, field)) is not None
        ]
        if starts and min(starts) < now:
            in_play.append(race)
    return sorted(in_play, key=_round_key)


def _completed_rounds(db, year: int, *, settled: bool = False) -> list[dict]:
    """Races whose start time has passed, oldest first.

    `settled=True` additionally waits for the race to be over, for callers that
    summarise the whole session rather than read a results table that simply
    isn't published yet.
    """
    cutoff = _utcnow()
    if settled:
        cutoff -= datetime.timedelta(hours=RACE_DURATION_HOURS)

    races = list(db.races.find({"season": year}, {"_id": 0, "synced_at": 0}))
    started = [
        race
        for race in races
        if (start := _session_start(race.get("date"), race.get("time"))) and start < cutoff
    ]
    return sorted(started, key=_round_key)


def _already_stored(
    collection,
    query: dict,
    *,
    classified: bool = False,
    source: str | None = None,
) -> bool:
    """True if this session is already stored and worth keeping.

    `classified=True` rejects rows without positions, so practice entries
    written before the classification was derived from laps get refetched
    rather than skipped forever.

    `source="ergast"` rejects documents that came from somewhere else. The
    FastF1 fallback in the API writes a thinner shape (no grid, laps, status or
    FastestLap), so without this a stopgap written minutes after the flag would
    never be replaced once Ergast published the full result.
    """
    if FORCE_RESYNC:
        return False
    doc = collection.find_one(query, {"_id": 1, "results": 1, "source": 1})
    if not doc or not doc.get("results"):
        return False
    if source is not None and doc.get("source") != source:
        return False
    return has_classification(doc["results"]) if classified else True


def sync_session_results(db, year: int, races: list[dict]) -> None:
    """Race, qualifying and sprint results from Ergast.

    Each job is gated on its OWN session having run, not on the race having
    started — Saturday's qualifying is published on Saturday, and waiting for
    Sunday to ask for it left the site a day stale for no reason.
    """
    jobs = [
        ("results", "Results", db.race_results, "race", "Race"),
        ("qualifying", "QualifyingResults", db.qualifying_results, "qualifying", "Qualifying"),
        ("sprint", "SprintResults", db.sprint_results, "sprint", "Sprint"),
    ]

    for path, key, collection, label, schedule_field in jobs:
        synced = 0
        for race in races:
            round_number = race.get("round")
            # A sprint only exists on sprint weekends, and a session that has
            # not run yet has nothing to publish. `_session_has_run` covers
            # both: an absent session never counts as run.
            if not _session_has_run(race, schedule_field):
                continue
            if _already_stored(
                collection, {"season": year, "round": str(round_number)}, source="ergast"
            ):
                continue

            data = fetch_json(f"{ERGAST_BASE}/{year}/{round_number}/{path}/")
            races_data = _ergast_table(data, "RaceTable", "Races")
            if not races_data:
                continue

            race_data = races_data[0]
            results = race_data.get(key, [])
            if not results:
                continue

            collection.update_one(
                {"season": year, "round": str(round_number)},
                {"$set": {
                    "season": year,
                    "round": str(round_number),
                    "race": {k: v for k, v in race_data.items() if k != key},
                    "results": results,
                    "source": "ergast",
                    "synced_at": _utcnow_iso(),
                }},
                upsert=True,
            )
            synced += 1
            time.sleep(0.5)

        print(f"  {label} results: synced {synced} new round(s)")


def sync_practice_results(db, year: int, races: list[dict]) -> None:
    """Practice and sprint-qualifying classifications via FastF1.

    Which sessions to ask for comes from the schedule, so a sprint weekend
    isn't asked for the FP2/FP3 it never had — and each is gated on having
    actually been run, so Friday practice is fetched on Friday rather than
    waiting for the race two days later.
    """
    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        for schedule_field, session_code in PRACTICE_SESSIONS.items():
            if not _session_has_run(race, schedule_field):
                continue
            if _already_stored(
                db.practice_results,
                {"season": year, "round": str(round_number), "session": session_code},
                classified=True,
            ):
                continue

            try:
                event_name, results = load_session(year, round_number, session_code)
            except Exception as error:
                print(f"    {session_code} R{round_number} unavailable: {error}")
                continue

            if not results:
                continue

            db.practice_results.update_one(
                {"season": year, "round": str(round_number), "session": session_code},
                {"$set": {
                    "season": year,
                    "round": str(round_number),
                    "session": session_code,
                    "event_name": event_name,
                    "results": results,
                    "synced_at": _utcnow_iso(),
                }},
                upsert=True,
            )
            synced += 1

    print(f"  practice/SQ: synced {synced} new session(s)")


def _first_grand_prix(circuit_id: str) -> str:
    """Season of the first world-championship race held at a circuit."""
    if not circuit_id:
        return ""
    races = _ergast_table(
        fetch_json(f"{ERGAST_BASE}/circuits/{circuit_id}/races/?limit=1"),
        "RaceTable",
        "Races",
    )
    return races[0].get("season", "") if races else ""


def _build_circuit_detail(year: int, race: dict) -> dict | None:
    """Assemble the 'Track DNA' document the circuits page renders.

    Only fields FastF1 actually exposes are stored. Circuit length, race
    distance and DRS-zone counts are deliberately absent: they are not on the
    Event object, and deriving them needs position/car telemetry that the F1
    archives do not publish for every session. The UI omits what is missing
    rather than showing a fabricated zero.
    """
    import fastf1

    round_number = int(race.get("round", 0))
    enable_cache()

    try:
        session = fastf1.get_session(year, round_number, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        print(f"    circuit details R{round_number} unavailable: {error}")
        return None

    total_laps = session_total_laps(session)

    corners = None
    try:
        corners = len(session.get_circuit_info().corners) or None
    except Exception as error:
        print(f"    circuit geometry R{round_number} unavailable: {error}")

    lap_record = None
    try:
        fastest = session.laps.pick_fastest()
        if fastest is not None:
            lap_time = safe_str(fastest.get("LapTime"))
            driver = safe_str(fastest.get("Driver"))
            if lap_time:
                lap_record = f"{lap_time} ({driver})" if driver else lap_time
    except Exception:
        # A cancelled or lapless race has no record to report.
        pass

    circuit = race.get("Circuit", {})
    location = circuit.get("Location", {})

    return {
        "round": round_number,
        "season": year,
        "country": location.get("country", ""),
        "circuit_name": circuit.get("circuitName", ""),
        "grand_prix": race.get("raceName", ""),
        "date": race.get("date", ""),
        "track_information": {
            "first_grand_prix": _first_grand_prix(circuit.get("circuitId", "")) or None,
            "number_of_laps": total_laps,
            "number_of_corners": corners,
            "lap_record": lap_record,
        },
    }


def sync_circuit_details(db, year: int, races: list[dict]) -> None:
    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        if not FORCE_RESYNC and db.circuit_details.find_one(
            {"season": year, "round": round_number}
        ):
            continue

        detail = _build_circuit_detail(year, race)
        if not detail:
            continue

        db.circuit_details.update_one(
            {"season": year, "round": round_number},
            {"$set": {**detail, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
        synced += 1

    print(f"  circuit details: synced {synced} new round(s)")


def sync_race_stints(db, year: int, races: list[dict]) -> None:
    """Per-driver tyre stints via FastF1, which replaced the OpenF1 feed back
    when OpenF1 paywalled the current season (that paywall lifted 2026-07).

    Like `sync_circuit_details` this reads the live-timing archive, which 403s
    from Cloud Run — so in practice this only populates when the job is run
    from a local machine after a race weekend. The API serves whatever is here
    and reports an empty result rather than an error when a round is missing.
    """
    from .race_stints import build_race_stints

    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        if not FORCE_RESYNC and db.race_stints.find_one(
            {"season": year, "round": str(round_number)}
        ):
            continue

        stints = build_race_stints(year, round_number)
        if not stints:
            continue

        db.race_stints.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "stints": stints,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
        synced += 1

    print(f"  race stints: synced {synced} new round(s)")


def sync_race_laps(db, year: int, races: list[dict]) -> None:
    """Per-driver, per-lap track position and gap-to-leader via FastF1, for the Pitwall chart.

    Same FastF1-on-Cloud-Run caveat as `sync_race_stints`: this only populates
    when run from a local machine. The API serves whatever is here and reports
    an empty result rather than an error when a round is missing. A round
    synced before `gap_seconds` existed just won't have it on its rows until
    it's re-synced (`FORCE_RESYNC`) -- see `race_laps.py`'s module docstring
    for why that's a safe, non-crashing degradation rather than a problem.
    """
    from .race_laps import build_race_laps

    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        if not FORCE_RESYNC and db.race_laps.find_one(
            {"season": year, "round": str(round_number)}
        ):
            continue

        laps = build_race_laps(year, round_number)
        if not laps:
            continue

        db.race_laps.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "laps": laps,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
        synced += 1

    print(f"  race laps: synced {synced} new round(s)")


def sync_pit_stops(db, year: int, races: list[dict]) -> None:
    """Per-driver pit stops from Ergast.

    Unlike `sync_race_stints` this source is reachable from Cloud Run, so the
    hourly job actually keeps it current without anyone running the sync
    locally. Stops are published with the race result, so a round that returns
    nothing is simply retried on the next run.
    """
    from .pit_stops import fetch_pit_stops

    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        if not FORCE_RESYNC and db.pit_stops.find_one(
            {"season": year, "round": str(round_number)}
        ):
            continue

        stops = fetch_pit_stops(year, round_number)
        if not stops:
            continue

        db.pit_stops.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "stops": stops,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
        synced += 1
        time.sleep(0.5)

    print(f"  pit stops: synced {synced} new round(s)")


def sync_weather(db, year: int, races: list[dict]) -> None:
    from .session_results import WEATHER_SCHEMA_VERSION, fetch_openf1_weather

    synced = 0
    for race in races:
        round_number = race.get("round")
        race_date = race.get("date")
        if not race_date:
            continue
        # Write-once, but per SCHEMA VERSION rather than per existence.
        #
        # The plain existence check meant any improvement to how weather is
        # read only ever reached rounds synced after the deploy — every round
        # already in the collection kept the old shape forever, and the only
        # escape was `FORCE_RESYNC=1`, which re-fetches every collection in the
        # database to fix one of them. Comparing the stored version lets a
        # weather-shape change back-fill itself on the next hourly run and
        # nothing else re-sync at all.
        if not FORCE_RESYNC:
            cached = db.weather_cache.find_one(
                {"season": year, "round": str(round_number)}, {"weather_schema": 1}
            )
            if cached and cached.get("weather_schema", 1) >= WEATHER_SCHEMA_VERSION:
                continue

        weather = fetch_openf1_weather(year, race_date)
        if not weather:
            continue

        db.weather_cache.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "date": race_date,
                **weather,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
        synced += 1
        time.sleep(0.5)

    print(f"  weather: synced {synced} new round(s)")


# --- Historical race index (season-independent; synced once per run, not per year) ---


def sync_historical_index(db) -> None:
    """Keep `historical_race_index` fresh: a full 1950-present backfill the
    first time the collection is empty (12 paginated Jolpica calls, ~4s),
    then a cheap current-season-only top-up on every subsequent run — the
    rest of history never changes once a season is over. Normalisation
    (de-duplicating shared-drive races, collapsing chassis/engine-era
    constructor ids, flagging the Indy 500 years) lives in
    `historical_index.normalize_races` so the sync job and the API's own
    live-fetch self-heal can never disagree on the shape of a race record.
    """
    print("  historical race index...")

    if db.historical_race_index.count_documents({}) == 0:
        print("    collection empty — full backfill (1950-present)...")
        raw: list[dict] = []
        page_size = 100
        offset = 0
        while True:
            payload = fetch_json(f"{ERGAST_BASE}/results/1/?limit={page_size}&offset={offset}")
            page = _ergast_table(payload, "RaceTable", "Races")
            if not page:
                break
            raw.extend(page)
            # `total` counts result rows, not races (a few races carry two P1
            # rows) — advance by page_size regardless, same reasoning as
            # historical_index._pagination_from.
            total = int((payload or {}).get("MRData", {}).get("total", 0) or 0)
            offset += page_size
            if offset >= total:
                break

        records = normalize_races(raw)
        if records:
            db.historical_race_index.insert_many(records, ordered=False)
        print(f"    backfilled {len(records)} races")
        return

    year = _utcnow().year
    payload = fetch_json(f"{ERGAST_BASE}/{year}/results/1/?limit=100")
    raw = _ergast_table(payload, "RaceTable", "Races")
    records = normalize_races(raw)

    synced = 0
    for record in records:
        result = db.historical_race_index.update_one(
            {"season": record["season"], "round": record["round"]},
            {"$set": record},
            upsert=True,
        )
        if result.upserted_id is not None:
            synced += 1
    print(f"    top-up: {len(records)} race(s) checked for {year}, {synced} new")


def create_indexes(db) -> None:
    db.races.create_index([("season", 1), ("round", 1)], unique=True)
    db.driver_standings.create_index([("season", 1)], unique=True)
    db.constructor_standings.create_index([("season", 1)], unique=True)
    db.race_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.qualifying_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.sprint_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.practice_results.create_index(
        [("season", 1), ("round", 1), ("session", 1)], unique=True
    )
    # Populated lazily by /api/session_sectors on demand, not by this batch job.
    db.session_sectors.create_index(
        [("season", 1), ("round", 1), ("session", 1)], unique=True
    )
    db.circuit_details.create_index([("season", 1), ("round", 1)], unique=True)
    db.race_stints.create_index([("season", 1), ("round", 1)], unique=True)
    db.pit_stops.create_index([("season", 1), ("round", 1)], unique=True)
    db.race_laps.create_index([("season", 1), ("round", 1)], unique=True)
    db.weather_cache.create_index([("season", 1), ("round", 1)], unique=True)
    # Populated lazily by /api/driver_bio on demand, not by this batch job.
    db.driver_bios.create_index([("driverId", 1)], unique=True)
    db.historical_race_index.create_index([("season", 1), ("round", 1)], unique=True)
    # Populated lazily by /api/constructor_seasons on demand, not by this batch job.
    db.constructor_seasons_cache.create_index([("constructor_id", 1)], unique=True)


def _years_to_sync() -> list[int]:
    configured = os.getenv("SYNC_YEARS", "").strip()
    if configured:
        return [int(part) for part in configured.split(",") if part.strip()]
    return [_utcnow().year]


def main() -> int:
    years = _years_to_sync()
    print("=== F1 data sync ===")
    print(f"database: {DB_NAME} | years: {years} | force: {FORCE_RESYNC}")

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=20000)
    try:
        client.admin.command("ping")
    except Exception as error:
        print(f"FATAL: cannot reach MongoDB: {error}")
        return 1

    db = client[DB_NAME]
    create_indexes(db)

    # Season-independent — synced once per run, not once per year in the loop
    # below. History past the current season never changes.
    print("\n--- historical index (all seasons) ---")
    sync_historical_index(db)

    for year in years:
        print(f"\n--- {year} ---")
        sync_races(db, year)
        _sync_standings(db, year, "driverstandings", "DriverStandings", db.driver_standings, "driver standings")
        _sync_standings(db, year, "constructorstandings", "ConstructorStandings", db.constructor_standings, "constructor standings")

        # Session-scoped syncs take every round whose weekend has BEGUN, then
        # filter per session — a Friday practice result exists on Friday and
        # should not wait for Sunday. circuit_details and weather summarise the
        # finished race and are cached without re-checking, so they keep the
        # stricter gate: they must not be built from a race in progress.
        in_play = _rounds_in_play(db, year)
        finished = _completed_rounds(db, year, settled=True)
        print(f"  {len(in_play)} round(s) in play, {len(finished)} finished")

        sync_session_results(db, year, in_play)
        sync_practice_results(db, year, in_play)
        sync_circuit_details(db, year, finished)
        sync_race_stints(db, year, finished)
        sync_pit_stops(db, year, finished)
        sync_race_laps(db, year, finished)
        sync_weather(db, year, finished)

    client.close()
    print("\n=== sync complete ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
