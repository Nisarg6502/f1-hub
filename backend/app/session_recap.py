"""'Explain this session' recap: an LLM-generated summary grounded strictly in
this app's own cached data plus OpenF1 race control.

Covers Race, Qualifying and Sprint. Each session type gets its **own** fact
bundle and its own system prompt, because a qualifying recap is not a short
race recap: qualifying has no gaps-to-leader, no retirements and no points,
but it does have three timed segments with an elimination at each boundary,
a pole margin, and lap deletions that are a genuine part of the story rather
than trivia. Sprint is race-shaped and shares the race fact builder.

**Everything the model could get wrong by doing arithmetic or inference is
computed here instead.** The first version of this endpoint handed the model
a bare classification list and let it find "the story" itself, and it
hallucinated a teammate relationship between two drivers on visibly
different teams (Verstappen/Red Bull and Antonelli/Mercedes, 2026 Hungarian
GP). The lesson generalized: an LLM asked to *derive* relational facts will
confabulate them even when the underlying fields are correct and present. So
`build_facts` now pre-computes teammate pairings, positions gained/lost, the
podium, the closest gap, and retirements — the model's job is reduced to
narrating already-true statements rather than inferring which are true. The
qualifying bundle applies the same rule to its own derived facts: segment
eliminations, cutoff margins, pole margin, session-long improvements and
teammate head-to-heads are all resolved in Python, never left to the model.

Generated once per session and cached forever in `session_recap` — a finished
session's facts never change. The cache key includes both the session and
`PROMPT_VERSION`, so bumping the latter when a prompt or fact-bundle shape
changes retires every stale recap without needing a manual purge.
"""

import asyncio
import json
import os
import re

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
#
# 3: race-control distillation was corrected while adding Qualifying/Sprint —
#    multi-car incidents now resolve to driver names instead of dropping them,
#    and safety-car *infringements* are no longer reported as safety-car
#    periods. The Race prompt text is unchanged, but its facts are better, so
#    existing race recaps are retired rather than left standing on the old
#    bundle.
# 4: the qualifying prompt's rule 14 was hardened after live testing showed
#    the model calling an eliminated driver's gap_to_cutoff "the closest
#    margin of the segment" — an unranked comparison the data never supports
#    (see the module docstring's post-mortem pattern). Race/Sprint prompts
#    are unchanged; bumped anyway since the version is shared.
# 5: banned qualifying race-vocabulary moved from prompt-only to a Python
#    validator with one retry (SESSION_VALIDATORS) — v4 still shipped a recap
#    saying a driver "completed the podium in third". v4 rows exist and are
#    retired by this bump.
# 6: v5's rule 14 over-corrected — forbidding comparisons pushed the model
#    into reciting every driver's time and gap in turn, blowing the word
#    limit and reading like the classification table it sits above. Rule 16
#    ("select, do not enumerate") restores prose without loosening 14.
PROMPT_VERSION = 6

# The eight rules below are shared verbatim by every session type. They are the
# distilled output of CP38's hallucination post-mortem — each one names a
# failure class actually observed in testing — so a new session prompt inherits
# them rather than paraphrasing and quietly dropping one.
_ABSOLUTE_RULES = """ABSOLUTE RULES — violating these makes the recap worthless:
1. Use ONLY facts present in the JSON. Never add drivers, teams, incidents, weather, tyre strategies, or championship context that is not in the data.
2. NEVER state or imply that two drivers are teammates unless they appear together in the `teammates` array. Do not infer team relationships from anything else.
3. Do not perform arithmetic. Gaps, positions gained/lost, and counts are already computed — quote them as given.
4. If the data does not explain WHY something happened, do not speculate. Say what happened, not why.
5. Do NOT explain, invoke, or infer F1 sporting regulations — no claims about points systems, bonus points for fastest lap, award eligibility, or what a penalty's consequence was. The `points` field is the authoritative points value; never justify it.
6. Do NOT claim that any event did or did not affect the final order, the outcome, or a driver's race unless the data explicitly says so. Omit such judgements entirely.
7. Do NOT apply descriptive labels to drivers or cars ("front-running", "midfield", "title contender", "veteran") unless the grid/position data plainly supports it. When in doubt, just name them.
8. Every factual claim must carry a citation marker (see below)."""

