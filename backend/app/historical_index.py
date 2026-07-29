"""Cross-era race and constructor history for the `/history` page (Batch 14).

Two endpoints, both Mongo-first with a live-Jolpica self-heal, same shape as
`circuit_history.py`:

- `/api/historical_race_index` — every championship race 1950-present, one
  normalised record per race, for the "75-Season Barcode" (season-barcode.tsx).
- `/api/constructor_seasons` — the active-year span of every constructor
  Ergast has ever recorded, for the "Constructor Genealogy" tree
  (constructor-genealogy.tsx) to size its bands against real data even for
  constructors that never won a race.

Raw Ergast/Jolpica data is NOT clean enough to render directly. Probing it
live for this batch turned up five defects, all corrected here so neither
frontend feature (nor anything built later) has to re-solve them:

1. A handful of 1950s races have two `Results[0]` P1 rows because a driver
   swapped into a teammate's car mid-race and both were classified 1st
   (e.g. 1951 French GP: Fangio *and* Fagioli, both Alfa Romeo). Ergast's
   own `total` count (1163) is result rows, not races (1160) — naively
   trusting one race per result row plants three phantom stripes in the
   barcode. Fixed by de-duplicating on (season, round), keeping the first
   P1 row encountered.
2. Ergast's `alfa` constructorId is reused across three unrelated teams 70+
   years apart: the 1950-51 works team, a separate 1979-85 works team, and
   Alfa Romeo Racing (the rebadged Sauber) 2019-23. Only the 1950-51 era
   ever won a championship race, so this only actually matters for
   `/constructor_seasons` (which the genealogy tree uses), not for winner
   colouring — but it's split by era here for correctness anyway.
3. Ergast splits chassis/engine combinations into separate constructorIds
   in the early decades: Lotus alone appears as `team_lotus`,
   `lotus-climax`, `lotus-ford`, `lotus_f1`, and `lotus-brm`; Brabham as
   `brabham`, `brabham-climax`, `brabham-ford`, `brabham-repco`; Cooper as
   `cooper`, `cooper-climax`, `cooper-maserati`; McLaren briefly as
   `mclaren-ford`. Left alone, one team fragments into several unrelated
   colours in the barcode and the genealogy band snaps into pieces.
   Collapsed to one canonical key per team via `CONSTRUCTOR_ALIASES`.
4. The 1950-1960 Indianapolis 500 counted toward the World Championship,
   so `kurtis_kraft`, `epperly`, `kuzma`, and `watson` appear as race
   winners despite never entering a Grand Prix. Kept (it's a real and
   surprising part of the story) but flagged `indy500: true` so the
   frontend can render them distinctly rather than as unexplained one-off
   colours. Distinguished from the 2000-2007 United States Grand Prix,
   which also happened to run at the Indianapolis circuit but is an
   ordinary points race.
5. The active season is partial — the endpoint reports exactly how many
   rounds have been run vs. scheduled so the frontend can render the
   unraced tail deliberately (ghost slots) instead of just stopping.
"""

import asyncio
import datetime
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "f1-scratch-api/1.0"

# --- Constructor identity normalisation ------------------------------------

# raw Ergast constructorId -> canonical key. Only entries that actually need
# collapsing are listed; everything else maps to itself (see canonical_key()).
#
# NOTE on a trap found during live verification: `lotus_f1` (2012-15,
# Raikkonen's two wins) looks like a Lotus chassis-era variant by name, but
# it is genealogically the *Renault*-descended team (Renault ran 2002-11,
# rebranded "Lotus F1 Team" 2012-15, then reverted to Renault in 2016) —
# completely unrelated to the classic 1958-94 Team Lotus below. It is
# deliberately left OUT of the `lotus` merge and kept as its own identity;
# CP49's curated genealogy lineage, not this normalisation layer, is where
# that Renault<->Lotus-name relationship belongs.
CONSTRUCTOR_ALIASES: dict[str, str] = {
    # Classic Lotus (Colin Chapman's team, 1958-1994): chassis/engine-era ids
    # all fold into one lineage. Does NOT include `lotus_f1` — see note above.
    "team_lotus": "lotus",
    "lotus-climax": "lotus",
    "lotus-ford": "lotus",
    "lotus-brm": "lotus",
    # Brabham: same story across the 60s/70s.
    "brabham-climax": "brabham",
    "brabham-ford": "brabham",
    "brabham-repco": "brabham",
    "brabham-alfa_romeo": "brabham",
    # Cooper.
    "cooper-climax": "cooper",
    "cooper-maserati": "cooper",
    # McLaren's brief Ford-engine-era id.
    "mclaren-ford": "mclaren",
}

