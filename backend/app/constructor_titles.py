"""Championship titles per constructor, computed from the Jolpica/Ergast archive.

`/api/constructor_titles` answers one question the rest of this app could not:
*what has a constructor actually won?* Race wins were already derivable from
`historical_index.py`'s `/api/historical_race_index` (one winner record per
race since 1950). **Championships were not** — nothing in this repo held them,
and they are the headline fact any team page wants.

WHAT IS COMPUTED HERE, AND FROM WHAT
------------------------------------
Everything this module returns is read from Jolpica's own end-of-season
standings and nothing else:

- **Constructors' Championships**: `/{season}/constructorStandings/1` — the
  constructor classified P1 at the final round of that season. The
  Constructors' Championship was first awarded in **1958**, so seasons before
  that legitimately have no constructor champion and are not an error.
- **Drivers' Championships, attributed to the team they were won with**:
  `/{season}/driverStandings/1` — the champion driver plus the `Constructors`
  Ergast records them driving for that season. This is a *driver* title
  credited to a constructor, never a constructor title, and the payload keeps
  the two in separate fields so a caller cannot accidentally add them together.

A NOTE ON WHY JOLPICA IS QUERIED SEASON-BY-SEASON
-------------------------------------------------
Original Ergast served the season-less form (`/constructorStandings/1`, "every
season's champion in one call"). **Jolpica does not** — it rejects it with
`400 Bad Request: Missing one of the required parameters ['season_year']`
(verified live while writing this module). So one call per season it is: ~68
constructor-standings calls and ~76 driver-standings calls for the full
archive. That is a lot for one request, which is why every season is cached
individually and permanently (below).

THE CURRENT SEASON IS DELIBERATELY EXCLUDED
-------------------------------------------
`/{season}/constructorStandings/1` on an in-progress season returns the
current *leader*, not a champion. Rendering that as a title would be exactly
the class of "a number presented as something it is not" this repo has had to
correct before. The covered range therefore ends at the **last completed
season** (current UTC year - 1). Two consequences worth knowing:

- Every season in range is finished, so every cached season document is
  correct forever and is cached unconditionally — unlike
  `historical_index.get_constructor_seasons`, which has to skip caching a
  still-active constructor.
- The payload states its own range (`first_season`/`last_season`) so the UI
  can label the count honestly ("Constructors' Championships, 1958-2025")
  rather than implying it includes a season still being raced.

`complete` IS THE FIELD CALLERS MUST CHECK
------------------------------------------
A partial fetch (Jolpica rate-limits, and this module makes ~144 calls on a
cold build) produces an *undercount*, not an obvious failure: Ferrari with 12
titles instead of 16 looks like data, not like an error. So failed seasons are
never cached, `seasons_resolved`/`seasons_expected` are reported, and
`complete` is false unless every season in range resolved. The frontend hides
the counts entirely when `complete` is false rather than showing a number it
cannot stand behind.

Constructor ids are normalised through `historical_index.canonical_key`, so
the keys here line up exactly with `historical_race_index`'s
`constructor_key` (chassis/engine-era ids collapsed, `alfa` split by era) and
a caller can aggregate wins and titles against the same key.
"""

import asyncio
import datetime
import json
import random
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .db import get_db
from .historical_index import canonical_key

router = APIRouter(prefix="/api")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "f1-scratch-api/1.0"

#: First World Championship season — the Drivers' title starts here.
FIRST_SEASON = 1950
#: The Constructors' Championship was first awarded in 1958. Seasons between
#: 1950 and 1957 have a drivers' champion and no constructors' champion; that
#: is a real fact about F1, not a gap in the data.
FIRST_CONSTRUCTOR_TITLE_SEASON = 1958

#: How many Jolpica requests may be in flight at once during a cold build.
#: `/history`'s own genealogy fetch already established (in its page comment)
#: that a wide burst reliably trips Jolpica's limiter for several ids at once,
#: so this stays deliberately small.
FETCH_CONCURRENCY = 3

CACHE_COLLECTION = "champion_seasons_cache"


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


def last_completed_season(today: datetime.date | None = None) -> int:
    """The most recent season whose championships are actually decided.

    Deliberately the previous calendar year rather than "has the final round
    been run" — the cheap test is also the safe one here, and the cost of
    being conservative is one season of lag on a 75-season number.
    """
    year = (today or datetime.datetime.now(datetime.timezone.utc).date()).year
    return year - 1


def _standings_list(payload, table_key: str) -> list[dict]:
    lists = (
        ((payload or {}).get("MRData") or {}).get("StandingsTable", {}).get("StandingsLists", [])
    )
    if not lists:
        return []
    return lists[0].get(table_key) or []


def parse_constructor_champion(payload) -> dict | None:
    """`{key, name}` for the constructor classified P1, or None."""
    rows = _standings_list(payload, "ConstructorStandings")
    if not rows:
        return None
    constructor = rows[0].get("Constructor") or {}
    raw_id = constructor.get("constructorId")
    if not raw_id:
        return None
    return {"raw_id": raw_id, "name": constructor.get("name") or raw_id}


def parse_driver_champion(payload) -> dict | None:
    """`{driver, raw_ids}` for the champion driver and the constructor(s)
    Ergast records them driving for that season.

    The `Constructors` array is normally a single entry, but a driver who
    switched teams mid-season carries several. All of them are kept — dropping
    to the first would silently credit one team with a title the record does
    not attribute to it alone.
    """
    rows = _standings_list(payload, "DriverStandings")
    if not rows:
        return None
    row = rows[0]
    driver = row.get("Driver") or {}
    name = f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()
    if not name:
        return None
    raw_ids = [
        c.get("constructorId")
        for c in (row.get("Constructors") or [])
        if c.get("constructorId")
    ]
    return {"driver": name, "driver_id": driver.get("driverId"), "raw_ids": raw_ids}


