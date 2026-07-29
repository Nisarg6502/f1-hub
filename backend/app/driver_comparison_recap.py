"""LLM-generated head-to-head narrative for two drivers' current season,
grounded in the same comparison this app's own driver-compare modal already
computes client-side (see `frontend/src/lib/driver-compare.ts` and
`compare-drivers-panel.tsx`).

**Every relational fact is precomputed in Python, never left for the model to
derive** — this is the same lesson `session_recap.py` learned the hard way
(see that module's docstring): a model asked to *compare* two drivers from
raw per-round results will confabulate a tally even when the underlying rows
are correct. So this module ports the frontend's exact comparison logic
(`buildHeadToHead` in `driver-compare.ts`) into Python — same round-by-round
race-position comparison, same "whichever qualifying segment both drivers
actually reached" matching — so the counts handed to the model are the same
counts the modal already renders next to the narrative. The model's job is
reduced to narrating "driver A finished ahead in N of M shared rounds",
never to counting rounds itself.

Unlike a finished race (`session_recap.py`'s `session_recap` collection,
cached forever), a driver's season stats change every round a new result
lands. So this cannot cache forever on `{season, driver1, driver2}` alone —
that would serve stale commentary about the pre-latest-round state forever
after. The number of shared race rounds is folded into the cache key
instead: a new race result for either driver changes that number, which
naturally produces a fresh cache row rather than requiring a manual purge
(the same trick `circuit_history_cache` uses staleness-timestamps for, since
a circuit's cross-season history barely changes — a driver's in-season
head-to-head changes every round, so "how many shared rounds" is a better
freshness signal here than a clock).
"""

import json
import os

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .db import get_db

router = APIRouter(prefix="/api")

OLLAMA_BASE = "https://ollama.com"

# Same choice session_recap.py made, for the same reason: this is a factual
# comparison task where confabulation is the main failure mode, and every
# generation is cached, so the extra latency is paid once per fresh
# head-to-head rather than per reader.
DEFAULT_MODEL = "gpt-oss:120b"

# Part of the cache key (alongside `rounds_compared` — see module docstring).
# Bump on any prompt or fact-bundle shape change so existing narratives
# regenerate instead of serving output built for a previous contract.
PROMPT_VERSION = 1

SYSTEM_PROMPT = """You are a Formula 1 analyst writing a short head-to-head narrative comparing two drivers' seasons so far. You will be given a JSON bundle of verified, precomputed facts. Write an accurate, grounded narrative from them.

ABSOLUTE RULES — violating these makes the narrative worthless:
1. Use ONLY facts present in the JSON. Never add races, incidents, penalties, team orders, weather, or any context not in the data.
2. Do not perform arithmetic. Every count and gap is already computed — quote the numbers as given; never recompute, re-derive, or re-tally them yourself.
3. NEVER declare one driver definitively "better" than the other beyond what the explicit head-to-head counts in the JSON support. If the counts are close, split, or mixed across race and qualifying pace, say so plainly rather than picking an overall winner.
4. NEVER invent on-track incidents, clashes, collisions, or team-order narratives. If the data does not mention an event, it did not happen for the purposes of this narrative.
5. NEVER predict or speculate about future races, remaining rounds, or the eventual championship outcome.
6. Ground every comparative claim in the explicit counts given — e.g. "finished ahead in N of M shared rounds" — never a vague "usually" or "often" without the number attached.
7. Do not apply descriptive labels ("dominant", "struggling", "in career-best form") unless the standings/points data plainly supports it.

FORMAT — return GitHub-flavoured Markdown:
- 1-2 short paragraphs, 100-180 words total.
- Use **bold** for driver names on first mention only.
- No headings, no bullet lists, no tables. Flowing prose only.

WHAT TO COVER, in priority order:
1. Current standings context: each driver's position, points and wins this season.
2. Race pace: who has finished ahead of the other more often across the shared rounds this season, and the exact count.
3. Qualifying pace: who has been faster more often across whichever segment both drivers reached, the count, and the average gap if given.
4. If race pace and qualifying pace point in different directions, note that split explicitly rather than resolving it into one verdict.
"""


