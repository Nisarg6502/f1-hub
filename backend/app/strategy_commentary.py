""""Strategy Commentary": an LLM-generated recap of a finished race's tyre and
pit strategy, grounded strictly in this app's own cached data.

Follows `session_recap.py`'s shape and its central lesson (see that module's
docstring / `ROADMAP.md`'s CP38 entry for the full post-mortem): an LLM asked
to *derive* a relational fact — who undercut whom, who gained track position,
who ran an unusual strategy — will confabulate it even when the correct raw
numbers are sitting right in front of it. So every relational fact this module
needs is computed here, in Python, from the already-cached `race_stints`,
`pit_stops` and `race_laps` collections:

- Each driver's stint sequence (compound, lap range, length) comes straight
  off `race_stints`.
- Whether a pit stop was an "undercut" or an "overcut" is resolved by
  comparing two drivers' `race_laps` track position just before the earlier
  of their two stops against their position a few laps after the later one —
  never left for the model to eyeball from raw lap/position numbers.
- An unusual strategy (a 1-stop against a field that mostly ran 2, or vice
  versa) is flagged by comparing each driver's stop count to the field's most
  common one.

`race_stints`/`race_laps` key a driver by `driver_number` (an int, `23`) while
`pit_stops` keys by `driver_id` (an Ergast slug, `"albon"`) — the same
namespace mismatch `race_replay.py` already solved once. Rather than risk
re-deriving that join and hitting its silent-failure mode (a stop whose
`driver_id` doesn't match anything just vanishes, no error), this module
reuses `race_replay._driver_directory`/`_number_by_driver_id` directly.

This endpoint is read-only against what's already cached: it does NOT call
out to FastF1 or Ergast itself, and does NOT trigger the self-heal rebuild
those source endpoints perform on a cache miss. If `race_stints`, `race_laps`
or `race_results` isn't populated yet for a round, this reports "no
commentary available" the same way every other Pitwall module reports "not
synced yet" — same fail-soft posture, just with a smaller blast radius (no
outbound calls at all).

Generated once per race and cached forever in `strategy_commentary` — a
finished race's stint/pit facts never change. The cache key includes
`PROMPT_VERSION`, kept independent of `session_recap.py`'s own version
counter since the two modules' prompts evolve separately.
"""

import json
import os
from collections import Counter

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .db import get_db
# From `driver_directory` rather than from `race_replay`, which is where these
# two used to live: importing `race_replay` pulls in `race_laps` and therefore
# FastF1, and the `f1-agent` service reuses `build_facts` below while
# deliberately having no FastF1 installed at all (plan §5.1). Same functions,
# same behaviour — see `driver_directory.py`.
from .driver_directory import _driver_directory, _number_by_driver_id

router = APIRouter(prefix="/api")

OLLAMA_BASE = "https://ollama.com"

# Same choice session_recap.py made and for the same reason: this is a
# factual-narration task run once per race and served from cache after that,
# so the extra latency of the larger model is worth paying for the accuracy.
DEFAULT_MODEL = "gpt-oss:120b"

# Part of the cache key. Bump on any prompt or fact-bundle shape change so
# existing commentary regenerates instead of serving output from the previous
# contract. Independent of session_recap.PROMPT_VERSION by design.
PROMPT_VERSION = 1

# How many laps apart two pit stops can be and still be considered part of the
# same undercut/overcut window. Wider than this and the stops aren't really
# racing each other for the same track position anymore.
_WINDOW_LAPS = 3

# How many laps after the *later* of two stops to sample position again, to
# give both drivers' out-laps time to settle before comparing order. Too
# short and a slow out-lap alone would look like a swing that never stuck.
_SETTLE_LAPS = 2

_ABSOLUTE_RULES = """ABSOLUTE RULES — violating these makes the commentary worthless:
1. Use ONLY facts present in the JSON. Never add drivers, teams, tyre compounds, incidents, or race events that are not in the data.
2. Do not perform arithmetic. Lap numbers, stint lengths, stop counts and position numbers are already computed — quote them as given.
3. NEVER assert that a pit stop was an undercut or an overcut unless it appears in `undercut_overcut_events` with that exact `outcome`. Do not infer one from stint lengths or lap numbers alone.
4. NEVER state or imply causation beyond what an event's fields say. `undercut_overcut_events` tells you a driver was ahead or behind at two specific laps around a pit window — it does not tell you why (traffic, tyre degradation, a mistake), so do not speculate.
5. Do NOT rank strategies as "best", "worst", "optimal" or "the right call" unless the position-gain data in `undercut_overcut_events` directly supports the specific claim you're making about that specific pair of drivers. A driver simply doing a different number of stops (`strategy_outliers`) is not itself evidence a strategy worked or failed — say what they did, not whether it was good.
6. Do NOT invent or reference sporting/regulatory context: no claims about the points system, parc fermé rules, tyre allocation regulations, or what a team "should" have done under the rules. None of that is in the data.
7. If a driver has no pit stops in the data, do not guess why (strategy call vs. no need vs. missing data) — just note the fact if it's notable.
8. Every driver you name must appear in the data under that exact name. Do not shorten, nickname or otherwise alter a driver's name."""