async def _fetch_season_champions(season: int, attempts: int = 3) -> dict | None:
    """One cacheable record per season, or None if Jolpica did not answer.

    A season with a drivers' champion but no constructors' champion is a valid
    record (1950-57, and any season Jolpica has no constructor standings for);
    a season where the *driver* lookup failed is treated as a failure, because
    every season in the covered range has one.
    """
    for attempt in range(attempts):
        driver_payload = await asyncio.to_thread(
            _fetch_json, f"{ERGAST_BASE}/{season}/driverStandings/1/"
        )
        driver = parse_driver_champion(driver_payload)

        constructor = None
        if season >= FIRST_CONSTRUCTOR_TITLE_SEASON:
            constructor_payload = await asyncio.to_thread(
                _fetch_json, f"{ERGAST_BASE}/{season}/constructorStandings/1/"
            )
            constructor = parse_constructor_champion(constructor_payload)

        constructor_ok = season < FIRST_CONSTRUCTOR_TITLE_SEASON or constructor is not None
        if driver and constructor_ok:
            record: dict = {
                "season": season,
                "driver_champion": driver["driver"],
                "driver_champion_id": driver.get("driver_id"),
                "driver_champion_constructor_keys": [
                    canonical_key(raw_id, season) for raw_id in driver["raw_ids"]
                ],
            }
            if constructor:
                record["constructor_champion_key"] = canonical_key(
                    constructor["raw_id"], season
                )
                record["constructor_champion_name"] = constructor["name"]
            return record

        if attempt < attempts - 1:
            await asyncio.sleep(0.4 * 2**attempt + random.random() * 0.3)

    return None


async def _resolve_seasons(seasons: list[int]) -> tuple[list[dict], int]:
    """Cached-first resolution of every season in `seasons`.

    Returns `(records, expected)`. Missing seasons are fetched with bounded
    concurrency and written back; a season that fails is simply absent from
    `records`, which is what makes `complete` below meaningful.
    """
    db = get_db()

    cached: list[dict] = []
    try:
        cached = await db[CACHE_COLLECTION].find(
            {"season": {"$in": seasons}}, {"_id": 0}
        ).to_list(length=None)
    except Exception as error:  # pragma: no cover - Mongo unavailable
        print(f"champion_seasons_cache read failed: {error}")

    by_season = {record["season"]: record for record in cached if "season" in record}
    missing = [season for season in seasons if season not in by_season]

    if missing:
        semaphore = asyncio.Semaphore(FETCH_CONCURRENCY)

        async def resolve(season: int):
            async with semaphore:
                return await _fetch_season_champions(season)

        fetched = await asyncio.gather(*(resolve(season) for season in missing))
        fresh = [record for record in fetched if record]
        for record in fresh:
            by_season[record["season"]] = record

        # Every season here is finished, so these documents are correct
        # forever — unlike constructor_seasons, none of them needs a
        # "still active, do not cache" carve-out.
        for record in fresh:
            try:
                await db[CACHE_COLLECTION].update_one(
                    {"season": record["season"]}, {"$set": record}, upsert=True
                )
            except Exception as error:  # pragma: no cover - Mongo unavailable
                print(f"Failed to cache champion season {record['season']}: {error}")

    records = [by_season[season] for season in seasons if season in by_season]
    return records, len(seasons)


def aggregate_titles(records: list[dict]) -> dict[str, dict]:
    """Season records -> `{constructor_key: {constructor_titles, driver_titles}}`.

    Pure; every number it produces is a count of season records handed to it,
    which is what makes this testable without touching Jolpica or Mongo.
    """
    out: dict[str, dict] = {}

    def bucket(key: str) -> dict:
        if key not in out:
            out[key] = {"constructor_titles": [], "driver_titles": []}
        return out[key]

    for record in sorted(records, key=lambda r: r.get("season", 0)):
        season = record.get("season")
        constructor_key = record.get("constructor_champion_key")
        if constructor_key:
            bucket(constructor_key)["constructor_titles"].append(season)
        for key in record.get("driver_champion_constructor_keys") or []:
            bucket(key)["driver_titles"].append(
                {"season": season, "driver": record.get("driver_champion")}
            )

    return out


@router.get("/constructor_titles")
async def get_constructor_titles():
    """Every Constructors' Championship, and every Drivers' Championship
    credited to the constructor it was won with, keyed by the same canonical
    constructor key `/api/historical_race_index` uses.

    Covers `FIRST_SEASON` through the **last completed** season — the season
    currently being raced is excluded on purpose (see the module docstring).
    Callers must check `complete`: a partial resolve produces an undercount
    that is indistinguishable from a real number.
    """
    last = last_completed_season()
    seasons = list(range(FIRST_SEASON, last + 1))

    records, expected = await _resolve_seasons(seasons)

    return JSONResponse(
        content={
            "first_season": FIRST_SEASON,
            "last_season": last,
            "constructor_title_first_season": FIRST_CONSTRUCTOR_TITLE_SEASON,
            "seasons_resolved": len(records),
            "seasons_expected": expected,
            "complete": len(records) == expected,
            "constructors": aggregate_titles(records),
        }
    )