def _driver_name(entry: dict) -> str:
    driver = entry.get("Driver") or {}
    return f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _find_result(results: list[dict], driver_id: str) -> dict | None:
    return next(
        (r for r in results if (r.get("Driver") or {}).get("driverId") == driver_id),
        None,
    )


# ----------------------------- qualifying pace -----------------------------

_SEGMENTS = ("Q3", "Q2", "Q1")


def _lap_seconds(value) -> float | None:
    """`'1:17.207'` or `'58.212'` -> seconds. None for blanks and junk.

    Mirrors `parseQualiTimeMs` in `frontend/src/lib/driver-compare.ts`
    (seconds here instead of milliseconds — the unit doesn't matter as long
    as both drivers' times are compared in the same one).
    """
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if ":" in text:
            minutes, seconds = text.split(":", 1)
            return int(minutes) * 60 + float(seconds)
        return float(text)
    except ValueError:
        return None


def _best_common_quali_time(a: dict, b: dict) -> dict | None:
    """Whichever qualifying segment both drivers actually set a time in,
    checked Q3 first then falling back to Q2, then Q1.

    Ports `bestCommonQualiTime` in `driver-compare.ts` byte-for-byte in
    behaviour: comparing a driver eliminated in Q2 against the other's Q3
    time would understate how close they actually were in the segment they
    both ran.
    """
    for segment in _SEGMENTS:
        seconds_a = _lap_seconds(a.get(segment))
        seconds_b = _lap_seconds(b.get(segment))
        if seconds_a is not None and seconds_b is not None:
            return {"segment": segment, "seconds_driver1": seconds_a, "seconds_driver2": seconds_b}
    return None


def build_head_to_head(rounds: list[dict], driver1_id: str, driver2_id: str) -> dict:
    """Round-by-round race and qualifying comparison for two drivers.

    `rounds` is a list of `{"round", "raceName", "results", "qualifying"}`
    dicts, one per round of the season — the same shape
    `getSeasonResultsByRound` builds client-side. Ports `buildHeadToHead` in
    `driver-compare.ts` so the counts here agree with what the modal already
    renders next to this narrative.
    """
    race_rounds: list[dict] = []
    quali_rounds: list[dict] = []

    for rnd in rounds:
        result1 = _find_result(rnd.get("results") or [], driver1_id)
        result2 = _find_result(rnd.get("results") or [], driver2_id)
        if result1 and result2:
            position1 = _as_int(result1.get("position"))
            position2 = _as_int(result2.get("position"))
            if position1 is not None and position2 is not None:
                race_rounds.append({
                    "round": rnd.get("round"),
                    "race_name": rnd.get("raceName"),
                    "position_driver1": position1,
                    "position_driver2": position2,
                })

        quali1 = _find_result(rnd.get("qualifying") or [], driver1_id)
        quali2 = _find_result(rnd.get("qualifying") or [], driver2_id)
        if quali1 and quali2:
            common = _best_common_quali_time(quali1, quali2)
            if common:
                quali_rounds.append({
                    "round": rnd.get("round"),
                    "race_name": rnd.get("raceName"),
                    **common,
                })

    race_ahead_1 = sum(1 for r in race_rounds if r["position_driver1"] < r["position_driver2"])
    race_ahead_2 = sum(1 for r in race_rounds if r["position_driver2"] < r["position_driver1"])

    quali_ahead_1 = sum(1 for q in quali_rounds if q["seconds_driver1"] < q["seconds_driver2"])
    quali_ahead_2 = sum(1 for q in quali_rounds if q["seconds_driver2"] < q["seconds_driver1"])
    avg_quali_gap_seconds = (
        round(
            sum(q["seconds_driver1"] - q["seconds_driver2"] for q in quali_rounds) / len(quali_rounds),
            3,
        )
        if quali_rounds
        else None
    )

    return {
        "race_rounds": race_rounds,
        "race_common_count": len(race_rounds),
        "race_ahead_driver1": race_ahead_1,
        "race_ahead_driver2": race_ahead_2,
        "quali_rounds": quali_rounds,
        "quali_common_count": len(quali_rounds),
        "quali_ahead_driver1": quali_ahead_1,
        "quali_ahead_driver2": quali_ahead_2,
        # Positive means driver1 is on average slower (fewer seconds is
        # faster); left unsigned-labelled in the field name deliberately, so
        # the model quotes it rather than reasons about its sign.
        "avg_quali_gap_seconds_driver1_minus_driver2": avg_quali_gap_seconds,
    }