_FORMAT = """FORMAT — return GitHub-flavoured Markdown:
- 2-3 short paragraphs, 150-240 words total.
- Use **bold** for driver names on first mention only.
- No headings, no bullet lists, no tables. Flowing prose only."""

SYSTEM_PROMPT = f"""You are a Formula 1 strategy analyst. You will be given a JSON bundle of verified, pre-computed facts about one finished race's tyre stints and pit stops. Write an accurate, engaging paragraph or two narrating the strategic story of the race.

{_ABSOLUTE_RULES}

{_FORMAT}

WHAT TO COVER, in priority order:
1. Any undercut or overcut in `undercut_overcut_events` that changed the order between two drivers — name both drivers, which one pitted first, and who came out ahead.
2. Any driver in `strategy_outliers` who ran a notably different number of stops than most of the field.
3. The overall shape of the race's strategy — how many stops most drivers made, and which compounds were common — using `stints` and `field_common_stops`. Keep this brief; it's context for the events above, not a lap-by-lap account.

If `undercut_overcut_events` is empty, that is fine — just skip that beat and lead with strategy_outliers or the overall stint picture instead. Never claim an undercut or overcut happened if the list is empty.
"""


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _stints_by_number(stints: list[dict]) -> dict[str, list[dict]]:
    """Each driver's stint sequence, sorted by stint number."""
    by_number: dict[str, list[dict]] = {}
    for stint in stints:
        number = str(stint.get("driver_number") or "").strip()
        if not number:
            continue
        by_number.setdefault(number, []).append(stint)
    for group in by_number.values():
        group.sort(key=lambda s: _as_int(s.get("stint_number")) or 0)
    return by_number


def _stint_facts(directory: dict[str, dict], stints_by_number: dict[str, list[dict]]) -> list[dict]:
    """One entry per driver: their name/team plus their stint-by-stint sequence."""
    facts = []
    for number, stints in stints_by_number.items():
        entry = directory.get(number) or {}
        sequence = []
        for stint in stints:
            lap_start, lap_end = stint.get("lap_start"), stint.get("lap_end")
            length = (
                (lap_end - lap_start + 1)
                if lap_start is not None and lap_end is not None
                else None
            )
            sequence.append({
                "stint_number": stint.get("stint_number"),
                "compound": stint.get("compound"),
                "lap_start": lap_start,
                "lap_end": lap_end,
                "length": length,
            })
        facts.append({
            "driver": entry.get("name") or number,
            "team": entry.get("team"),
            "stops": max(len(sequence) - 1, 0),
            "stints": sequence,
        })
    facts.sort(key=lambda f: f["driver"])
    return facts


def _strategy_outliers(stint_facts: list[dict]) -> list[dict]:
    """Drivers whose stop count differs from the field's most common one.

    Computed here rather than left to the model: "1-stop against a field that
    mostly ran 2" is a comparison across the whole field, which is exactly the
    kind of unranked comparison a model will get subtly wrong (or ban itself
    from making, per session_recap.py's own hallucination history).
    """
    stop_counts = [f["stops"] for f in stint_facts if f["stints"]]
    if not stop_counts:
        return []
    common_count, _ = Counter(stop_counts).most_common(1)[0]
    return [
        {
            "driver": f["driver"],
            "team": f["team"],
            "stops": f["stops"],
            "field_common_stops": common_count,
        }
        for f in stint_facts
        if f["stints"] and f["stops"] != common_count
    ]


def _laps_index(laps: list[dict]) -> dict[tuple[str, int], dict]:
    """(driver_number, lap_number) -> that row, for O(1) position lookups."""
    index: dict[tuple[str, int], dict] = {}
    for row in laps:
        number = str(row.get("driver_number") or "").strip()
        lap = _as_int(row.get("lap_number"))
        if not number or lap is None:
            continue
        index[(number, lap)] = row
    return index


