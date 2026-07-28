"""'Explain this race' recap: an LLM-generated summary grounded strictly in
this app's own cached data plus OpenF1 race control.

Scope is deliberately Race-only for now (not Qualifying/Sprint) — see
`ROADMAP.md`.

**Everything the model could get wrong by doing arithmetic or inference is
computed here instead.** The first version of this endpoint handed the model
a bare classification list and let it find "the story" itself, and it
hallucinated a teammate relationship between two drivers on visibly
different teams (Verstappen/Red Bull and Antonelli/Mercedes, 2026 Hungarian
GP). The lesson generalized: an LLM asked to *derive* relational facts will
confabulate them even when the underlying fields are correct and present. So
`build_facts` now pre-computes teammate pairings, positions gained/lost, the
podium, the closest gap, and retirements — the model's job is reduced to
narrating already-true statements rather than inferring which are true.

Generated once per race and cached forever in `session_recap` — a finished
race's facts never change. `PROMPT_VERSION` is part of the cache identity, so
bumping it when the prompt or fact-bundle shape changes retires every stale
recap without needing a manual purge.
"""

import asyncio
import json
import os

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .db import get_db
from .race_control_facts import summarize_race_control

router = APIRouter(prefix="/api")

OLLAMA_BASE = "https://ollama.com"
OPENF1_BASE = "https://api.openf1.org/v1"

# gpt-oss:120b over the 20b this shipped with: the smaller model produced a
# confidently-wrong teammate claim (see module docstring) and accuracy matters
# more here than the extra latency, since generation happens once per race and
# every subsequent reader is served from cache.
DEFAULT_MODEL = "gpt-oss:120b"

# Part of the cache key. Bump on any prompt or fact-bundle change so existing
# recaps regenerate instead of serving output from the previous contract.
PROMPT_VERSION = 2

SYSTEM_PROMPT = """You are a Formula 1 race recap writer. You will be given a JSON bundle of verified facts about one race. Write an accurate, engaging recap.

ABSOLUTE RULES — violating these makes the recap worthless:
1. Use ONLY facts present in the JSON. Never add drivers, teams, incidents, weather, tyre strategies, or championship context that is not in the data.
2. NEVER state or imply that two drivers are teammates unless they appear together in the `teammates` array. Do not infer team relationships from anything else.
3. Do not perform arithmetic. Gaps, positions gained/lost, and counts are already computed — quote them as given.
4. If the data does not explain WHY something happened, do not speculate. Say what happened, not why.
5. Do NOT explain, invoke, or infer F1 sporting regulations — no claims about points systems, bonus points for fastest lap, award eligibility, or what a penalty's consequence was. The `points` field is the authoritative points value; never justify it.
6. Do NOT claim that any event did or did not affect the final order, the outcome, or a driver's race unless the data explicitly says so. Omit such judgements entirely.
7. Do NOT apply descriptive labels to drivers or cars ("front-running", "midfield", "title contender", "veteran") unless the grid/position data plainly supports it. When in doubt, just name them.
8. Every factual claim must carry a citation marker (see below).

CITATIONS — attach one to each factual claim, inline, in square brackets:
- Classification facts: `[P3]` — the finishing position the fact came from.
- Fastest lap: `[FL]`
- A race-control event: `[RC L66]` — RC plus the lap number (omit the lap if null: `[RC]`).
- Positions gained/lost: `[P7, grid 12]`
Example: `Norris won by 15.080s [P1], holding off Verstappen [P2].`

FORMAT — return GitHub-flavoured Markdown:
- 3-4 short paragraphs, 180-280 words total.
- Use **bold** for driver names on first mention only.
- No headings, no bullet lists, no tables. Flowing prose only.

WHAT TO COVER, in priority order:
1. The winner, the margin, and who completed the podium.
2. Any penalties or stewards' decisions in `race_control.events` — these are often the real story and must not be omitted if present.
3. Safety car / VSC periods if present.
4. The standout drive from `biggest_movers`, and any notable retirements.
5. The fastest lap.
"""


def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def fetch_race_control(race_date: str) -> list[dict]:
    """Race-control messages for a race, via OpenF1's session lookup by date.

    Returns [] on any failure — race control is enrichment, not a hard
    dependency, and a recap without it is still worth generating. Note this
    used to be impossible for the current season (OpenF1 paywalled it behind
    a 401) but is reachable again as of 2026-07.
    """
    if not race_date:
        return []

    sessions = _fetch_json(
        f"{OPENF1_BASE}/sessions", {"year": race_date[:4], "session_type": "Race"}
    )
    if not isinstance(sessions, list):
        return []

    session = next(
        (s for s in sessions if str(s.get("date_start", "")).startswith(race_date)), None
    )
    if not session or not session.get("session_key"):
        return []

    messages = _fetch_json(
        f"{OPENF1_BASE}/race_control", {"session_key": session["session_key"]}
    )
    return messages if isinstance(messages, list) else []


def _driver_name(entry: dict) -> str:
    driver = entry.get("Driver") or {}
    return f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _classification_facts(results: list[dict]) -> list[dict]:
    facts = []
    for r in results:
        grid = _as_int(r.get("grid"))
        position = _as_int(r.get("position"))
        gained = (grid - position) if (grid is not None and position is not None) else None
        facts.append({
            "position": r.get("position"),
            "driver": _driver_name(r),
            "team": (r.get("Constructor") or {}).get("name"),
            "status": r.get("status"),
            "gap_to_leader": (r.get("Time") or {}).get("time") or r.get("status"),
            "points": r.get("points"),
            "grid": r.get("grid"),
            "positions_gained": gained,
        })
    return facts