def _standing_facts(standings: list[dict], driver_id: str) -> dict | None:
    entry = next(
        (d for d in standings if (d.get("Driver") or {}).get("driverId") == driver_id),
        None,
    )
    if not entry:
        return None
    constructors = entry.get("Constructors") or []
    return {
        "position": entry.get("position"),
        "points": entry.get("points"),
        "wins": entry.get("wins"),
        "team": constructors[0].get("name") if constructors else None,
    }


def _driver_display_name(driver_id: str, standings: list[dict], rounds: list[dict]) -> str:
    """Best-effort display name, preferring the standings entry.

    Falls back to scanning the round results/qualifying rows in case a
    driver's standings entry is missing (e.g. a mid-season debutant not yet
    reflected in a stale-cached standings document).
    """
    entry = next(
        (d for d in standings if (d.get("Driver") or {}).get("driverId") == driver_id),
        None,
    )
    if entry:
        return _driver_name(entry)
    for rnd in rounds:
        for row in (rnd.get("results") or []) + (rnd.get("qualifying") or []):
            if (row.get("Driver") or {}).get("driverId") == driver_id:
                return _driver_name(row)
    return driver_id


def build_facts(
    year: int,
    driver1_id: str,
    driver2_id: str,
    standings: list[dict],
    rounds: list[dict],
) -> dict:
    head_to_head = build_head_to_head(rounds, driver1_id, driver2_id)

    return {
        "season": year,
        "driver1": {
            "id": driver1_id,
            "name": _driver_display_name(driver1_id, standings, rounds),
            "standing": _standing_facts(standings, driver1_id),
        },
        "driver2": {
            "id": driver2_id,
            "name": _driver_display_name(driver2_id, standings, rounds),
            "standing": _standing_facts(standings, driver2_id),
        },
        "race_head_to_head": {
            "shared_rounds": head_to_head["race_common_count"],
            "driver1_finished_ahead_count": head_to_head["race_ahead_driver1"],
            "driver2_finished_ahead_count": head_to_head["race_ahead_driver2"],
            "rounds": head_to_head["race_rounds"],
        },
        "qualifying_head_to_head": {
            "shared_rounds": head_to_head["quali_common_count"],
            "driver1_faster_count": head_to_head["quali_ahead_driver1"],
            "driver2_faster_count": head_to_head["quali_ahead_driver2"],
            "average_gap_seconds_driver1_minus_driver2": head_to_head[
                "avg_quali_gap_seconds_driver1_minus_driver2"
            ],
            "rounds": head_to_head["quali_rounds"],
        },
    }


async def _generate_recap(facts: dict, system_prompt: str = SYSTEM_PROMPT):
    """Stream narrative text from Ollama Cloud, yielding content deltas.

    Yields nothing if `OLLAMA_API_KEY` is unset or the call fails — the
    endpoint treats an empty result as "no narrative available" rather than
    an error, matching `session_recap.py`'s convention. Deliberately its own
    copy rather than a shared helper: this codebase does not factor the
    Ollama-streaming call out (see `session_recap.py`'s module docstring),
    so every recap-style endpoint owns one.
    """
    api_key = os.getenv("OLLAMA_API_KEY")
    if not api_key:
        return

    payload = {
        "model": os.getenv("OLLAMA_MODEL") or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(facts)},
        ],
        "stream": True,
        # Near-greedy: this is a factual comparison task, and sampling
        # variance is exactly what produces confabulated tallies.
        "options": {"temperature": 0.2},
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                "POST", f"{OLLAMA_BASE}/api/chat", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    print(f"Ollama driver comparison call failed: HTTP {response.status_code}")
                    return
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    content = ((chunk.get("message") or {}).get("content")) or ""
                    if content:
                        yield content
                    if chunk.get("done"):
                        break
    except httpx.HTTPError as error:
        print(f"Ollama driver comparison call failed: {error}")
        return