def _position_at(laps_index: dict[tuple[str, int], dict], number: str, lap: int) -> int | None:
    return _as_int((laps_index.get((number, lap)) or {}).get("position"))


def _driver_stops_by_number(stops: list[dict], number_by_id: dict[str, str]) -> list[dict]:
    """Pit stops reshaped onto car number, sorted by lap.

    Mirrors `race_replay._stops_by_lap`'s join but keeps one row per stop
    (rather than keying by lap) since this needs to compare *pairs* of stops
    across different drivers, not look one up by lap.
    """
    resolved = []
    for stop in stops:
        number = number_by_id.get(stop.get("driver_id"))
        lap = _as_int(stop.get("lap"))
        if not number or lap is None:
            continue
        resolved.append({"number": number, "lap": lap, "stop_number": stop.get("stop")})
    resolved.sort(key=lambda s: (s["lap"], s["number"]))
    return resolved


def _undercut_overcut_events(
    driver_stops: list[dict], laps_index: dict[tuple[str, int], dict], directory: dict[str, dict]
) -> list[dict]:
    """Every pit-stop pair within `_WINDOW_LAPS` of each other whose track-position
    order flipped between "just before the earlier stop" and "a few laps after
    the later stop" — the two moments that isolate the pit window's effect from
    the rest of the race.

    A flip in favour of the driver who pitted earlier is an undercut (fresh
    tyres let them jump the still-out car); a flip in favour of the driver who
    pitted later is an overcut (staying out worked out for them). No flip means
    the stops aren't reported as either — most pit-stop pairs don't produce one,
    and the prompt is instructed not to claim an outcome that isn't in this list.
    """
    events = []
    for i, earlier in enumerate(driver_stops):
        for later in driver_stops[i + 1:]:
            if later["number"] == earlier["number"]:
                continue
            gap = later["lap"] - earlier["lap"]
            if gap <= 0 or gap > _WINDOW_LAPS:
                continue

            before_lap = earlier["lap"] - 1
            after_lap = later["lap"] + _SETTLE_LAPS

            pos_e_before = _position_at(laps_index, earlier["number"], before_lap)
            pos_l_before = _position_at(laps_index, later["number"], before_lap)
            pos_e_after = _position_at(laps_index, earlier["number"], after_lap)
            pos_l_after = _position_at(laps_index, later["number"], after_lap)
            if None in (pos_e_before, pos_l_before, pos_e_after, pos_l_after):
                continue
            if pos_e_before == pos_l_before or pos_e_after == pos_l_after:
                continue

            earlier_ahead_before = pos_e_before < pos_l_before
            earlier_ahead_after = pos_e_after < pos_l_after
            if earlier_ahead_before == earlier_ahead_after:
                continue  # order didn't flip -- nothing attributable to the pit window

            outcome = "undercut" if earlier_ahead_after else "overcut"
            gainer, loser = (
                (earlier["number"], later["number"])
                if outcome == "undercut"
                else (later["number"], earlier["number"])
            )

            def _name(number: str) -> str:
                return (directory.get(number) or {}).get("name") or number

            def _team(number: str) -> str | None:
                return (directory.get(number) or {}).get("team")

            events.append({
                "outcome": outcome,
                "earlier_stop": {
                    "driver": _name(earlier["number"]),
                    "team": _team(earlier["number"]),
                    "lap": earlier["lap"],
                },
                "later_stop": {
                    "driver": _name(later["number"]),
                    "team": _team(later["number"]),
                    "lap": later["lap"],
                },
                "gap_laps": gap,
                "gainer": _name(gainer),
                "loser": _name(loser),
                "position_before_pit_window": {
                    _name(earlier["number"]): pos_e_before,
                    _name(later["number"]): pos_l_before,
                },
                "position_after_pit_window": {
                    _name(earlier["number"]): pos_e_after,
                    _name(later["number"]): pos_l_after,
                },
            })

    return events