def _teammates(results: list[dict]) -> list[dict]:
    """Explicit teammate pairings, so the model never has to infer one.

    This exists because inferring it is exactly what went wrong in v1.
    """
    by_team: dict[str, list[str]] = {}
    for r in results:
        team = (r.get("Constructor") or {}).get("name")
        name = _driver_name(r)
        if team and name:
            by_team.setdefault(team, []).append(name)
    return [
        {"team": team, "drivers": drivers}
        for team, drivers in by_team.items()
        if len(drivers) > 1
    ]


def _fastest_lap_facts(results: list[dict]) -> dict | None:
    fastest = next((r for r in results if (r.get("FastestLap") or {}).get("rank") == "1"), None)
    if not fastest:
        return None
    lap = fastest.get("FastestLap") or {}
    return {
        "driver": _driver_name(fastest),
        "team": (fastest.get("Constructor") or {}).get("name"),
        "time": (lap.get("Time") or {}).get("time"),
        "lap": lap.get("lap"),
        "finishing_position": fastest.get("position"),
    }


def _biggest_movers(classification: list[dict], limit: int = 3) -> list[dict]:
    movers = [c for c in classification if c.get("positions_gained")]
    movers.sort(key=lambda c: -(c.get("positions_gained") or 0))
    return [
        {
            "driver": m["driver"],
            "grid": m["grid"],
            "position": m["position"],
            "positions_gained": m["positions_gained"],
        }
        for m in movers[:limit]
        if (m.get("positions_gained") or 0) > 0
    ]


# A classified finisher's status is "Finished", "+1 Lap"/"+2 Laps", or
# "Lapped" — all of which mean they saw the chequered flag. Anything else
# ("Retired", "Accident", "Engine", "Collision", …) is a genuine retirement.
_FINISHER_STATUSES = ("finished", "+", "lapped")


def _retirements(classification: list[dict]) -> list[dict]:
    return [
        {
            "driver": c["driver"],
            "team": c["team"],
            "status": c["status"],
            "grid": c["grid"],
            "position": c["position"],
        }
        for c in classification
        if c.get("status")
        and not str(c["status"]).strip().lower().startswith(_FINISHER_STATUSES)
    ]


def build_facts(race: dict, results: list[dict], race_control_messages: list[dict]) -> dict:
    classification = _classification_facts(results)
    podium = classification[:3]

    return {
        "race_name": race.get("raceName"),
        "season": race.get("season"),
        "round": race.get("round"),
        "circuit": (race.get("Circuit") or {}).get("circuitName"),
        "total_finishers": len(classification),
        "podium": podium,
        "classification": classification,
        "teammates": _teammates(results),
        "biggest_movers": _biggest_movers(classification),
        "retirements": _retirements(classification),
        "fastest_lap": _fastest_lap_facts(results),
        "race_control": summarize_race_control(race_control_messages, results),
    }


async def _generate_recap(facts: dict):
    """Stream recap text from Ollama Cloud, yielding content deltas.

    Yields nothing if `OLLAMA_API_KEY` is unset or the call fails — the
    endpoint treats an empty result as "no recap available" rather than an
    error, matching every other module here.

    Only `message.content` is forwarded. Reasoning models on Ollama Cloud also
    stream a `message.thinking` field carrying raw chain-of-thought; forwarding
    it would leak reasoning traces into user-facing prose.
    """
    api_key = os.getenv("OLLAMA_API_KEY")
    if not api_key:
        return

    payload = {
        "model": os.getenv("OLLAMA_MODEL") or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(facts)},
        ],
        "stream": True,
        # Near-greedy: this is a factual summarization task, and sampling
        # variance is exactly what produced the v1 hallucination.
        "options": {"temperature": 0.2},
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                "POST", f"{OLLAMA_BASE}/api/chat", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    print(f"Ollama recap call failed: HTTP {response.status_code}")
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
        print(f"Ollama recap call failed: {error}")
        return


@router.get("/session_recap")
async def get_session_recap(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round: int = Query(..., description="Round number within the season"),
):
    """Stream a Markdown race recap, cached forever after first generation."""
    db = get_db()
    cache_key = {
        "season": year,
        "round": str(round),
        "session": "race",
        "prompt_version": PROMPT_VERSION,
    }

    cached = await db.session_recap.find_one(cache_key, {"_id": 0})

    async def replay_cached():
        yield cached["text"]

    if cached and cached.get("text"):
        return StreamingResponse(replay_cached(), media_type="text/plain")

    doc = await db.race_results.find_one({"season": year, "round": str(round)}, {"_id": 0})
    results = (doc or {}).get("results") or []

    async def empty():
        return
        yield  # pragma: no cover - makes this an async generator

    if not results:
        return StreamingResponse(empty(), media_type="text/plain")

    race = (doc or {}).get("race", {})
    messages = await asyncio.to_thread(fetch_race_control, race.get("date", ""))
    facts = build_facts(race, results, messages)

    async def generate_and_cache():
        parts: list[str] = []
        async for chunk in _generate_recap(facts):
            parts.append(chunk)
            yield chunk

        full_text = "".join(parts).strip()
        if not full_text:
            return

        try:
            await db.session_recap.update_one(
                cache_key, {"$set": {**cache_key, "text": full_text}}, upsert=True
            )
        except Exception as error:
            print(f"Failed to cache session_recap for {year} R{round}: {error}")

    return StreamingResponse(generate_and_cache(), media_type="text/plain")
