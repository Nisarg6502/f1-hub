# Sector Classification Battles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For FP1, FP2, FP3, Qualifying and Sprint Qualifying, show a per-driver sector time board: each driver's fastest lap of the session, with each of its three sector times colored purple (session-best sector), green (that driver's own best in that sector), or yellow (neither).

**Architecture:** A new backend endpoint (`GET /api/session_sectors`) pulls OpenF1's `/laps` for the resolved session, reduces it with a pure function (`classify_lap_sectors`) into one row per driver — their fastest complete lap, sectors pre-classified — and caches the result in Mongo the same Mongo-first way `race_stints`/`race_laps` do. The frontend adds a thin API wrapper and a presentational panel, joined against the session's already-fetched classification results (for driver code/name/team color) rather than asking the backend for driver metadata it doesn't otherwise need.

**Tech Stack:** FastAPI + Motor (Mongo) on the backend, `httpx` for the OpenF1 call (matching `race_stints.py`'s `_fetch_json`); Next.js/React on the frontend, no new frontend dependency.

## Global Constraints

- OpenF1 covers 2023 onward only. A season it has no data for must render an explicit "not available for this season" message, not a blank panel or a spinner that never resolves.
- Backend tests are `unittest.TestCase`, run directly via `asyncio.run(...)` against the route function with `get_db`/`_fetch_json` patched — no FastAPI `TestClient`, matching `backend/tests/test_race_stints.py`. New tests must follow that pattern.
- Frontend: only `frontend/src/lib/**/*.test.ts` is unit-tested (see `frontend/vitest.config.ts`); components are verified in a real browser.
- The color rule is fixed by the design doc: **purple** = session-best time in that sector across every driver; **green** = that driver's own best in that sector this session, when it isn't also purple; **yellow** = anything else. This only ever needs comparing a fastest-lap's sector time against two precomputed numbers — no lap-by-lap trend logic.
- Follow existing house style: no comments explaining *what*, only non-obvious *why*.

---

### Task 1: `classify_lap_sectors` — pure OpenF1-rows-to-board reducer

**Files:**
- Create: `backend/app/session_sectors.py`
- Test: `backend/tests/test_session_sectors.py`

**Interfaces:**
- Produces: `def classify_lap_sectors(rows: list[dict]) -> list[dict]` — input is OpenF1 `/laps` records (`driver_number`, `lap_duration`, `duration_sector_1`, `duration_sector_2`, `duration_sector_3`, `is_pit_out_lap`); output is one dict per driver: `{"driver_number": int, "lap_number": int, "lap_duration_seconds": float, "sectors": {"1": {"seconds": float, "classification": "purple"|"green"|"yellow"}, "2": {...}, "3": {...}}}`, sorted ascending by `lap_duration_seconds`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_session_sectors.py`:

```python
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import types

if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import session_sectors


def lap(driver, lap_number, s1, s2, s3, duration=None, pit_out=False):
    return {
        "driver_number": driver,
        "lap_number": lap_number,
        "duration_sector_1": s1,
        "duration_sector_2": s2,
        "duration_sector_3": s3,
        "lap_duration": duration if duration is not None else (
            None if None in (s1, s2, s3) else s1 + s2 + s3
        ),
        "is_pit_out_lap": pit_out,
    }


class ClassifyLapSectorsTests(unittest.TestCase):
    def test_a_single_driver_single_lap_is_purple_in_every_sector(self):
        rows = [lap(1, 10, 28.0, 30.0, 29.0)]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["driver_number"], 1)
        self.assertEqual(board[0]["sectors"]["1"], {"seconds": 28.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["2"], {"seconds": 30.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["3"], {"seconds": 29.0, "classification": "purple"})

    def test_a_slower_drivers_fastest_lap_can_mix_all_three_colors(self):
        rows = [
            # Driver 1 sets the session-best S1 (tied) and outright S3.
            lap(1, 10, 28.0, 30.5, 29.0, duration=87.5),
            # Driver 44's fastest lap overall (87.7s < the 88.5s lap below).
            # Its S1 (28.5) is slower than 44's own S1 from the *other* lap
            # (28.0) -> yellow. Its S2 (30.0) is the session's best -> purple.
            # Its S3 (29.2) matches 44's own best (set on this same lap, the
            # other lap's S3 is slower) but not driver 1's session-best S3
            # -> green.
            lap(44, 12, 28.5, 30.0, 29.2, duration=87.7),
            # Not driver 44's fastest lap (88.5s), but it sets their personal
            # best S1 (28.0), which is what makes lap 12's S1 yellow above.
            lap(44, 8, 28.0, 31.0, 29.5),
        ]

        board = session_sectors.classify_lap_sectors(rows)
        driver_44 = next(r for r in board if r["driver_number"] == 44)

        self.assertEqual(driver_44["lap_number"], 12)
        self.assertEqual(driver_44["sectors"]["1"]["classification"], "yellow")
        self.assertEqual(driver_44["sectors"]["2"]["classification"], "purple")
        self.assertEqual(driver_44["sectors"]["3"]["classification"], "green")

    def test_pit_out_laps_are_excluded(self):
        rows = [
            lap(1, 1, 40.0, 40.0, 40.0, duration=120.0, pit_out=True),
            lap(1, 2, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_laps_missing_any_sector_time_are_excluded(self):
        rows = [
            lap(1, 1, None, 30.0, 29.0),
            lap(1, 2, 28.0, 30.0, 29.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_picks_the_fastest_complete_lap_per_driver_by_total_duration(self):
        rows = [
            lap(1, 5, 28.0, 30.0, 29.0, duration=87.0),
            lap(1, 6, 27.0, 30.0, 29.0, duration=86.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(board[0]["lap_number"], 6)
        self.assertEqual(board[0]["lap_duration_seconds"], 86.0)

    def test_board_is_sorted_ascending_by_lap_duration(self):
        rows = [
            lap(1, 1, 29.0, 31.0, 30.0, duration=90.0),
            lap(44, 1, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual([r["driver_number"] for r in board], [44, 1])

    def test_no_rows_yields_an_empty_board(self):
        self.assertEqual(session_sectors.classify_lap_sectors([]), [])

    def test_a_driver_with_no_valid_lap_is_omitted(self):
        rows = [lap(1, 1, None, None, None, duration=None)]

        self.assertEqual(session_sectors.classify_lap_sectors(rows), [])
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && python -m pytest tests/test_session_sectors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.session_sectors'` (or `ImportError`, since the module doesn't exist yet).

- [ ] **Step 3: Implement `classify_lap_sectors`**

Create `backend/app/session_sectors.py`:

```python
"""Per-sector purple/green/yellow classification for a practice or qualifying
session, sourced from OpenF1.

Powers the "sector battle" board on FP1-3, Qualifying and Sprint Qualifying:
one row per driver, their fastest complete lap of the session, with each of
its three sector times classified against the session's own best (purple)
and that driver's personal best in that sector (green) -- everything else is
yellow. Race and Sprint already have dedicated Pitwall analysis (lap
telemetry, position/gap, tyre stints), so this endpoint only serves the five
non-race session types.

Unlike `race_stints`/`race_laps`, there is no FastF1 fallback: OpenF1 is
reachable from Cloud Run (unlike FastF1's livetiming source, which 403s
datacenter IPs) and this data only matters for seasons OpenF1 actually
covers (2023 onward) -- older seasons report `available: false` rather than
silently trying and failing an upstream that has nothing for them.
"""

import datetime

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

OPENF1_BASE = "https://api.openf1.org/v1"

SESSION_NAMES = {
    "FP1": "Practice 1",
    "FP2": "Practice 2",
    "FP3": "Practice 3",
    "Q": "Qualifying",
    "SQ": "Sprint Qualifying",
}

SECTOR_COUNT = 3


def _as_number(value) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number


def classify_lap_sectors(rows: list[dict]) -> list[dict]:
    """Reduce OpenF1 `/laps` rows to one classified row per driver.

    A lap only counts if it is not an in/out lap and has a duration for the
    whole lap plus all three sectors -- a partial lap (red flag, off-track
    excursion) would otherwise masquerade as a fast one. Each driver is
    represented by their single fastest valid lap; each of that lap's three
    sector times is then classified against the session-wide best for that
    sector (purple) and the driver's own best across all their valid laps
    this session (green), with anything else falling to yellow.
    """
    valid: list[dict] = []
    for row in rows:
        if row.get("is_pit_out_lap"):
            continue
        driver_number = row.get("driver_number")
        lap_number = row.get("lap_number")
        duration = _as_number(row.get("lap_duration"))
        sectors = [_as_number(row.get(f"duration_sector_{n}")) for n in range(1, SECTOR_COUNT + 1)]
        if driver_number is None or lap_number is None or duration is None:
            continue
        if any(s is None for s in sectors):
            continue
        valid.append({
            "driver_number": driver_number,
            "lap_number": lap_number,
            "lap_duration_seconds": duration,
            "sectors": sectors,
        })

    if not valid:
        return []

    session_best = [
        min(row["sectors"][idx] for row in valid) for idx in range(SECTOR_COUNT)
    ]

    personal_best: dict[int, list[float]] = {}
    for row in valid:
        driver = row["driver_number"]
        current = personal_best.get(driver)
        if current is None:
            personal_best[driver] = list(row["sectors"])
        else:
            personal_best[driver] = [min(current[i], row["sectors"][i]) for i in range(SECTOR_COUNT)]

    fastest_by_driver: dict[int, dict] = {}
    for row in valid:
        driver = row["driver_number"]
        current = fastest_by_driver.get(driver)
        if current is None or row["lap_duration_seconds"] < current["lap_duration_seconds"]:
            fastest_by_driver[driver] = row

    board = []
    for driver, row in fastest_by_driver.items():
        sectors = {}
        for idx in range(SECTOR_COUNT):
            value = row["sectors"][idx]
            if value == session_best[idx]:
                classification = "purple"
            elif value == personal_best[driver][idx]:
                classification = "green"
            else:
                classification = "yellow"
            sectors[str(idx + 1)] = {"seconds": value, "classification": classification}

        board.append({
            "driver_number": driver,
            "lap_number": row["lap_number"],
            "lap_duration_seconds": row["lap_duration_seconds"],
            "sectors": sectors,
        })

    board.sort(key=lambda r: r["lap_duration_seconds"])
    return board
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd backend && python -m pytest tests/test_session_sectors.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/app/session_sectors.py backend/tests/test_session_sectors.py
git commit -m "Add pure sector purple/green/yellow classification from OpenF1 laps"
```

---

### Task 2: Session resolution + endpoint

**Files:**
- Modify: `backend/app/session_sectors.py`
- Modify: `backend/tests/test_session_sectors.py`

**Interfaces:**
- Produces: `def fetch_openf1_session_key_for(race_date: str, session_name: str) -> int | None`, `def build_session_sectors_openf1(race_date: str, session_code: str) -> list[dict] | None`, the `GET /api/session_sectors` route.
- Consumes: `classify_lap_sectors` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_session_sectors.py`:

```python
import asyncio
import json
from unittest.mock import patch


class FetchOpenf1SessionKeyForTests(unittest.TestCase):
    def test_matches_by_session_name_within_the_race_weekend_window(self):
        calls = []

        def fake_fetch(url, params=None, timeout=20.0):
            calls.append((url, params))
            return [
                {"session_key": 1001, "date_start": "2026-07-24T11:30:00+00:00"},  # FP1, Friday
                {"session_key": 1099, "date_start": "2025-05-02T11:30:00+00:00"},  # same name, prior season's round
            ]

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            key = session_sectors.fetch_openf1_session_key_for("2026-07-26", "Practice 1")

        self.assertEqual(calls[0][1], {"year": "2026", "session_name": "Practice 1"})
        self.assertEqual(key, 1001)

    def test_no_matching_session_returns_none(self):
        with patch.object(session_sectors, "_fetch_json", return_value=[]):
            self.assertIsNone(
                session_sectors.fetch_openf1_session_key_for("2026-07-26", "Practice 1")
            )

    def test_no_race_date_returns_none_without_calling_openf1(self):
        with patch.object(session_sectors, "_fetch_json") as fetch:
            self.assertIsNone(session_sectors.fetch_openf1_session_key_for("", "Qualifying"))
        fetch.assert_not_called()


class BuildSessionSectorsOpenf1Tests(unittest.TestCase):
    def test_looks_up_the_session_then_fetches_and_classifies_its_laps(self):
        def fake_fetch(url, params=None, timeout=20.0):
            if url.endswith("/sessions"):
                return [{"session_key": 555, "date_start": "2026-07-25T14:00:00+00:00"}]
            self.assertEqual(params, {"session_key": 555})
            return [lap(1, 10, 28.0, 30.0, 29.0)]

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            board = session_sectors.build_session_sectors_openf1("2026-07-26", "FP1")

        self.assertEqual(len(board), 1)

    def test_an_unknown_session_code_returns_none(self):
        self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "XX"))

    def test_no_session_key_returns_none(self):
        with patch.object(session_sectors, "_fetch_json", return_value=[]):
            self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "Q"))

    def test_empty_laps_returns_none(self):
        def fake_fetch(url, params=None, timeout=20.0):
            if url.endswith("/sessions"):
                return [{"session_key": 555, "date_start": "2026-07-25T14:00:00+00:00"}]
            return []

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "Q"))


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, sectors_doc=None, race_date="2026-07-26"):
        self.session_sectors = sectors_doc or FakeCollection()
        self.races = FakeCollection({"date": race_date} if race_date else None)


class GetSessionSectorsEndpointTests(unittest.TestCase):
    def test_serves_a_cached_document_without_calling_openf1(self):
        cached = FakeCollection({
            "season": 2026, "round": "12", "session": "Q",
            "rows": [{"driver_number": 1, "lap_number": 10, "lap_duration_seconds": 87.0, "sectors": {}}],
        })

        with patch.object(session_sectors, "get_db", return_value=FakeDb(cached)), \
             patch.object(session_sectors, "build_session_sectors_openf1") as build:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="Q")
            )

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["available"])
        self.assertEqual(len(body["rows"]), 1)

    def test_a_cache_miss_rebuilds_from_openf1_and_stores_the_result(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 10, "lap_duration_seconds": 87.0, "sectors": {}}]

        with patch.object(session_sectors, "get_db", return_value=fake_db), \
             patch.object(session_sectors, "build_session_sectors_openf1", return_value=built) as build:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="fp1")
            )

        build.assert_called_once_with("2026-07-26", "FP1")
        self.assertEqual(fake_db.session_sectors.update["update"]["$set"]["rows"], built)
        body = json.loads(response.body)
        self.assertTrue(body["available"])

    def test_a_season_openf1_has_nothing_for_reports_unavailable(self):
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(session_sectors, "get_db", return_value=fake_db), \
             patch.object(session_sectors, "build_session_sectors_openf1", return_value=None):
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2018, round_number=3, session="Q")
            )

        body = json.loads(response.body)
        self.assertFalse(body["available"])
        self.assertEqual(body["rows"], [])

    def test_an_unknown_session_code_is_rejected_before_touching_the_db(self):
        with patch.object(session_sectors, "get_db") as get_db:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="XX")
            )

        get_db.assert_not_called()
        self.assertEqual(response.status_code, 400)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && python -m pytest tests/test_session_sectors.py -v`
Expected: FAIL — `AttributeError: module 'app.session_sectors' has no attribute 'fetch_openf1_session_key_for'` (and similarly for the other new names).

- [ ] **Step 3: Implement session resolution, the OpenF1 build path, and the endpoint**

Append to `backend/app/session_sectors.py`:

```python
def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def fetch_openf1_session_key_for(race_date: str, session_name: str) -> int | None:
    """OpenF1's `session_key` for the named session within the race weekend
    containing `race_date`.

    Unlike a Race or Sprint, a practice/qualifying session's own date can land
    up to three days before the Sunday race date this app indexes rounds by,
    so sessions are matched by name within a trailing window rather than by
    exact date. The closest match to the race date wins, in case OpenF1 ever
    returns a same-named session from an adjacent round.
    """
    if not race_date:
        return None

    sessions = _fetch_json(
        f"{OPENF1_BASE}/sessions", {"year": race_date[:4], "session_name": session_name}
    )
    if not isinstance(sessions, list):
        return None

    race_day = datetime.date.fromisoformat(race_date)
    window_start = race_day - datetime.timedelta(days=4)

    candidates = [
        s
        for s in sessions
        if window_start.isoformat() <= str(s.get("date_start", ""))[:10] <= race_date
    ]
    if not candidates:
        return None

    candidates.sort(key=lambda s: str(s.get("date_start", "")), reverse=True)
    return int(candidates[0]["session_key"]) if candidates[0].get("session_key") is not None else None