# Display names for the canonical keys above (and any raw id whose Ergast
# `name` field isn't already what we want to show).
CANONICAL_DISPLAY_NAMES: dict[str, str] = {
    "lotus": "Lotus",
    "brabham": "Brabham",
    "cooper": "Cooper",
    "mclaren": "McLaren",
    "lotus_f1": "Lotus F1 Team",
    "alfa_1950s": "Alfa Romeo",
    "alfa_1980s": "Alfa Romeo",
    "alfa_sauber": "Alfa Romeo Racing",
}

# `alfa` is one raw id spanning three unrelated eras; split by season so the
# genealogy tree and any future colour legend don't conflate them. Only the
# first era ever produced a race win, so this mainly matters for
# /constructor_seasons.
_ALFA_ERA_BOUNDS = [
    (1950, 1951, "alfa_1950s"),
    (1963, 1985, "alfa_1980s"),  # includes stray 1963/1965 engine-supply entries
    (2019, 2023, "alfa_sauber"),
]


def canonical_key(raw_constructor_id: str, season: int | None = None) -> str:
    """Map a raw Ergast constructorId to a stable identity key.

    `season` is only consulted for ids (currently just `alfa`) that need
    splitting by era; everything else ignores it.
    """
    if raw_constructor_id == "alfa" and season is not None:
        for start, end, key in _ALFA_ERA_BOUNDS:
            if start <= season <= end:
                return key
        return "alfa_1950s"  # defensive fallback, shouldn't hit real data

    return CONSTRUCTOR_ALIASES.get(raw_constructor_id, raw_constructor_id)


def canonical_display_name(key: str, fallback: str) -> str:
    return CANONICAL_DISPLAY_NAMES.get(key, fallback)


# --- Ergast fetch helpers (mirrors circuit_history.py's pattern) -----------


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


def _races_from(payload) -> list[dict]:
    return ((payload or {}).get("MRData") or {}).get("RaceTable", {}).get("Races", [])


def _pagination_from(payload) -> tuple[int, int]:
    """(limit, total) from an Ergast MRData envelope, defaulting to (0, 0) on a bad payload.

    NOTE: `total` counts *result rows*, not races — a handful of races carry
    two P1 rows (see module docstring, defect 1), so `total` can exceed the
    real race count by a few. Advancing the page offset by `limit` (not by
    `len(page)`) is what makes this pagination correct either way.
    """
    data = (payload or {}).get("MRData") or {}
    try:
        return int(data.get("limit", 0)), int(data.get("total", 0))
    except (TypeError, ValueError):
        return 0, 0


async def _fetch_all_winner_races(path: str, page_size: int = 100, max_pages: int = 20) -> list[dict]:
    """Fetch every race for a winners-scoped Ergast endpoint, paginating by result count.

    `max_pages` at page_size=100 covers ~2000 result rows — comfortably above
    the ~1160-race, ~1163-result-row full history — as a defensive cap
    against a runaway loop, not a real-world limit.
    """
    races: list[dict] = []
    offset = 0

    for _ in range(max_pages):
        payload = await asyncio.to_thread(
            _fetch_json, f"{ERGAST_BASE}{path}?limit={page_size}&offset={offset}"
        )
        page = _races_from(payload)
        if not page:
            break
        races.extend(page)

        _, total = _pagination_from(payload)
        offset += page_size
        if offset >= total:
            break

    return races


def _winner(results: list[dict]) -> dict | None:
    return next((r for r in results if str(r.get("position")) == "1"), None)


def normalize_races(raw_races: list[dict]) -> list[dict]:
    """Turn raw Ergast race objects (from a `/results/1/`-shaped endpoint)
    into one clean record per race, applying all five fixes from the module
    docstring. Races missing a usable P1 result or a parseable season/round
    are skipped rather than raising.
    """
    seen: set[tuple[int, int]] = set()
    records: list[dict] = []

    for race in raw_races:
        try:
            season = int(race.get("season"))
            round_ = int(race.get("round"))
        except (TypeError, ValueError):
            continue

        key = (season, round_)
        if key in seen:
            # Defect 1: shared-drive races carry a second P1 row. Keep only
            # the first one encountered.
            continue

        winner = _winner(race.get("Results") or [])
        if not winner:
            continue

        constructor = winner.get("Constructor") or {}
        raw_constructor_id = constructor.get("constructorId")
        if not raw_constructor_id:
            continue

        driver = winner.get("Driver") or {}
        circuit = race.get("Circuit") or {}
        circuit_id = circuit.get("circuitId")
        race_name = race.get("raceName")

        seen.add(key)
        records.append(
            {
                "season": season,
                "round": round_,
                "date": race.get("date"),
                "race_name": race_name,
                "circuit_id": circuit_id,
                "driver": f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip(),
                "constructor_key": canonical_key(raw_constructor_id, season),
                "constructor_name": canonical_display_name(
                    canonical_key(raw_constructor_id, season), constructor.get("name") or raw_constructor_id
                ),
                # Defect 4: the 1950-60 Indy 500 counted for the championship
                # but wasn't a Grand Prix. Distinguished from the 2000-07 US
                # GP, which also ran at the Indianapolis circuit.
                "indy500": circuit_id == "indianapolis" and race_name == "Indianapolis 500",
            }
        )

    records.sort(key=lambda r: (r["season"], r["round"]))
    return records


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# --- /api/historical_race_index ---------------------------------------------