def _round_sort_key(round_str) -> int:
    return _as_int(round_str) or 0


async def _build_rounds(db, year: int) -> list[dict]:
    """Every round of the season with its cached race + qualifying results.

    Mirrors `getSeasonResultsByRound` in `frontend/src/lib/api.ts`, but reads
    straight from Mongo (`race_results`/`qualifying_results`) rather than
    round-tripping through the HTTP endpoints, since this runs server-side.
    A round missing one or both documents just contributes empty result
    lists for that side, same as the frontend's `Promise.allSettled` fallback.
    """
    race_docs = await db.race_results.find(
        {"season": year}, {"_id": 0}
    ).to_list(length=100)
    quali_docs = await db.qualifying_results.find(
        {"season": year}, {"_id": 0}
    ).to_list(length=100)

    race_by_round = {str(doc.get("round")): doc for doc in race_docs}
    quali_by_round = {str(doc.get("round")): doc for doc in quali_docs}

    all_rounds = sorted(
        set(race_by_round) | set(quali_by_round), key=_round_sort_key
    )

    rounds = []
    for round_str in all_rounds:
        race_doc = race_by_round.get(round_str) or {}
        quali_doc = quali_by_round.get(round_str) or {}
        race_name = (
            (race_doc.get("race") or {}).get("raceName")
            or (quali_doc.get("race") or {}).get("raceName")
            or ""
        )
        rounds.append({
            "round": round_str,
            "raceName": race_name,
            "results": race_doc.get("results") or [],
            "qualifying": quali_doc.get("results") or [],
        })

    return rounds


@router.get("/driver_comparison_recap")
async def get_driver_comparison_recap(
    year: int = Query(..., description="Season year, e.g. 2026"),
    driver1: str = Query(..., description="Ergast driverId, e.g. 'verstappen'"),
    driver2: str = Query(..., description="Ergast driverId, e.g. 'norris'"),
):
    """Stream a Markdown head-to-head narrative for two drivers' season.

    Cached in `driver_comparison_recap`, keyed by season, the two driverIds
    (sorted into a canonical order so either query-parameter order hits the
    same row), `PROMPT_VERSION`, and the number of shared race rounds — see
    module docstring for why a driver's in-season comparison can't cache
    forever the way a finished session's recap does.
    """
    async def empty():
        return
        yield  # pragma: no cover - makes this an async generator

    driver1_id = (driver1 or "").strip()
    driver2_id = (driver2 or "").strip()
    if not driver1_id or not driver2_id or driver1_id == driver2_id:
        return StreamingResponse(empty(), media_type="text/plain")

    d1, d2 = sorted([driver1_id, driver2_id])

    db = get_db()

    rounds = await _build_rounds(db, year)
    standings_doc = await db.driver_standings.find_one({"season": year}, {"_id": 0})
    standings = (standings_doc or {}).get("standings") or []

    facts = build_facts(year, d1, d2, standings, rounds)
    rounds_compared = facts["race_head_to_head"]["shared_rounds"]

    if rounds_compared == 0:
        return StreamingResponse(empty(), media_type="text/plain")

    cache_key = {
        "season": year,
        "driver1": d1,
        "driver2": d2,
        "prompt_version": PROMPT_VERSION,
        "rounds_compared": rounds_compared,
    }

    cached = await db.driver_comparison_recap.find_one(cache_key, {"_id": 0})

    async def replay_cached():
        yield cached["text"]

    if cached and cached.get("text"):
        return StreamingResponse(replay_cached(), media_type="text/plain")

    async def generate_and_cache():
        parts: list[str] = []
        async for chunk in _generate_recap(facts):
            parts.append(chunk)
            yield chunk
        full_text = "".join(parts).strip()

        if not full_text:
            return

        try:
            await db.driver_comparison_recap.update_one(
                cache_key, {"$set": {**cache_key, "text": full_text}}, upsert=True
            )
        except Exception as error:
            print(
                f"Failed to cache driver_comparison_recap for {year} "
                f"{d1} vs {d2}: {error}"
            )

    return StreamingResponse(generate_and_cache(), media_type="text/plain")