def build_session_sectors_openf1(race_date: str, session_code: str) -> list[dict] | None:
    """Sector board for one session via OpenF1, or None if it has nothing.

    Returns None (rather than raising) whenever the session code is unknown,
    the session can't be found, or it has no usable laps -- the caller treats
    all three the same way: report `available: false` rather than erroring.
    """
    session_name = SESSION_NAMES.get(session_code)
    if session_name is None:
        return None

    session_key = fetch_openf1_session_key_for(race_date, session_name)
    if session_key is None:
        return None

    rows = _fetch_json(f"{OPENF1_BASE}/laps", {"session_key": session_key})
    if not isinstance(rows, list) or not rows:
        return None

    return classify_lap_sectors(rows) or None


async def _race_date(db, year: int, round_number: int) -> str | None:
    try:
        race = await db.races.find_one(
            {"season": year, "round": str(round_number)}, {"_id": 0, "date": 1}
        )
    except Exception as error:
        print(f"Failed to read race date for {year} R{round_number}: {error}")
        return None
    return (race or {}).get("date")


@router.get("/session_sectors")
async def get_session_sectors(
    year: int = Query(..., description="Season year"),
    round_number: int = Query(..., alias="round", description="Round number"),
    session: str = Query(..., description="FP1, FP2, FP3, Q or SQ"),
):
    """Sector purple/green/yellow board for a practice or qualifying session.

    Mongo-first, same self-heal shape as `race_stints`/`race_laps`, but with a
    single source (OpenF1) rather than an OpenF1-then-FastF1 chain -- see the
    module docstring for why FastF1 is not worth adding here.
    """
    session_code = session.upper()
    if session_code not in SESSION_NAMES:
        return JSONResponse(content={"available": False, "rows": []}, status_code=400)

    db = get_db()

    doc = await db.session_sectors.find_one(
        {"season": year, "round": str(round_number), "session": session_code},
        {"_id": 0, "synced_at": 0},
    )
    if doc and doc.get("rows"):
        return JSONResponse(content={"available": True, "rows": doc["rows"]})

    race_date = await _race_date(db, year, round_number)
    rows = build_session_sectors_openf1(race_date, session_code) if race_date else None

    if not rows:
        return JSONResponse(content={"available": False, "rows": []})

    try:
        await db.session_sectors.update_one(
            {"season": year, "round": str(round_number), "session": session_code},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "session": session_code,
                "rows": rows,
            }},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache session_sectors for {year} R{round_number} {session_code}: {error}")

    return JSONResponse(content={"available": True, "rows": rows})
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd backend && python -m pytest tests/test_session_sectors.py -v`
Expected: PASS, all tests (8 from Task 1 + 11 new = 19).

- [ ] **Step 5: Register the router**

In `backend/app/main.py`, add the import alongside the other local-module imports:

```python
from . import session_sectors
```

And the registration alongside the other `include_router` calls:

```python
app.include_router(session_sectors.router)
```

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && python -m pytest -q`
Expected: all tests pass, no collisions with the existing suite.

