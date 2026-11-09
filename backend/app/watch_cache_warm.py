"""Rebuild watch mode's derived caches for a season's finished rounds.

`race_replay` and `race_timing` are cached in Mongo under a fingerprint of the
code that builds them (`derived_cache.py`) and of their source documents. Two
things therefore leave a round cold, and the next viewer of that round pays
for the rebuild inside their page load:

- **A backend deploy** that touches either module, or anything it imports,
  retires every cached round at once. Measured on 2026-11-08 after two deploys
  that afternoon: the first `/watch/2026-19` took 21.1s (replay rebuild 5.1s,
  then timing 15.0s re-downloading three OpenF1 feeds) against ~0.8s warm.
- **The sync job** writing a new or revised round's laps, which changes the
  input fingerprint. The viewer it catches is the one opening a race the
  evening it is run, the moment watch mode is most likely to be used.

So both run this afterwards: `cloudbuild-backend.yaml` as a script and
`data_sync.main` by import. It warms through the public API rather than by
calling the builders directly, so it exercises exactly the code a viewer would
and files the result under the deployed revision's own code fingerprint.

Stdlib only, because the deploy step runs it with a bare `python3` on the
`python:3.12-slim` image. Never raises and never exits non-zero: a cold cache is a slow page,
not a broken deploy or a failed sync.

    python3 backend/app/watch_cache_warm.py [--base URL] [--year 2026]
"""

import argparse
import datetime
import json
import sys
import time
import urllib.request

DEFAULT_BASE = "https://f1-backend-1076575666662.asia-south1.run.app"
# Sequential, on purpose. A rebuild calls OpenF1, and four in flight got
# rate-limited on 2026-11-08: R12 and R14 came back with "no OpenF1 feeds" and
# R15-R17 with "no race control". The backend rightly refuses to cache such a
# build, so a parallel warm left exactly those rounds cold. Sequential takes
# under a minute for a full season.
TIMEOUT_S = 180
# The header both endpoints send with a cache hit (`derived_cache.
# CACHE_HIT_HEADERS`; not imported, to keep this script stdlib only). Response
# time is no signal: from a Cloud Build worker a hit takes ~2s, and a rebuild
# that OpenF1 refused (served, not cached) comes back about as fast.
CACHE_HIT_HEADER = "X-Derived-Cache"


def _get(url: str) -> tuple[dict | None, float, bool]:
    """`(body, seconds, served from the cache)`. Body is `None` on any failure."""
    started = time.monotonic()
    hit = False
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "apex-cache-warmer"})
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            hit = response.headers.get(CACHE_HIT_HEADER) == "hit"
            body = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - reported, never raised
        print(f"  ! {url}: {error}")
        body = None
    return body, time.monotonic() - started, hit


def finished_rounds(base: str, year: int, today: datetime.date) -> list[int]:
    """Rounds of `year` whose race date is before `today`, per `/api/races`."""
    races, _, _ = _get(f"{base}/api/races?year={year}")
    rounds = []
    for race in (races or {}).get("races") or []:
        try:
            if datetime.date.fromisoformat(race["date"]) < today:
                rounds.append(int(race["round"]))
        except (KeyError, ValueError, TypeError):
            continue
    return sorted(rounds)


def warm_round(base: str, year: int, round_number: int) -> str:
    replay, replay_s, _ = _get(f"{base}/api/race_replay?year={year}&round={round_number}")
    if not (replay or {}).get("synced"):
        return f"R{round_number}: no replay yet ({replay_s:.1f}s)"
    timing, timing_s, _ = _get(f"{base}/api/race_timing?year={year}&round={round_number}")
    synced = "synced" if (timing or {}).get("synced") else "no per-second timing"
    return f"R{round_number}: replay {replay_s:.1f}s, timing {timing_s:.1f}s ({synced})"


def warm_season(base: str, year: int, rounds: list[int] | None = None) -> list[str]:
    """Warm `rounds` of `year` (default: every finished one). Returns cold leftovers.

    The returned list names each endpoint that a second pass did not find in
    the cache (served but not stored, or failed), so the caller can report it.
    Empty means every round now answers from the cache.
    """
    base = base.rstrip("/")
    try:
        if rounds is None:
            rounds = finished_rounds(base, year, datetime.date.today())
        if not rounds:
            print(f"watch cache warm: no finished rounds for {year}")
            return []
        print(f"watch cache warm: {len(rounds)} round(s) of {year} against {base}")
        started = time.monotonic()
        for round_number in rounds:
            print(f"  {warm_round(base, year, round_number)}")

        cold = []
        for round_number in rounds:
            for name in ("race_replay", "race_timing"):
                _, seconds, hit = _get(f"{base}/api/{name}?year={year}&round={round_number}")
                if not hit:
                    cold.append(f"R{round_number} {name} {seconds:.1f}s")
        if cold:
            print("  still cold (the next viewer pays for these): " + ", ".join(cold))
        else:
            print("  every round answers warm")
        print(f"  done in {time.monotonic() - started:.0f}s")
        return cold
    except Exception as error:  # noqa: BLE001 - must never fail a deploy or sync
        print(f"watch cache warm failed for {year}: {error}")
        return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--year", type=int, default=datetime.date.today().year)
    args = parser.parse_args()
    warm_season(args.base, args.year)
    return 0


if __name__ == "__main__":
    sys.exit(main())