async def _build_full_index() -> list[dict]:
    raw = await _fetch_all_winner_races("/results/1/")
    return normalize_races(raw)


async def _build_season_index(season: int) -> list[dict]:
    raw = await _fetch_all_winner_races(f"/{season}/results/1/")
    return normalize_races(raw)


@router.get("/historical_race_index")
async def get_historical_race_index(
    detail: str = Query(
        "full", description="'full' includes race name/driver/circuit; 'compact' is stripe data only"
    ),
):
    """Every championship race 1950-present, one normalised winner record
    per race, for the 75-Season Barcode. Mongo-first (`historical_race_index`
    collection, kept fresh by `data_sync.py`'s `sync_historical_index`); if
    the collection is empty (fresh database, first local run), fetches and
    normalises the full history live from Jolpica so the endpoint never
    hard-fails.
    """
    db = get_db()

    races = await db.historical_race_index.find({}, {"_id": 0}).sort([("season", 1), ("round", 1)]).to_list(
        length=None
    )

    if not races:
        races = await _build_full_index()
        if races:
            try:
                await db.historical_race_index.insert_many(races, ordered=False)
            except Exception as error:
                print(f"Failed to seed historical_race_index: {error}")

    if detail == "compact":
        races = [
            {
                "season": r["season"],
                "round": r["round"],
                "constructor_key": r["constructor_key"],
                "indy500": r["indy500"],
            }
            for r in races
        ]

    return JSONResponse(content={"races": races, "count": len(races)})


# --- /api/constructor_seasons ------------------------------------------------


async def _fetch_constructor_seasons(constructor_id: str) -> list[int]:
    payload = await asyncio.to_thread(
        _fetch_json, f"{ERGAST_BASE}/constructors/{constructor_id}/seasons/?limit=100"
    )
    data = ((payload or {}).get("MRData") or {}).get("SeasonTable", {}).get("Seasons", [])
    seasons = []
    for entry in data:
        try:
            seasons.append(int(entry.get("season")))
        except (TypeError, ValueError):
            continue
    return sorted(seasons)


@router.get("/constructor_seasons")
async def get_constructor_seasons(
    constructor_id: str = Query(..., description="Raw Ergast constructorId, e.g. 'minardi', 'bar', 'sauber'"),
):
    """Active-year span for one raw Ergast constructorId — the year list
    (not just min/max, since some entries have gaps, e.g. `alfa`'s
    1950-51 / 1963-65 / 1979-85 / 2019-23) that the Constructor Genealogy
    tree sizes its bands against. Deliberately NOT normalised through
    `canonical_key` — the genealogy's curated lineage data maps individual
    raw ids to lineage nodes itself, so this endpoint stays a thin,
    cacheable pass-through per id rather than pre-merging on its behalf.
    Cached forever in `constructor_seasons_cache` (keyed by constructor_id)
    once a constructor's most recent season is in the past — that season
    list can never change again. A constructor whose latest season is the
    current year (still racing, could add another round or another season
    next year) is never cached and is re-resolved from Jolpica on every
    call instead, since this endpoint is cheap (one Jolpica call) and only
    used to build the genealogy page, not hit on every request.
    """
    db = get_db()

    cached = await db.constructor_seasons_cache.find_one({"constructor_id": constructor_id}, {"_id": 0})
    if cached:
        return JSONResponse(content=cached)

    seasons = await _fetch_constructor_seasons(constructor_id)
    response = {"constructor_id": constructor_id, "seasons": seasons}

    current_year = datetime.datetime.now(datetime.timezone.utc).year
    is_finished = bool(seasons) and max(seasons) < current_year

    if is_finished:
        try:
            await db.constructor_seasons_cache.update_one(
                {"constructor_id": constructor_id},
                {"$set": response},
                upsert=True,
            )
        except Exception as error:
            print(f"Failed to cache constructor_seasons for {constructor_id}: {error}")

    return JSONResponse(content=response)