_RACE_LIKE_CITATIONS = """CITATIONS — attach one to each factual claim, inline, in square brackets:
- Classification facts: `[P3]` — the finishing position the fact came from.
- Fastest lap: `[FL]`
- A race-control event: `[RC L66]` — RC plus the lap number (omit the lap if null: `[RC]`).
- Positions gained/lost: `[P7, grid 12]`
Example: `Norris won by 15.080s [P1], holding off Verstappen [P2].`"""

_FORMAT = """FORMAT — return GitHub-flavoured Markdown:
- {paragraphs}
- Use **bold** for driver names on first mention only.
- No headings, no bullet lists, no tables. Flowing prose only."""

SYSTEM_PROMPT = f"""You are a Formula 1 race recap writer. You will be given a JSON bundle of verified facts about one race. Write an accurate, engaging recap.

{_ABSOLUTE_RULES}

{_RACE_LIKE_CITATIONS}

{_FORMAT.format(paragraphs="3-4 short paragraphs, 180-280 words total.")}

WHAT TO COVER, in priority order:
1. The winner, the margin, and who completed the podium.
2. Any penalties or stewards' decisions in `race_control.events` — these are often the real story and must not be omitted if present.
3. Safety car / VSC periods if present.
4. The standout drive from `biggest_movers`, and any notable retirements.
5. The fastest lap.
"""

# The sprint shares the race fact bundle (it is a classified, points-scoring
# race) but not its prompt: it is a standalone result, not the Grand Prix, and
# the model must never present it as one or connect it to Sunday.
SPRINT_SYSTEM_PROMPT = f"""You are a Formula 1 sprint recap writer. You will be given a JSON bundle of verified facts about one Sprint — the short Saturday race, NOT the Grand Prix. Write an accurate, engaging recap.

{_ABSOLUTE_RULES}
9. This is the Sprint only. Never refer to it as "the race", "the Grand Prix", or "Sunday", and never mention, predict or imply anything about the Grand Prix that follows it — that result is not in this data.
10. The sprint grid comes from a separate Sprint Qualifying session that is NOT in this data. Report `grid` values as given; never describe how a driver earned that grid slot.
11. Do not compare this sprint to any other sprint, race or season. There is no comparative data here.
12. The fastest lap is a timing fact and nothing more. Never call it an award, accolade, bonus, honour or point.
13. When you report a race-control event, use the reason exactly as the `message` gives it. Do not re-word, shorten or interpret it, and never merge two events into one claim.

{_RACE_LIKE_CITATIONS}

{_FORMAT.format(paragraphs="2-3 short paragraphs, 140-220 words total — this is a short race and the recap should be short too.")}

WHAT TO COVER, in priority order:
1. The winner, the margin, and who completed the top three.
2. Any penalties or stewards' decisions in `race_control.events`, and safety car / VSC periods — over a sprint distance these dominate the session and must not be omitted if present.
3. The standout drive from `biggest_movers`, and any retirements.
"""