- [ ] **Step 7: Commit**

```bash
git add backend/app/session_sectors.py backend/tests/test_session_sectors.py backend/app/main.py
git commit -m "Add GET /api/session_sectors, OpenF1-backed with Mongo caching"
```

---

### Task 3: Frontend API wrapper + driver-join helper

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/sector-battle.ts`
- Test: `frontend/src/lib/sector-battle.test.ts`

**Interfaces:**
- Produces (api.ts): `export interface SectorTime { seconds: number; classification: "purple" | "green" | "yellow"; }`, `export interface SessionSectorRow { driverNumber: number; lapNumber: number; lapDurationSeconds: number; sectors: Record<"1" | "2" | "3", SectorTime>; }`, `export async function getSessionSectors(year: number, round: number, session: string): Promise<{ available: boolean; rows: SessionSectorRow[] }>`
- Produces (sector-battle.ts): `export interface SectorBattleDriver extends SessionSectorRow { code: string; name: string; teamColorHex: string; }`, `export function joinSectorRowsWithResults(rows: SessionSectorRow[], results: RaceResult[]): SectorBattleDriver[]`
- Consumes: `RaceResult` (already exported from `api.ts`), `getTeamColor` from `src/lib/team-colors.ts`.

- [ ] **Step 1: Add the API types and fetcher**

In `frontend/src/lib/api.ts`, add near the other session-result functions (after `getSessionClassification`). The backend's `driver_number`/`lap_number`/`lap_duration_seconds` are snake_case; this reshapes them to camelCase so the rest of the frontend only ever sees the same casing every other function in this file already returns:

```ts
export interface SectorTime {
  seconds: number;
  classification: "purple" | "green" | "yellow";
}

