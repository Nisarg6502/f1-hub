"""
Data Sync Script — Fetches data from the Ergast API and writes to MongoDB.

Run this as a standalone script (Cloud Run Job) or locally:
    MONGODB_URI="mongodb+srv://..." python -m app.data_sync

Syncs: races, driver_standings, constructor_standings, drivers, constructors, race_results
"""

import json
import os
import sys
import time
import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

import fastf1
from pymongo import MongoClient

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGODB_DB_NAME", "f1_scratch")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "f1-scratch-sync/1.0"

# Setup FastF1 Cache
CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "f1_cache")
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)


def fetch_json(url: str, max_retries: int = 3) -> dict | None:
    """Fetch JSON from a URL with retry logic."""
    for attempt in range(1, max_retries + 1):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT})
            response = urlopen(req, timeout=15)
            body = response.read().decode("utf-8")
            return json.loads(body)
        except HTTPError as e:
            if e.code == 429:
                wait_time = 5 * attempt
                print(f"  [attempt {attempt}/{max_retries}] Rate limited (429). Waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"  [attempt {attempt}/{max_retries}] HTTP Error fetching {url}: {e}")
                if attempt < max_retries:
                    time.sleep(2 * attempt)
        except (URLError, Exception) as e:
            print(f"  [attempt {attempt}/{max_retries}] Error fetching {url}: {e}")
            if attempt < max_retries:
                time.sleep(2 * attempt)
    return None


def _split_driver_name(full_name: str) -> tuple[str, str]:
    """Helper to split full name into given and family names."""
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def sync_races(db, year: int):
    """Sync race schedule for a given year."""
    print(f"Syncing races for {year}...")
    data = fetch_json(f"{ERGAST_BASE}/{year}/races/")
    if not data:
        print(f"  Failed to fetch races for {year}")
        return

    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
    now = datetime.datetime.utcnow().isoformat()

    for race in races:
        race_doc = {**race, "season": year, "synced_at": now}
        db.races.update_one(
            {"season": year, "round": race.get("round")},
            {"$set": race_doc},
            upsert=True,
        )

    print(f"  Synced {len(races)} races for {year}")


def sync_driver_standings(db, year: int):
    """Sync driver standings for a given year."""
    print(f"Syncing driver standings for {year}...")
    data = fetch_json(f"{ERGAST_BASE}/{year}/driverstandings/")
    if not data:
        print(f"  Failed to fetch driver standings for {year}")
        return

    standings_lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
    driver_standings = standings_lists[0].get("DriverStandings", []) if standings_lists else []

    db.driver_standings.update_one(
        {"season": year},
        {"$set": {
            "season": year,
            "standings": driver_standings,
            "synced_at": datetime.datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    print(f"  Synced {len(driver_standings)} driver standings for {year}")


def sync_constructor_standings(db, year: int):
    """Sync constructor standings for a given year."""
    print(f"Syncing constructor standings for {year}...")
    data = fetch_json(f"{ERGAST_BASE}/{year}/constructorstandings/")
    if not data:
        print(f"  Failed to fetch constructor standings for {year}")
        return

    standings_lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
    constructor_standings = standings_lists[0].get("ConstructorStandings", []) if standings_lists else []

    db.constructor_standings.update_one(
        {"season": year},
        {"$set": {
            "season": year,
            "standings": constructor_standings,
            "synced_at": datetime.datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    print(f"  Synced {len(constructor_standings)} constructor standings for {year}")


def sync_drivers(db, year: int):
    """Sync driver list for a given year."""
    print(f"Syncing drivers for {year}...")
    data = fetch_json(f"{ERGAST_BASE}/{year}/drivers/")
    if not data:
        print(f"  Failed to fetch drivers for {year}")
        return

    drivers = data.get("MRData", {}).get("DriverTable", {}).get("Drivers", [])

    db.drivers.update_one(
        {"season": year},
        {"$set": {
            "season": year,
            "drivers": drivers,
            "synced_at": datetime.datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    print(f"  Synced {len(drivers)} drivers for {year}")


def sync_constructors(db, year: int):
    """Sync constructor list for a given year."""
    print(f"Syncing constructors for {year}...")
    data = fetch_json(f"{ERGAST_BASE}/{year}/constructors/")
    if not data:
        print(f"  Failed to fetch constructors for {year}")
        return

    constructors = data.get("MRData", {}).get("ConstructorTable", {}).get("Constructors", [])

    db.constructors.update_one(
        {"season": year},
        {"$set": {
            "season": year,
            "constructors": constructors,
            "synced_at": datetime.datetime.utcnow().isoformat(),
        }},
        upsert=True,
    )
    print(f"  Synced {len(constructors)} constructors for {year}")


def sync_race_results(db, year: int):
    """Sync race results for all completed rounds in a given year."""
    print(f"Syncing race results for {year}...")

    # First get the list of races to know how many rounds exist
    races = list(db.races.find({"season": year}, {"round": 1, "_id": 0}))
    if not races:
        print(f"  No races found for {year} in DB. Sync races first.")
        return

    synced_count = 0
    for race in races:
        round_num = race.get("round")
        if not round_num:
            continue

        data = fetch_json(f"{ERGAST_BASE}/{year}/{round_num}/results/")
        if not data:
            continue

        races_data = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
        if not races_data:
            # No results yet (future race)
            continue

        race_data = races_data[0]
        results = race_data.get("Results", [])
        if not results:
            # Race hasn't happened yet
            continue

        db.race_results.update_one(
            {"season": year, "round": str(round_num)},
            {"$set": {
                "season": year,
                "round": str(round_num),
                "race": {k: v for k, v in race_data.items() if k != "Results"},
                "results": results,
                "synced_at": datetime.datetime.utcnow().isoformat(),
            }},
            upsert=True,
        )
        synced_count += 1

        # Be nice to the API
        time.sleep(1.0)

    print(f"  Synced results for {synced_count} races in {year}")


def sync_qualifying_results(db, year: int):
    """Sync qualifying results for all completed rounds."""
    print(f"Syncing qualifying results for {year}...")
    races = list(db.races.find({"season": year}, {"round": 1, "_id": 0}))
    synced_count = 0
    for race in races:
        round_num = race.get("round")
        data = fetch_json(f"{ERGAST_BASE}/{year}/{round_num}/qualifying/")
        if not data: continue
        races_data = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
        if not races_data: continue
        race_data = races_data[0]
        results = race_data.get("QualifyingResults", [])
        if not results: continue

        db.qualifying_results.update_one(
            {"season": year, "round": str(round_num)},
            {"$set": {
                "season": year,
                "round": str(round_num),
                "race": {k: v for k, v in race_data.items() if k != "QualifyingResults"},
                "results": results,
                "synced_at": datetime.datetime.utcnow().isoformat(),
            }},
            upsert=True,
        )
        synced_count += 1
        time.sleep(0.5)
    print(f"  Synced qualifying for {synced_count} rounds in {year}")


def sync_sprint_results(db, year: int):
    """Sync sprint race results for all completed rounds."""
    print(f"Syncing sprint results for {year}...")
    races = list(db.races.find({"season": year}, {"round": 1, "_id": 0}))
    synced_count = 0
    for race in races:
        round_num = race.get("round")
        data = fetch_json(f"{ERGAST_BASE}/{year}/{round_num}/sprint/")
        if not data: continue
        races_data = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
        if not races_data: continue
        race_data = races_data[0]
        results = race_data.get("SprintResults", [])
        if not results: continue

        db.sprint_results.update_one(
            {"season": year, "round": str(round_num)},
            {"$set": {
                "season": year,
                "round": str(round_num),
                "race": {k: v for k, v in race_data.items() if k != "SprintResults"},
                "results": results,
                "synced_at": datetime.datetime.utcnow().isoformat(),
            }},
            upsert=True,
        )
        synced_count += 1
        time.sleep(0.5)
    print(f"  Synced sprint for {synced_count} rounds in {year}")


def sync_practice_results(db, year: int):
    """Sync practice and sprint qualifying results using FastF1."""
    print(f"Syncing practice/sprint-qualifying for {year}...")
    races = list(db.races.find({"season": year}, {"round": 1, "_id": 0}))
    sessions_to_sync = ["FP1", "FP2", "FP3", "SQ"]
    synced_count = 0

    for race in races:
        round_num = int(race.get("round"))
        for session_code in sessions_to_sync:
            try:
                # FastF1 uses 1-based indexing for rounds
                ff1_session = fastf1.get_session(year, round_num, session_code)
                # Load only results
                ff1_session.load(laps=False, telemetry=False, weather=False, messages=False, livedata=False)
                results_df = ff1_session.results
                
                if results_df.empty:
                    continue

                normalized_results = []
                for _, row in results_df.iterrows():
                    full_name = str(row.get("FullName") or "").strip()
                    given_name, family_name = _split_driver_name(full_name)
                    normalized_results.append({
                        "position": str(row.get("Position") or ""),
                        "points": str(row.get("Points") or ""),
                        "status": str(row.get("Status") or ""),
                        "Driver": {
                            "givenName": given_name,
                            "familyName": family_name,
                            "code": str(row.get("Abbreviation") or ""),
                            "permanentNumber": str(row.get("DriverNumber") or ""),
                        },
                        "Constructor": {
                            "name": str(row.get("TeamName") or ""),
                        },
                        "Time": {
                            "time": str(row.get("Time") or ""),
                        },
                        "Q1": str(row.get("Q1") or "") if row.get("Q1") is not None else "",
                        "Q2": str(row.get("Q2") or "") if row.get("Q2") is not None else "",
                        "Q3": str(row.get("Q3") or "") if row.get("Q3") is not None else "",
                    })

                db.practice_results.update_one(
                    {"season": year, "round": str(round_num), "session": session_code},
                    {"$set": {
                        "season": year,
                        "round": str(round_num),
                        "session": session_code,
                        "event_name": getattr(ff1_session.event, "EventName", ""),
                        "results": normalized_results,
                        "synced_at": datetime.datetime.utcnow().isoformat(),
                    }},
                    upsert=True,
                )
                synced_count += 1
            except Exception:
                # Session might not exist for this round
                continue

    print(f"  Synced {synced_count} practice/SQ sessions for {year}")


def create_indexes(db):
    """Create indexes for efficient querying."""
    print("Creating indexes...")
    db.races.create_index([("season", 1), ("round", 1)], unique=True)
    db.driver_standings.create_index([("season", 1)], unique=True)
    db.constructor_standings.create_index([("season", 1)], unique=True)
    db.drivers.create_index([("season", 1)], unique=True)
    db.constructors.create_index([("season", 1)], unique=True)
    db.race_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.qualifying_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.sprint_results.create_index([("season", 1), ("round", 1)], unique=True)
    db.practice_results.create_index([("season", 1), ("round", 1), ("session", 1)], unique=True)
    print("  Indexes created.")


def main():
    """Run the full data sync."""
    current_year = datetime.datetime.utcnow().year

    # Sync current season only (add more years if needed)
    years_to_sync = [current_year]

    print(f"=== F1 Data Sync Starting ===")
    print(f"MongoDB: {MONGODB_URI[:30]}...")
    print(f"Database: {DB_NAME}")
    print(f"Years: {years_to_sync}")
    print()

    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]

    create_indexes(db)

    for year in years_to_sync:
        print(f"\n--- Syncing {year} ---")
        sync_races(db, year)
        sync_driver_standings(db, year)
        sync_constructor_standings(db, year)
        sync_drivers(db, year)
        sync_constructors(db, year)
        sync_race_results(db, year)
        sync_qualifying_results(db, year)
        sync_sprint_results(db, year)
        sync_practice_results(db, year)

    client.close()
    print(f"\n=== Sync Complete ===")


if __name__ == "__main__":
    main()