QUALIFYING_SYSTEM_PROMPT = f"""You are a Formula 1 qualifying recap writer. You will be given a JSON bundle of verified facts about one qualifying session. Write an accurate, engaging recap.

Qualifying runs in three timed segments. Q1 eliminates the slowest runners, Q2 eliminates the next group, and the survivors contest Q3 for pole. Every driver's segment outcome has already been resolved for you in `q3`, `q2_eliminated`, `q1_eliminated` and `no_time_set` — read them, never infer them from lap times.

QUALIFYING IS NOT A RACE. Nobody wins it, nobody finishes it, there is no podium and no points. These words are BANNED from your output: "podium", "won", "winner", "victory", "finished", "race", "grid", "points". Say "took pole", "qualified second", "qualified third", "was eliminated in Q2".

{_ABSOLUTE_RULES}
9. A driver's segment outcome is ONLY what the arrays say. Never state that someone "was knocked out in Q2" unless they appear in `q2_eliminated`, or that someone "reached Q3" unless they appear in `q3`.
10. This session decides qualifying order, NOT the starting grid. Grid penalties and post-session decisions are not in this data — never state, imply or predict where anyone will start the race, and never mention the race at all.
11. Never speculate about why a lap was slow or fast: no tyre compounds, fuel loads, track evolution, traffic, engine modes or setup. None of that is in the data.
12. `track_limit_deletions` counts deleted laps per driver. Report the count as a fact. Do NOT claim a deletion cost anyone a position or a segment — that judgement is not in the data.
13. There is no podium, no win and no points in qualifying. Never use those words. Drivers qualify first, second, third — they do not "finish" or "complete the podium".
14. Do NOT rank or compare facts the data has not already ranked. `q2_eliminated`/`q1_eliminated`/`gap_to_cutoff` are lists of individually-true numbers, NOT sorted or compared against each other — quote a `gap_to_cutoff` value as a fact about that one driver only. Banned superlatives about anything except `biggest_improvements` (the only pre-ranked list): "smallest", "closest", "narrowest", "tightest", "biggest surprise", "of the segment/session". If you want to say a gap was small, quote the number and stop there — do not compare it to any other driver's gap.
16. SELECT, do not enumerate. You are writing prose, not a results table. Do NOT walk the field driver-by-driver reciting each time and gap — that is what the classification table below the recap is for. Name the drivers whose story matters (pole, the top few, the narrowest eliminations, anyone in `biggest_improvements`) and leave the rest out entirely. Rule 14 forbids *comparing* gaps; it does not require you to list every one of them.
15. When you report a race-control event, use the reason exactly as the `message` gives it. Do not re-word, shorten or interpret it.

CITATIONS — attach one to each factual claim, inline, in square brackets:
- A classification position: `[P1]`, `[P16]`.
- A segment time or elimination: `[Q3 P4]`, `[Q1 P18]` — the segment plus that driver's overall position.
- A race-control event or lap deletion: `[RC]`.
Example: `**Norris** took pole with a 1:17.207 [Q3 P1], 0.291s clear of **Verstappen** [Q3 P2].`
Attach at most ONE citation per claim. Never chain them (`[Q3 P4][Q3 P5][Q3 P6]`) — cite the row the sentence is actually about.

{_FORMAT.format(paragraphs="2-3 short paragraphs, 150-230 words total. The word limit is a hard ceiling — if you are running long you are enumerating instead of selecting (rule 16).")}

WHAT TO COVER, in priority order:
1. Pole position: who, the time, and the margin from `pole.margin_to_second`.
2. The rest of the Q3 order and any notably close gaps.
3. The Q2 and Q1 eliminations. You may note an individual driver's `gap_to_cutoff` as a fact about them, but never compare one eliminated driver's margin to another's.
4. Lap deletions and any stewards' events in `race_control`.
5. A standout entry from `biggest_improvements` or `teammate_battles`, if one is striking.
"""

SESSION_PROMPTS = {
    "race": SYSTEM_PROMPT,
    "sprint": SPRINT_SYSTEM_PROMPT,
    "qualifying": QUALIFYING_SYSTEM_PROMPT,
}

# Which cached collection backs each session type. Every one of these documents
# has the same `{race, results}` shape (see `session_results.py`).
SESSION_COLLECTIONS = {
    "race": "race_results",
    "qualifying": "qualifying_results",
    "sprint": "sprint_results",
}

# OpenF1's `session_name` for each, used to pull the right race-control log.
SESSION_OPENF1_NAMES = {
    "race": "Race",
    "qualifying": "Qualifying",
    "sprint": "Sprint",
}