export interface SessionSectorRow {
  driverNumber: number;
  lapNumber: number;
  lapDurationSeconds: number;
  sectors: Record<"1" | "2" | "3", SectorTime>;
}

export async function getSessionSectors(
  year: number,
  round: number,
  session: string
): Promise<{ available: boolean; rows: SessionSectorRow[] }> {
  const data = await fetchJson<{
    available: boolean;
    rows: Array<{
      driver_number: number;
      lap_number: number;
      lap_duration_seconds: number;
      sectors: Record<"1" | "2" | "3", SectorTime>;
    }>;
  }>("/api/session_sectors", { year, round, session });

  return {
    available: data.available,
    rows: data.rows.map((r) => ({
      driverNumber: r.driver_number,
      lapNumber: r.lap_number,
      lapDurationSeconds: r.lap_duration_seconds,
      sectors: r.sectors,
    })),
  };
}
```

(This replaces the first draft above — only the second version, with the reshape, should end up in the file.)

- [ ] **Step 2: Write the failing tests for the driver join**

Create `frontend/src/lib/sector-battle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { joinSectorRowsWithResults } from "./sector-battle";
import type { RaceResult, SessionSectorRow } from "./api";

function sectorRow(driverNumber: number): SessionSectorRow {
  return {
    driverNumber,
    lapNumber: 10,
    lapDurationSeconds: 87.0,
    sectors: {
      "1": { seconds: 28.0, classification: "purple" },
      "2": { seconds: 30.0, classification: "green" },
      "3": { seconds: 29.0, classification: "yellow" },
    },
  };
}

