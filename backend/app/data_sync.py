"""Data sync job — pulls the season from Ergast/FastF1/OpenF1 into MongoDB.

Runs as a Cloud Run Job on an hourly schedule, or locally:

    MONGODB_URI="mongodb+srv://..." python -m app.data_sync

The schedule and standings are refreshed on every run because they change
between races. Everything keyed to a specific session — results, practice
classifications, circuit details, weather — is only fetched for rounds that
have already happened and aren't in Mongo yet. That keeps a routine run to a
handful of requests and well inside the job timeout; the expensive FastF1 work
only happens on the run after a race weekend.

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


def _sync_entry_list(db, year: int, path: str, table: str, key: str, collection) -> None:
    print(f"  {key.lower()}...")
    entries = _ergast_table(fetch_json(f"{ERGAST_BASE}/{year}/{path}/"), table, key)
    if not entries:
        print(f"    no {key.lower()} returned")
        return

    collection.update_one(
        {"season": year},
        {"$set": {"season": year, key.lower(): entries, "synced_at": _utcnow_iso()}},
        upsert=True,
    )
    print(f"    synced {len(entries)} {key.lower()}")


# --- Per-round data (only for completed rounds we haven't stored yet) ---


def _completed_rounds(db, year: int) -> list[dict]:
    """Races whose start time has passed, oldest first."""
    now = _utcnow()
    races = list(db.races.find({"season": year}, {"_id": 0, "synced_at": 0}))
    completed = []
    for race in races:
        start = _session_start(race.get("date"), race.get("time"))
        if start and start < now:
            completed.append(race)
    return sorted(completed, key=lambda r: int(r.get("round", 0)))


def _already_stored(collection, query: dict, *, classified: bool = False) -> bool:
    """True if this session is already stored and worth keeping.

    `classified=True` additionally rejects rows without positions, so practice
    entries written before the classification was derived from laps get
    refetched rather than skipped forever.
    """
    if FORCE_RESYNC:
        return False
    doc = collection.find_one(query, {"_id": 1, "results": 1})
    if not doc or not doc.get("results"):
        return False
    return has_classification(doc["results"]) if classified else True


def sync_session_results(db, year: int, races: list[dict]) -> None:
    """Race, qualifying and sprint results from Ergast."""
    jobs = [
        ("results", "Results", db.race_results, "race"),
        ("qualifying", "QualifyingResults", db.qualifying_results, "qualifying"),
        ("sprint", "SprintResults", db.sprint_results, "sprint"),
    ]

    for path, key, collection, label in jobs:
        synced = 0
        for race in races:
            round_number = race.get("round")
            # A sprint only exists on sprint weekends; don't ask for the rest.
            if label == "sprint" and not race.get("Sprint"):
                continue
            if _already_stored(collection, {"season": year, "round": str(round_number)}):
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
    isn't asked for the FP2/FP3 it never had.
    """
    synced = 0
    for race in races:
        round_number = int(race.get("round", 0))
        for schedule_field, session_code in PRACTICE_SESSIONS.items():
            if not race.get(schedule_field):
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


def sync_weather(db, year: int, races: list[dict]) -> None:
    from .session_results import fetch_openf1_weather

    synced = 0
    for race in races:
        round_number = race.get("round")
        race_date = race.get("date")
        if not race_date:
            continue
        if not FORCE_RESYNC and db.weather_cache.find_one(
            {"season": year, "round": str(round_number)}
        ):
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


def create_indexes(db) -> None:
    db.races.create_index([("season", 1), ("round", 1)], unique=True)
    db.driver_standings.create_index([("season", 1)], unique=True)
    db.constructor_standings.create_index([("season", 1)], unique=True)
    db.drivers.create_index([("season", 1)], unique=True)
    db.constructors.create_index([("season", 1)], unique=True)
    db.race_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.qualifying_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.sprint_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.practice_results.create_index(
        [("season", 1), ("round", 1), ("session", 1)], unique=True
    )
    db.circuit_details.create_index([("season", 1), ("round", 1)], unique=True)
    db.weather_cache.create_index([("season", 1), ("round", 1)], unique=True)


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

    for year in years:
        print(f"\n--- {year} ---")
        sync_races(db, year)
        _sync_standings(db, year, "driverstandings", "DriverStandings", db.driver_standings, "driver standings")
        _sync_standings(db, year, "constructorstandings", "ConstructorStandings", db.constructor_standings, "constructor standings")
        _sync_entry_list(db, year, "drivers", "DriverTable", "Drivers", db.drivers)
        _sync_entry_list(db, year, "constructors", "ConstructorTable", "Constructors", db.constructors)

        races = _completed_rounds(db, year)
        print(f"  {len(races)} completed round(s) to consider")

        sync_session_results(db, year, races)
        sync_practice_results(db, year, races)
        sync_circuit_details(db, year, races)
        sync_weather(db, year, races)

    client.close()
    print("\n=== sync complete ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