def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def fetch_race_control(race_date: str, session_name: str = "Race") -> list[dict]:
    """Race-control messages for one session of the race weekend on `race_date`.

    Only the Grand Prix's own date is known here — every cached results
    document carries the *race* date, even the qualifying one — so the weekend
    is located by its Race session and the requested session is then found by
    `meeting_key` within that weekend. Matching qualifying by date directly
    would fail: it runs the day before.

    Returns [] on any failure — race control is enrichment, not a hard
    dependency, and a recap without it is still worth generating. Note this
    used to be impossible for the current season (OpenF1 paywalled it behind
    a 401) but is reachable again as of 2026-07.
    """
    if not race_date:
        return []

    sessions = _fetch_json(f"{OPENF1_BASE}/sessions", {"year": race_date[:4]})
    if not isinstance(sessions, list):
        return []

    race_session = next(
        (
            s
            for s in sessions
            if s.get("session_name") == "Race"
            and str(s.get("date_start", "")).startswith(race_date)
        ),
        None,
    )
    if not race_session:
        return []

    if session_name == "Race":
        session = race_session
    else:
        session = next(
            (
                s
                for s in sessions
                if s.get("meeting_key") == race_session.get("meeting_key")
                and s.get("session_name") == session_name
            ),
            None,
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
    """Race fact bundle. Shared unchanged by the Sprint, which is race-shaped.

    Deliberately left byte-identical to the shape CP38 shipped: the Race
    recap's cached rows stay valid, so `PROMPT_VERSION` did not need bumping
    when Qualifying and Sprint were added.
    """
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


# ------------------------------- qualifying -------------------------------
#
# Qualifying results carry no grid, status, points or gap-to-leader — only
# `position` and whichever of `Q1`/`Q2`/`Q3` the driver set a time in. Every
# fact below is derived from those two things in Python, for the same reason
# the race bundle pre-computes its own: a model handed a list of lap times and
# asked who "got knocked out in Q2" will answer confidently and sometimes
# wrongly.

_SEGMENTS = ("Q1", "Q2", "Q3")


def _lap_seconds(value) -> float | None:
    """`'1:17.207'` or `'58.212'` -> seconds. None for blanks and junk."""
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


def _delta(faster: float | None, slower: float | None) -> str | None:
    """A pre-formatted gap string, so the model never subtracts two times."""
    if faster is None or slower is None:
        return None
    return f"{slower - faster:.3f}s"


def _segment_times(entry: dict) -> dict[str, float | None]:
    return {segment: _lap_seconds(entry.get(segment)) for segment in _SEGMENTS}


def _final_segment(times: dict[str, float | None]) -> str | None:
    """The last segment this driver actually set a time in."""
    reached = [segment for segment in _SEGMENTS if times.get(segment) is not None]
    return reached[-1] if reached else None


def _qualifying_rows(results: list[dict]) -> list[dict]:
    """One normalised row per entry, with its segment times already parsed."""
    rows = []
    for r in results:
        times = _segment_times(r)
        rows.append({
            "position": r.get("position"),
            "position_number": _as_int(r.get("position")),
            "driver": _driver_name(r),
            "team": (r.get("Constructor") or {}).get("name"),
            "raw": {segment: r.get(segment) or None for segment in _SEGMENTS},
            "seconds": times,
            "final_segment": _final_segment(times),
        })
    rows.sort(key=lambda row: (row["position_number"] is None, row["position_number"] or 0))
    return rows


def _cutoff(rows: list[dict], segment: str, advanced_to: str) -> float | None:
    """The slowest `segment` time among drivers who reached `advanced_to`.

    That is the line an eliminated driver had to beat, so `gap_to_cutoff`
    below is a real "missed it by" number rather than a gap to the leader.
    """
    times = [
        row["seconds"][segment]
        for row in rows
        if row["seconds"].get(advanced_to) is not None
        and row["seconds"].get(segment) is not None
    ]
    return max(times) if times else None


def _eliminated_in(rows: list[dict], segment: str, advanced_to: str) -> list[dict]:
    cutoff = _cutoff(rows, segment, advanced_to)
    return [
        {
            "position": row["position"],
            "driver": row["driver"],
            "team": row["team"],
            "segment": segment,
            "time": row["raw"][segment],
            "gap_to_cutoff": _delta(cutoff, row["seconds"][segment]),
        }
        for row in rows
        if row["final_segment"] == segment
    ]


def _pole_facts(rows: list[dict]) -> dict | None:
    q3 = [row for row in rows if row["seconds"].get("Q3") is not None]
    if not q3:
        return None
    leader = q3[0]
    second = q3[1] if len(q3) > 1 else None
    return {
        "driver": leader["driver"],
        "team": leader["team"],
        "time": leader["raw"]["Q3"],
        "margin_to_second": (
            _delta(leader["seconds"]["Q3"], second["seconds"]["Q3"]) if second else None
        ),
        "second_place_driver": second["driver"] if second else None,
    }


def _q3_order(rows: list[dict]) -> list[dict]:
    q3 = [row for row in rows if row["seconds"].get("Q3") is not None]
    pole_time = q3[0]["seconds"]["Q3"] if q3 else None
    return [
        {
            "position": row["position"],
            "driver": row["driver"],
            "team": row["team"],
            "time": row["raw"]["Q3"],
            # None for the pole-sitter rather than "0.000s", which reads as a
            # gap and invites the model to narrate one.
            "gap_to_pole": (
                _delta(pole_time, row["seconds"]["Q3"]) if index else None
            ),
        }
        for index, row in enumerate(q3)
    ]


def _biggest_improvements(rows: list[dict], limit: int = 3) -> list[dict]:
    """How much time each driver found between Q1 and their final segment."""
    improvements = []
    for row in rows:
        first, final = row["seconds"].get("Q1"), row["final_segment"]
        if first is None or final in (None, "Q1"):
            continue
        last = row["seconds"][final]
        if last is None or last >= first:
            continue
        improvements.append({
            "driver": row["driver"],
            "team": row["team"],
            "from_segment": "Q1",
            "to_segment": final,
            "from_time": row["raw"]["Q1"],
            "to_time": row["raw"][final],
            "improvement": _delta(last, first),
            "_seconds": first - last,
        })
    improvements.sort(key=lambda i: -i["_seconds"])
    return [{k: v for k, v in i.items() if k != "_seconds"} for i in improvements[:limit]]


def _teammate_battles(rows: list[dict]) -> list[dict]:
    """Who out-qualified whom within each team, and by how much.

    The margin is taken from the last segment *both* drivers set a time in —
    comparing one driver's Q3 to the other's Q1 would be meaningless, and is
    exactly the kind of comparison a model would happily make.
    """
    by_team: dict[str, list[dict]] = {}
    for row in rows:
        if row["team"]:
            by_team.setdefault(row["team"], []).append(row)

    battles = []
    for team, drivers in by_team.items():
        if len(drivers) != 2:
            continue
        ahead, behind = drivers[0], drivers[1]
        common = [
            segment
            for segment in _SEGMENTS
            if ahead["seconds"].get(segment) is not None
            and behind["seconds"].get(segment) is not None
        ]
        segment = common[-1] if common else None
        battles.append({
            "team": team,
            "ahead": ahead["driver"],
            "ahead_position": ahead["position"],
            "behind": behind["driver"],
            "behind_position": behind["position"],
            "compared_segment": segment,
            "margin": (
                _delta(ahead["seconds"][segment], behind["seconds"][segment])
                if segment
                else None
            ),
        })
    return battles


def build_qualifying_facts(
    race: dict, results: list[dict], race_control_messages: list[dict]
) -> dict:
    rows = _qualifying_rows(results)

    return {
        "session": "qualifying",
        "race_name": race.get("raceName"),
        "season": race.get("season"),
        "round": race.get("round"),
        "circuit": (race.get("Circuit") or {}).get("circuitName"),
        "total_entries": len(rows),
        "pole": _pole_facts(rows),
        "q3": _q3_order(rows),
        "q2_eliminated": _eliminated_in(rows, "Q2", "Q3"),
        "q1_eliminated": _eliminated_in(rows, "Q1", "Q2"),
        "no_time_set": [
            {"position": row["position"], "driver": row["driver"], "team": row["team"]}
            for row in rows
            if row["final_segment"] is None
        ],
        "teammates": _teammates(results),
        "teammate_battles": _teammate_battles(rows),
        "biggest_improvements": _biggest_improvements(rows),
        # Every deletion counts in qualifying: a single scrubbed lap is a real
        # part of the session's story, unlike in a race where only a repeated
        # offender is worth a line.
        "race_control": summarize_race_control(
            race_control_messages, results, min_deletions=1
        ),
    }


SESSION_FACT_BUILDERS = {
    "race": build_facts,
    "sprint": build_facts,
    "qualifying": build_qualifying_facts,
}


# Race-vocabulary the qualifying recap must never use. Stating this in the
# prompt — twice, including an ALL-CAPS block — was not enough: the model still
# wrote "completed the podium in third". That is the same lesson CP38 learned
# about teammates, applied to vocabulary: a rule the model must *remember* to
# follow while writing is a rule it will sometimes break, so it gets enforced
# in Python instead of trusted to the prompt.
#
# Word-boundary anchored so "unfinished" and "Grand Prix" don't false-positive.
# "race"/"grid"/"points" are excluded deliberately — they appear legitimately
# in race-control message text the recap is required to quote verbatim.
_QUALIFYING_BANNED_RE = re.compile(
    r"\b(?:podium|won|winner|victory|victorious)\b", re.I
)


def _qualifying_violations(text: str) -> list[str]:
    return sorted({m.lower() for m in _QUALIFYING_BANNED_RE.findall(text or "")})


SESSION_VALIDATORS = {"qualifying": _qualifying_violations}


async def _generate_recap(facts: dict, system_prompt: str = SYSTEM_PROMPT):
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
            {"role": "system", "content": system_prompt},
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
    session: str = Query("race", description="race, qualifying or sprint"),
):
    """Stream a Markdown session recap, cached forever after first generation.

    `session` defaults to `race` so the endpoint stays backward-compatible
    with callers that predate Qualifying/Sprint support.
    """
    session_key = (session or "race").strip().lower()

    async def empty():
        return
        yield  # pragma: no cover - makes this an async generator

    if session_key not in SESSION_COLLECTIONS:
        return StreamingResponse(empty(), media_type="text/plain")

    db = get_db()
    cache_key = {
        "season": year,
        "round": str(round),
        "session": session_key,
        "prompt_version": PROMPT_VERSION,
    }

    cached = await db.session_recap.find_one(cache_key, {"_id": 0})

    async def replay_cached():
        yield cached["text"]

    if cached and cached.get("text"):
        return StreamingResponse(replay_cached(), media_type="text/plain")

    collection = db[SESSION_COLLECTIONS[session_key]]
    doc = await collection.find_one({"season": year, "round": str(round)}, {"_id": 0})
    results = (doc or {}).get("results") or []

    if not results:
        return StreamingResponse(empty(), media_type="text/plain")

    race = (doc or {}).get("race", {})
    messages = await asyncio.to_thread(
        fetch_race_control, race.get("date", ""), SESSION_OPENF1_NAMES[session_key]
    )
    facts = SESSION_FACT_BUILDERS[session_key](race, results, messages)
    system_prompt = SESSION_PROMPTS[session_key]

    validator = SESSION_VALIDATORS.get(session_key)

    async def collect(prompt: str) -> str:
        return "".join([chunk async for chunk in _generate_recap(facts, prompt)]).strip()

    async def generate_and_cache():
        if validator:
            # Buffered rather than streamed token-by-token: the text has to be
            # complete before it can be checked, and a violation must not have
            # already reached the reader. Only the first viewer of a given
            # session pays this — every one after replays from cache — which is
            # the same trade the 120b model was chosen under.
            full_text = await collect(system_prompt)
            violations = validator(full_text)
            if violations and full_text:
                print(
                    f"Qualifying recap for {year} R{round} used banned race "
                    f"vocabulary {violations}; regenerating once."
                )
                retry_prompt = (
                    f"{system_prompt}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED for "
                    f"using these forbidden words: {', '.join(violations)}. "
                    f"They are banned because this is qualifying, not a race. "
                    f"Rewrite without them and without any synonym for winning."
                )
                retried = await collect(retry_prompt)
                # Kept even if it still fails: a second violation is rare, and
                # a wrong word beats no recap at all.
                full_text = retried or full_text
            if full_text:
                yield full_text
        else:
            parts: list[str] = []
            async for chunk in _generate_recap(facts, system_prompt):
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
            print(
                f"Failed to cache session_recap for {year} R{round} "
                f"({session_key}): {error}"
            )

    return StreamingResponse(generate_and_cache(), media_type="text/plain")