def build_facts(
    race: dict,
    results: list[dict],
    stints: list[dict],
    stops: list[dict],
    laps: list[dict],
) -> dict:
    """The full pre-computed fact bundle handed to the model.

    Every relational judgement (undercut/overcut, "ran an unusual strategy")
    is already resolved by the time this returns — the model's job is
    reduced to narrating already-true statements, per this module's docstring.
    """
    directory = _driver_directory(results)
    number_by_id = _number_by_driver_id(directory)

    stints_by_number = _stints_by_number(stints)
    stint_facts = _stint_facts(directory, stints_by_number)
    strategy_outliers = _strategy_outliers(stint_facts)

    laps_index = _laps_index(laps)
    driver_stops = _driver_stops_by_number(stops, number_by_id)
    undercut_overcut_events = _undercut_overcut_events(driver_stops, laps_index, directory)

    compound_counts = Counter(
        stint["compound"]
        for f in stint_facts
        for stint in f["stints"]
        if stint.get("compound") and stint["compound"] != "UNKNOWN"
    )
    stop_counts = [f["stops"] for f in stint_facts if f["stints"]]
    field_common_stops = Counter(stop_counts).most_common(1)[0][0] if stop_counts else None

    return {
        "race_name": race.get("raceName"),
        "season": race.get("season"),
        "round": race.get("round"),
        "circuit": (race.get("Circuit") or {}).get("circuitName"),
        "field_size": len(stint_facts),
        "field_common_stops": field_common_stops,
        "compound_usage": dict(compound_counts),
        "stints": stint_facts,
        "strategy_outliers": strategy_outliers,
        "undercut_overcut_events": undercut_overcut_events,
    }


async def _generate_commentary(facts: dict):
    """Stream strategy commentary text from Ollama Cloud, yielding content deltas.

    Copied near-verbatim from `session_recap._generate_recap` — every
    recap-style endpoint in this codebase owns its own copy of this call
    rather than sharing one, per this app's established pattern. Yields
    nothing if `OLLAMA_API_KEY` is unset or the call fails; the endpoint
    treats an empty result as "no commentary available", not an error.
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
        # variance is exactly what produces confabulated relational claims.
        "options": {"temperature": 0.2},
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream(
                "POST", f"{OLLAMA_BASE}/api/chat", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    print(f"Ollama strategy commentary call failed: HTTP {response.status_code}")
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
        print(f"Ollama strategy commentary call failed: {error}")
        return


@router.get("/strategy_commentary")
async def get_strategy_commentary(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round: int = Query(..., description="Round number within the season"),
):
    """Stream a Markdown strategy commentary, cached forever after first generation.

    Reads only `race_results`, `race_stints`, `pit_stops` and `race_laps` as
    they're already cached -- no FastF1/Ergast calls and no self-heal rebuild
    happen here. If any of the collections this needs a stint/lap picture from
    are empty, this reports "no commentary available" rather than triggering
    a sync, matching every other Pitwall module's fail-soft posture.
    """
    async def empty():
        return
        yield  # pragma: no cover - makes this an async generator

    db = get_db()
    cache_key = {
        "season": year,
        "round": str(round),
        "prompt_version": PROMPT_VERSION,
    }

    cached = await db.strategy_commentary.find_one(cache_key, {"_id": 0})

    async def replay_cached():
        yield cached["text"]

    if cached and cached.get("text"):
        return StreamingResponse(replay_cached(), media_type="text/plain")

    results_doc = await db.race_results.find_one(
        {"season": year, "round": str(round)}, {"_id": 0}
    )
    stints_doc = await db.race_stints.find_one(
        {"season": year, "round": str(round)}, {"_id": 0}
    )
    laps_doc = await db.race_laps.find_one(
        {"season": year, "round": str(round)}, {"_id": 0}
    )
    stops_doc = await db.pit_stops.find_one(
        {"season": year, "round": str(round)}, {"_id": 0}
    )

    results = (results_doc or {}).get("results") or []
    stints = (stints_doc or {}).get("stints") or []
    laps = (laps_doc or {}).get("laps") or []
    stops = (stops_doc or {}).get("stops") or []

    # Stints and per-lap position are the two sources every fact in this
    # module is built from; without both there is no strategy story to tell.
    # Pit stops alone being empty is not fatal -- a race with no stops at all
    # is unusual but the stint/outlier picture is still tellable -- so it's
    # not part of this guard.
    if not results or not stints or not laps:
        return StreamingResponse(empty(), media_type="text/plain")

    race = (results_doc or {}).get("race", {})
    facts = build_facts(race, results, stints, stops, laps)

    async def generate_and_cache():
        parts: list[str] = []
        async for chunk in _generate_commentary(facts):
            parts.append(chunk)
            yield chunk
        full_text = "".join(parts).strip()

        if not full_text:
            return

        try:
            await db.strategy_commentary.update_one(
                cache_key, {"$set": {**cache_key, "text": full_text}}, upsert=True
            )
        except Exception as error:
            print(
                f"Failed to cache strategy_commentary for {year} R{round}: {error}"
            )

    return StreamingResponse(generate_and_cache(), media_type="text/plain")
