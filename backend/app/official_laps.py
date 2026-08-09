"""Official lap-by-lap timings for a finished race, from the Ergast/Jolpica archive.

**This is the spine of watch mode's timing, and it exists because every
OpenF1-derived timeline before it was measurably wrong.** The history is worth
stating plainly, because the mistake is easy to repeat: `race_timing` used to
anchor OpenF1's `/position` samples against lap boundaries derived from
OpenF1's `/laps` feed, and validate the result against OpenF1. A feed always
agrees with itself. Checked against the official record, the 2026 Australian
GP came out with laps 1 and 2 inverted — Russell shown leading lap 1 and
Leclerc lap 2, where the official classification has exactly the reverse.

Two independent faults caused that, and neither is fixable inside OpenF1:

* Its `/laps` feed is simply **missing lap-2 rows for cars 16, 63 and 44** on
  that round — Leclerc, Russell and Hamilton, the entire podium fight. The
  "leader's crossing" for lap 1 therefore came from Hadjar in P4.
* Its remaining crossing times put Leclerc 0.56s ahead at the end of lap 2,
  where the official lap times have Russell ahead by 0.44s.

What this archive provides that OpenF1 does not is a **complete and internally
consistent** record: every driver's time for every lap, from a standing start.
Summing them reproduces the stated finishing order exactly, which is the check
`verify_race_timing` now runs. Coverage was confirmed for all eleven synced
2026 rounds (871-1445 rows each) before this module was written.

Cumulative sums of those lap times are real elapsed race seconds, which is the
single most useful property here: it means the replay clock and the sample
timeline are *the same timeline*, and no rescaling is needed to move between
them. The old code's entire `_lap_spans`/`_anchor` apparatus existed to map
wall-clock instants onto a synthetic clock built from summed lap minima, and
the distortion it introduced within each lap is where the bugs lived.

Cached in `official_laps` because the archive is immutable for a finished race
and a single round costs 9-15 paged requests to assemble.
"""

import time

import httpx

from .db import get_db

JOLPICA_BASE = "https://api.jolpi.ca/ergast/f1"

# Jolpica's hard per-request ceiling. A race is ~1000 rows, so this is 9-15
# sequential requests; the results are cached, so that cost is paid once.
PAGE_SIZE = 100

# A full season is ~130 requests and reliably trips Jolpica's rate limit
# somewhere around round 9. Four attempts at 2s doubling covers a 30s window,
# which cleared it in practice.
RETRIES = 4
BACKOFF_SECONDS = 2.0

# Bump when the shape of a cached document changes.
OFFICIAL_VERSION = 1


def _lap_seconds(value: str) -> float | None:
    """`"1:31.929"` -> `91.929`. Also accepts a bare `"31.929"`.

    A malformed entry returns None rather than raising: one unparseable lap
    must cost that lap, not the whole race.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    parts = value.strip().split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None
    return None


def parse_lap_pages(pages: list[dict]) -> list[dict]:
    """Flatten Jolpica's paged `/laps` payload into `[{lap, timings: [...]}]`.

    Each timing carries `driverId`, `position` and `cumulative_ms` — the
    driver's elapsed race time at the moment they completed that lap, which is
    the running sum of their own lap times.

    **A driver who is missing from a lap does not break the sum.** Their
    cumulative simply does not advance for that lap and their next entry
    continues from where they were, which understates their elapsed time. That
    is why `verify_race_timing` scores positions rather than trusting the
    cumulative blindly, and why a lap absent for *everyone* is left absent
    rather than interpolated.
    """
    cumulative: dict[str, float] = {}
    by_lap: dict[int, list[dict]] = {}

    for page in pages:
        races = (((page or {}).get("MRData") or {}).get("RaceTable") or {}).get("Races") or []
        for race in races:
            for lap in race.get("Laps") or []:
                try:
                    number = int(lap.get("number"))
                except (TypeError, ValueError):
                    continue
                for timing in lap.get("Timings") or []:
                    driver_id = timing.get("driverId")
                    seconds = _lap_seconds(timing.get("time"))
                    try:
                        position = int(timing.get("position"))
                    except (TypeError, ValueError):
                        continue
                    if not driver_id or seconds is None:
                        continue
                    cumulative[driver_id] = cumulative.get(driver_id, 0.0) + seconds
                    by_lap.setdefault(number, []).append({
                        "driverId": driver_id,
                        "position": position,
                        # Integer ms throughout: this is the unit the wire
                        # contract and the frontend clock both speak, and
                        # carrying floats here invites the two to disagree in
                        # the last decimal place.
                        "cumulative_ms": round(cumulative[driver_id] * 1000),
                    })

    return [{"lap": lap, "timings": by_lap[lap]} for lap in sorted(by_lap)]


def fetch_official_laps(year: int, round_number: int) -> list[dict]:
    """Every lap of a round from Jolpica, or `[]`.

    `[]` covers a season the archive does not have and any network failure —
    the caller degrades to the lap-stepped tower for both, so there is nothing
    a raise would communicate that the empty list does not.

    **All or nothing.** Keeping the pages that did arrive was tried first and is
    a trap: Jolpica rate-limits a full-season sync partway through, and the
    result was rounds 9, 10 and 11 cached as 28-, 15- and 14-lap races. Each
    one passes every consistency check in `verify_race_timing`, because a prefix
    of a race is perfectly self-consistent — it is simply not the race. A
    truncated spine would freeze the tower mid-race with no indication why,
    where an empty one degrades to the lap-stepped view and says `synced:
    false`.
    """
    pages: list[dict] = []
    offset = 0
    total = None

    while total is None or offset < total:
        url = f"{JOLPICA_BASE}/{year}/{round_number}/laps.json"
        payload = None
        for attempt in range(RETRIES):
            try:
                response = httpx.get(
                    url, params={"limit": PAGE_SIZE, "offset": offset}, timeout=45.0
                )
                response.raise_for_status()
                payload = response.json()
                break
            except Exception as error:
                # 429 is the expected failure on a full-season sync — the
                # archive is a free service and a season is ~130 requests. Back
                # off rather than giving up, because giving up now costs the
                # whole round.
                if attempt == RETRIES - 1:
                    print(f"official_laps: giving up on {year} R{round_number} @{offset}: {error}")
                    return []
                time.sleep(BACKOFF_SECONDS * (2 ** attempt))

        if payload is None:
            return []
        pages.append(payload)
        try:
            total = int(payload["MRData"]["total"])
        except (KeyError, TypeError, ValueError):
            print(f"official_laps: no row total for {year} R{round_number}, discarding")
            return []
        offset += PAGE_SIZE

    return parse_lap_pages(pages)


async def official_laps_for(year: int, round_number: int) -> list[dict]:
    """Mongo-first `fetch_official_laps`, caching on the way through."""
    db = get_db()
    key = {"season": year, "round": str(round_number), "version": OFFICIAL_VERSION}

    try:
        cached = await db.official_laps.find_one(key, {"_id": 0, "laps": 1})
    except Exception as error:
        print(f"official_laps: cache read failed for {year} R{round_number}: {error}")
        cached = None
    if cached and cached.get("laps"):
        return cached["laps"]

    import asyncio

    laps = await asyncio.to_thread(fetch_official_laps, year, round_number)
    if not laps:
        return []

    try:
        await db.official_laps.update_one(
            key, {"$set": {**key, "laps": laps}}, upsert=True
        )
    except Exception as error:
        print(f"official_laps: cache write failed for {year} R{round_number}: {error}")

    return laps
