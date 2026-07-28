"""'Explain this race' recap: an LLM-generated summary grounded strictly in
this app's own cached classification data.

Scope is deliberately Race-only for now (not Qualifying/Sprint) — see
`ROADMAP.md`. Sourced from `race_results` alone (not `pit_stops`/`race_stints`,
which depend on separate sync paths that aren't always populated) so a recap
is available for essentially any finished race, not just ones lucky enough to
have strategy data cached too.

Generated once per race and cached forever in `session_recap` — a finished
race's facts never change, so there's no staleness window to manage the way
`circuit_history_cache` has one. Calls Ollama Cloud (`OLLAMA_API_KEY`,
`OLLAMA_MODEL`) with streaming enabled, forwarding tokens to the client as
they arrive on a cache miss so the first-ever request for a given race isn't
a long silent wait; a cache hit just replays the stored text as one chunk
through the same streaming response so the frontend has one code path either
way.
"""

import json
import os

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .db import get_db

router = APIRouter(prefix="/api")

OLLAMA_BASE = "https://ollama.com"
# Confirmed available via `GET /api/tags` against a real Ollama Cloud key —
# gpt-oss:20b is a good speed/quality balance; gpt-oss:120b is available on
# the same key for noticeably better prose at higher per-call latency, if
# ever worth the tradeoff. Override via OLLAMA_MODEL either way.
DEFAULT_MODEL = "gpt-oss:20b"

SYSTEM_PROMPT = (
    "You are a Formula 1 race recap writer. You will be given a JSON bundle "
    "of factual race data (final classification, retirements, fastest lap). "
    "Write a concise, engaging recap of 3-4 short paragraphs (150-250 words) "
    "covering: who won and by how much, the main story of the race (biggest "
    "mover, tightest battle, or notable retirement — inferred only from the "
    "gaps and statuses given), and the fastest lap. Use only the facts "
    "provided — do not invent details, lap-by-lap events, weather, or "
    "incidents that aren't implied by the data. Do not editorialize about "
    "championship implications unless points are in the data. Write in "
    "plain prose, no headings or bullet points."
)


def _classification_facts(results: list[dict]) -> list[dict]:
    """Compact classification facts: every result, trimmed to what the model needs."""
    facts = []
    for r in results:
        driver = r.get("Driver") or {}
        name = f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()
        facts.append({
            "position": r.get("position"),
            "driver": name,
            "team": (r.get("Constructor") or {}).get("name"),
            "status": r.get("status"),
            "gap_to_leader": (r.get("Time") or {}).get("time") or r.get("status"),
            "points": r.get("points"),
        })
    return facts


def _fastest_lap_facts(results: list[dict]) -> dict | None:
    fastest = next((r for r in results if (r.get("FastestLap") or {}).get("rank") == "1"), None)
    if not fastest:
        return None
    driver = fastest.get("Driver") or {}
    lap = fastest.get("FastestLap") or {}
    return {
        "driver": f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip(),
        "time": (lap.get("Time") or {}).get("time"),
        "lap": lap.get("lap"),
    }


def build_facts(race: dict, results: list[dict]) -> dict:
    return {
        "race_name": race.get("raceName"),
        "season": race.get("season"),
        "round": race.get("round"),
        "circuit": ((race.get("Circuit") or {}).get("circuitName")),
        "classification": _classification_facts(results),
        "fastest_lap": _fastest_lap_facts(results),
    }


async def _generate_recap(facts: dict):
    """Stream tokens from Ollama Cloud, yielding text chunks as they arrive.

    Yields nothing (an empty generator) if `OLLAMA_API_KEY` isn't set or the
    call fails outright — the endpoint below treats an empty result as "no
    recap available" rather than an error, same as every other module here.
    """
    api_key = os.getenv("OLLAMA_API_KEY")
    if not api_key:
        return

    model = os.getenv("OLLAMA_MODEL") or DEFAULT_MODEL
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(facts)},
        ],
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
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
    """Stream an AI-generated race recap, cached forever after first generation.

    A `race_results` cache miss, or a missing `OLLAMA_API_KEY`, both result in
    an empty stream — the frontend treats "no text ever arrived" as "no recap
    available" and simply doesn't render the card, rather than erroring.
    """
    db = get_db()

    cached = await db.session_recap.find_one(
        {"season": year, "round": str(round), "session": "race"}, {"_id": 0}
    )

    async def replay_cached():
        yield cached["text"]

    if cached and cached.get("text"):
        return StreamingResponse(replay_cached(), media_type="text/plain")

    doc = await db.race_results.find_one(
        {"season": year, "round": str(round)}, {"_id": 0}
    )
    results = (doc or {}).get("results") or []
    if not results:
        async def empty():
            return
            yield  # pragma: no cover - makes this an async generator

        return StreamingResponse(empty(), media_type="text/plain")

    facts = build_facts((doc or {}).get("race", {}), results)

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
                {"season": year, "round": str(round), "session": "race"},
                {"$set": {
                    "season": year,
                    "round": str(round),
                    "session": "race",
                    "text": full_text,
                }},
                upsert=True,
            )
        except Exception as error:
            print(f"Failed to cache session_recap for {year} R{round}: {error}")

    return StreamingResponse(generate_and_cache(), media_type="text/plain")