function result(number: string, code: string, teamName: string): RaceResult {
  return {
    number,
    Driver: { code, givenName: "Max", familyName: "Verstappen" },
    Constructor: { name: teamName },
  };
}

describe("joinSectorRowsWithResults", () => {
  it("attaches code, name and team color from the matching classification result", () => {
    const joined = joinSectorRowsWithResults(
      [sectorRow(1)],
      [result("1", "VER", "Red Bull")]
    );

    expect(joined).toHaveLength(1);
    expect(joined[0].code).toBe("VER");
    expect(joined[0].name).toBe("Max Verstappen");
    expect(joined[0].teamColorHex).toBe("#3671C6");
    expect(joined[0].driverNumber).toBe(1);
  });

  it("drops a sector row with no matching result rather than rendering blank identity", () => {
    const joined = joinSectorRowsWithResults([sectorRow(99)], [result("1", "VER", "Red Bull")]);

    expect(joined).toEqual([]);
  });

  it("falls back to the family name when no code is present", () => {
    const noCode: RaceResult = {
      number: "1",
      Driver: { familyName: "Verstappen" },
      Constructor: { name: "Red Bull" },
    };

    const joined = joinSectorRowsWithResults([sectorRow(1)], [noCode]);

    expect(joined[0].code).toBe("Verstappen");
  });

  it("preserves the input rows' order", () => {
    const joined = joinSectorRowsWithResults(
      [sectorRow(44), sectorRow(1)],
      [result("1", "VER", "Red Bull"), result("44", "HAM", "Mercedes")]
    );

    expect(joined.map((d) => d.driverNumber)).toEqual([44, 1]);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd frontend && npx vitest run src/lib/sector-battle.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `joinSectorRowsWithResults`**

Create `frontend/src/lib/sector-battle.ts`:

```ts
import type { RaceResult, SessionSectorRow } from "./api";
import { getTeamColor } from "./team-colors";

export interface SectorBattleDriver extends SessionSectorRow {
  code: string;
  name: string;
  teamColorHex: string;
}

/**
 * Attaches driver identity (code, name, team color) to each sector row by
 * car number -- the backend endpoint only knows OpenF1's `driver_number` and
 * has no reason to also carry Ergast driver metadata, since the session's
 * classification results (already fetched for the results table above this
 * panel) already have it.
 */
export function joinSectorRowsWithResults(
  rows: SessionSectorRow[],
  results: RaceResult[]
): SectorBattleDriver[] {
  const resultByNumber = new Map<string, RaceResult>();
  for (const result of results) {
    if (result.number) resultByNumber.set(result.number, result);
  }

  const joined: SectorBattleDriver[] = [];
  for (const row of rows) {
    const result = resultByNumber.get(String(row.driverNumber));
    if (!result?.Driver) continue;

    const code = result.Driver.code || result.Driver.familyName || String(row.driverNumber);
    const name = `${result.Driver.givenName ?? ""} ${result.Driver.familyName ?? ""}`.trim();

    joined.push({
      ...row,
      code,
      name: name || code,
      teamColorHex: getTeamColor(result.Constructor?.name).hex,
    });
  }

  return joined;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd frontend && npx vitest run src/lib/sector-battle.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full frontend test suite and type-check**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all pass, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/sector-battle.ts frontend/src/lib/sector-battle.test.ts
git commit -m "Add session_sectors client and driver-identity join"
```

---

### Task 4: `SectorBattlePanel` component + wiring into `SessionTabs`

**Files:**
- Create: `frontend/src/components/sector-battle-panel.tsx`
- Modify: `frontend/src/components/session-tabs.tsx`

**Interfaces:**
- Consumes: `getSessionSectors` + `SessionSectorRow` (Task 3, `api.ts`), `joinSectorRowsWithResults` + `SectorBattleDriver` (Task 3, `sector-battle.ts`).

- [ ] **Step 1: Write the component**

Create `frontend/src/components/sector-battle-panel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { getSessionSectors, type RaceResult } from "@/lib/api";
import { joinSectorRowsWithResults, type SectorBattleDriver } from "@/lib/sector-battle";

interface SectorBattlePanelProps {
  year: number;
  round: number;
  session: "FP1" | "FP2" | "FP3" | "Q" | "SQ";
  results: RaceResult[];
}

const CLASSIFICATION_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  purple: { bg: "rgba(174,59,255,0.18)", color: "#c99bff", label: "Purple" },
  green: { bg: "rgba(57,213,75,0.14)", color: "#6ee085", label: "Green" },
  yellow: { bg: "transparent", color: "var(--color-warm-300)", label: "" },
};

export default function SectorBattlePanel({ year, round, session, results }: SectorBattlePanelProps) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "unavailable" } | { status: "ready"; drivers: SectorBattleDriver[] }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    getSessionSectors(year, round, session)
      .then((data) => {
        if (cancelled) return;
        if (!data.available || data.rows.length === 0) {
          setState({ status: "unavailable" });
          return;
        }
        setState({ status: "ready", drivers: joinSectorRowsWithResults(data.rows, results) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });

    return () => {
      cancelled = true;
    };
  }, [year, round, session, results]);

  if (state.status === "loading") {
    return (
      <div className="apex-glass-soft rounded-2xl p-6 mt-6 text-sm text-warm-400 font-medium">
        Loading sector times…
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div className="apex-glass-soft rounded-2xl p-6 mt-6 text-sm text-warm-400 font-medium">
        Sector data isn&apos;t available for this session.
      </div>
    );
  }

  return (
    <div className="apex-glass-soft rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-400">
          Sector battle
        </h4>
        <div className="flex items-center gap-3 text-[10px] uppercase font-bold text-warm-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#ae3bff" }} />
            Purple
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#39d54b" }} />
            Personal best
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-warm-500">
              <th className="pb-2 pr-3">Driver</th>
              <th className="pb-2 px-3">S1</th>
              <th className="pb-2 px-3">S2</th>
              <th className="pb-2 px-3">S3</th>
              <th className="pb-2 pl-3 text-right">Lap</th>
            </tr>
          </thead>
          <tbody>
            {state.drivers.map((driver) => (
              <tr key={driver.driverNumber} className="border-t border-white/[0.06]">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-1 h-4 rounded-hairline flex-none"
                      style={{ background: driver.teamColorHex }}
                    />
                    <span className="font-bold">{driver.code}</span>
                  </div>
                </td>
                {(["1", "2", "3"] as const).map((sector) => {
                  const style = CLASSIFICATION_STYLE[driver.sectors[sector].classification];
                  return (
                    <td key={sector} className="py-2 px-3">
                      <span
                        className="px-2 py-1 rounded-md tabular-nums font-semibold"
                        style={{ background: style.bg, color: style.color }}
                      >
                        {driver.sectors[sector].seconds.toFixed(3)}
                      </span>
                    </td>
                  );
                })}
                <td className="py-2 pl-3 text-right tabular-nums font-bold">
                  {driver.lapDurationSeconds.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `SessionTabs`**

In `frontend/src/components/session-tabs.tsx`:

Add the import:

```ts
import SectorBattlePanel from "@/components/sector-battle-panel";
```

`SessionInfo` currently has no `year` prop — add one. Change its signature:

```tsx
function SessionInfo({
  race,
  sessionKey,
  nowMs,
  sessionResults,
  seasonYear,
}: {
  race: Race;
  sessionKey: SessionKey;
  nowMs: number;
  sessionResults: RaceResult[];
  seasonYear: number;
}) {
```

And pass it from the call site inside the main `SessionTabs` component (`seasonYear` is already computed there via `useParams`):

```tsx
          <SessionInfo
            race={race}
            sessionKey={activeSession}
            nowMs={nowMs}
            seasonYear={seasonYear}
            sessionResults={
              activeSession === "Qualifying"
                ? qualifyingResults
                : activeSession === "SprintQualifying"
                ? sprintQualiResults
                : activeSession === "Sprint"
                ? sprintResults
                : activeSession === "FirstPractice"
                ? fp1Results
                : activeSession === "SecondPractice"
                ? fp2Results
                : activeSession === "ThirdPractice"
                ? fp3Results
                : []
            }
          />
```

Inside `SessionInfo`, after the existing classification block (right after the `</div>` that closes the `sessionPast && sessionResults.length > 0 ? (...)` ternary, still inside the component's returned `<div>`), add the sector battle for the five sessions it applies to:

```tsx
      {sessionPast && sessionResults.length > 0 && Number.isFinite(seasonYear) && (
        SECTOR_SESSION_CODES[sessionKey] ? (
          <SectorBattlePanel
            year={seasonYear}
            round={Number(race.round)}
            session={SECTOR_SESSION_CODES[sessionKey]!}
            results={sessionResults}
          />
        ) : null
      )}
```

Add the lookup table near the other session-keyed constants (next to `SESSION_LABELS`):

```ts
const SECTOR_SESSION_CODES: Partial<Record<SessionKey, "FP1" | "FP2" | "FP3" | "Q" | "SQ">> = {
  FirstPractice: "FP1",
  SecondPractice: "FP2",
  ThirdPractice: "FP3",
  Qualifying: "Q",
  SprintQualifying: "SQ",
};
```

(Deliberately excludes `Race` and `Sprint` — those already have dedicated Pitwall analysis surfaces, per the design doc's exclusions.)

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Visual verification in the browser**

Start the dev server, navigate to a completed round's page (`/schedule/<season>/<round>`) for a 2023+ season, and for each of FP1, FP2, FP3, Qualifying, and Sprint Qualifying (where the weekend has one):
- Confirm the sector battle table appears below the classification table.
- Confirm at least one purple cell and, where the field is close, green and yellow cells.
- Confirm the Race and Sprint tabs do NOT show the panel.
- Load a pre-2023 season's completed round and confirm the "not available for this season" message renders instead of a blank panel or infinite spinner.
- Screenshot one FP/Quali tab with the panel visible.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/sector-battle-panel.tsx frontend/src/components/session-tabs.tsx
git commit -m "Show sector battle board on FP1-3, Qualifying and Sprint Qualifying tabs"
```
