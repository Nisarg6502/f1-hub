""""Catch me up": what happened between a returning visitor's last visit and now.

A visitor who has missed a race or two should be able to catch up in ten
seconds. The home page works out, client-side, which round the visitor last
saw (`after_round`, from the schedule and a timestamp in `localStorage`), and
this endpoint answers with everything that has been classified since.

**Facts first, narrative second.** The response is built in two layers, and
only the first one is load-bearing:

1. Deterministic facts, computed here in Python from the cached
   `race_results` / `sprint_results` documents: each missed round's podium
   (and its sprint's), the championship leader then and now, the title gap
   then and now, the biggest movers in the drivers' standings, and the few
   notable facts that fall cleanly out of the data (a first career Grand Prix
   win, the leader failing to finish). These always render.
2. An optional 2-3 sentence narrative written by the same model and client
   `session_recap.py` uses, from those facts alone. It is progressive
   enhancement: absent when Ollama is unconfigured, down, slow, or when what it
   wrote fails the grounding check below.

**Standings "then" are rebuilt, not remembered.** Mongo holds one standings
document per season, the current one, so "the gap after round 12" exists
nowhere to be read. It is rebuilt by summing the `points` of every race and
sprint row up to that round. Checked against the stored 2026 standings while
writing this: all 23 drivers' totals agreed after round 17. Ties are ordered by
countback on Grand Prix finishing positions, but a tie at the top is reported
as a tie (`tied: true`) and never resolved into a named leader: the card and
the narrative both say "level on N points" instead.

**Every relational fact is resolved here, never by the model** -- the lesson
`session_recap.py`'s docstring records from CP38, where a model handed correct
raw rows confidently invented a teammate pairing. "Took the lead from", "the
gap grew from X to Y", "first career win" are all decided in Python and handed
over as fields.

**The narrative's numbers are checked against the facts, and a narrative that
fails is dropped, not shipped.** Same deterministic idea as the chat agent's
verifier (`agent/verifier.py`'s number matching) and the regenerate-once loop
of `session_recap.SESSION_VALIDATORS`: every number in the draft, digits or a
spelled-out word, must appear verbatim among the numbers in the fact bundle it
was written from. One retry, told which numbers it invented; if the retry
fails too, the narrative is `null`. `session_recap` keeps a still-failing retry
("a wrong word beats no recap"), but a wrong number in a catch-up summary is a
false statement about the championship, and the facts below it already tell
the story without it. The check cannot see a wrong *name* or a wrong verb; the
prompt carries those rules, and the facts render beside the narrative so a
reader always has the ground truth one line down.

**Caching, per `derived_cache`.** The facts are cheap (a handful of small
Mongo reads, one season each) and are recomputed on every request, so a
revised classification shows up immediately. Only the narrative is cached, in
`catch_up_narrative`, keyed on `(season, after_round, latest_round,
PROMPT_VERSION)` -- bounded, and shared by every visitor who missed the same
span -- and replayed only while the `input_fingerprint` of the facts and the
prompt it was written from still matches. A narrative rejected by the
grounding check is cached as rejected (text `null`) against the same
fingerprint, so a bad span does not re-bill the model on every visit; an empty
answer (Ollama down) is not cached at all, so the next visitor retries.
"""

import asyncio
import json
import re
from collections import Counter

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .derived_cache import input_fingerprint
# The recap module's Ollama client, its row helpers and its definition of a
# classified finisher, reused rather than copied: a fourth copy of the
# streaming call would be one more place for a fix to miss, and
# `_generate_recap` already takes the system prompt as a parameter.
from .session_recap import _FINISHER_STATUSES, _as_int, _driver_name, _generate_recap

router = APIRouter(prefix="/api")

# Part of the narrative cache key, for a deliberate mass regeneration (a change
# to the checks below, say). Changes to the facts and to the prompt text are
# both caught without it: the input fingerprint covers the two of them.
PROMPT_VERSION = 1

# How long a request that asked for the narrative waits for it before
# answering without one. The generation itself keeps running and caches its
# result, so the next visitor who missed the same span gets it from Mongo.
NARRATIVE_WAIT_SECONDS = 45.0

MAX_MOVERS = 3

# Spans longer than this reach the model as a win tally, not a podium per
# round (see `_wins`).
NARRATIVE_PODIUM_ROUNDS = 3

# First season the historical winners index covers. A first-career-win claim
# is only made when every season from here to the one before the current
# season is present in it -- otherwise "no earlier win on record" might just
# mean "no earlier season on record".
FIRST_CHAMPIONSHIP_SEASON = 1950

SYSTEM_PROMPT = """You write the two-to-three sentence summary at the top of a Formula 1 "catch me up" card, for a fan who missed the races listed in the JSON. You will be given a JSON bundle of verified facts. Summarise the most important of them.

ABSOLUTE RULES — violating these makes the summary worthless:
1. Use ONLY facts present in the JSON. Never add drivers, teams, incidents, penalties, weather, strategies or context that is not in it.
2. Every number you write must be copied exactly from the JSON. Do not perform arithmetic: never compute a difference, a total, a margin or a count yourself. The gaps and point totals are already computed.
3. If a leader block has `"tied": true`, the drivers are level on points. Say so, and never name one of them as the leader.
4. Only say the championship lead changed hands if `leader_changed` is true. If `leader_before` is null, the span starts at the beginning of the season: say nothing about the lead changing or staying the same.
5. Do not predict or speculate about future races, the remaining rounds or the eventual champion.
6. If `standings` is null, say nothing about the championship, the leader or the gap.
7. A round whose race `status` is "missing" has no result on file: do not describe it. One whose status is "pending" has not been classified yet: do not describe its race.
8. A sprint is not the Grand Prix. Never call a sprint winner the race winner.
9. Use driver names exactly as given. Do not apply labels ("dominant", "title favourite", "struggling") the data does not state.
10. Only credit a driver with a race win if that race is listed in their `race_wins` entry. Never list every race; use the `wins` counts instead.

FORMAT:
- Plain text, 2-3 sentences, at most 70 words. No markdown, no headings, no lists, no citations.

WHAT TO COVER, in priority order:
1. Who won the missed Grands Prix, from `race_wins` (by count when there are several).
2. The championship picture: whether the lead changed hands, and the title gap then and now.
3. One notable fact from `notable` or `standings.movers`, if one is striking.
"""


# ------------------------------- row helpers -------------------------------


def _round_number(doc: dict) -> int | None:
    return _as_int((doc or {}).get("round"))


def _points(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _clean_number(value: float) -> int | float:
    """`25.0` -> `25`, `12.5` -> `12.5`, so totals read the way the standings
    table prints them and the grounding check compares like with like."""
    return int(value) if float(value).is_integer() else round(value, 1)


def _person(row: dict) -> dict:
    driver = row.get("Driver") or {}
    constructor = row.get("Constructor") or {}
    if not constructor:
        constructors = row.get("Constructors") or []
        constructor = constructors[-1] if constructors else {}
    return {
        "driver_id": driver.get("driverId"),
        "name": _driver_name(row),
        "code": driver.get("code"),
        "team": constructor.get("name"),
        "team_id": constructor.get("constructorId"),
    }


def _sorted_by_position(results: list[dict]) -> list[dict]:
    return sorted(
        results,
        key=lambda r: (_as_int(r.get("position")) is None, _as_int(r.get("position")) or 0),
    )


def _classified_session(results: list[dict]) -> dict:
    podium = [
        {"position": _as_int(r.get("position")), **_person(r)}
        for r in _sorted_by_position(results)
        if (_as_int(r.get("position")) or 99) <= 3
    ]
    winner = podium[0] if podium and podium[0]["position"] == 1 else None
    return {"status": "classified", "winner": winner, "podium": podium}


def _is_finisher(status) -> bool:
    return str(status or "").strip().lower().startswith(_FINISHER_STATUSES)


# -------------------------------- standings --------------------------------


def _sessions(race_by_round: dict[int, list], sprint_by_round: dict[int, list]) -> list[tuple]:
    """Every classified session of the season, in running order.

    `(round, kind, results)`; a sprint weekend's sprint runs before its Grand
    Prix, which is the order points were actually awarded in.
    """
    sessions = []
    for round_number in sorted(set(race_by_round) | set(sprint_by_round)):
        if sprint_by_round.get(round_number):
            sessions.append((round_number, "sprint", sprint_by_round[round_number]))
        if race_by_round.get(round_number):
            sessions.append((round_number, "race", race_by_round[round_number]))
    return sessions


def _standings(sessions: list[tuple]) -> list[dict]:
    """Drivers' standings after `sessions`, rebuilt from their points.

    Ordered by points, then by countback on Grand Prix finishing positions
    (most wins, then most seconds, ...), then by name so the order is total.
    The countback only decides list order: `_leader` refuses to name a leader
    between drivers on equal points.
    """
    points: dict[str, float] = {}
    finishes: dict[str, Counter] = {}
    people: dict[str, dict] = {}
    for _, kind, results in sessions:
        for row in results:
            driver_id = (row.get("Driver") or {}).get("driverId")
            if not driver_id:
                continue
            people[driver_id] = _person(row)
            points[driver_id] = points.get(driver_id, 0.0) + _points(row.get("points"))
            position = _as_int(row.get("position"))
            if kind == "race" and position:
                finishes.setdefault(driver_id, Counter())[position] += 1

    def countback(driver_id: str) -> tuple:
        tally = finishes.get(driver_id) or Counter()
        return tuple(-tally[p] for p in range(1, 31))

    order = sorted(points, key=lambda d: (-points[d], countback(d), people[d]["name"]))
    return [
        {**people[d], "points": _clean_number(points[d]), "position": index + 1}
        for index, d in enumerate(order)
    ]


def _who(entry: dict) -> dict:
    return {k: entry.get(k) for k in ("driver_id", "name", "code", "team", "team_id")}


def _leader(standings: list[dict]) -> dict | None:
    if not standings or standings[0]["points"] <= 0:
        return None
    top = standings[0]["points"]
    leaders = [s for s in standings if s["points"] == top]
    return {
        "drivers": [_who(s) for s in leaders],
        "points": top,
        "tied": len(leaders) > 1,
    }


def _title_gap(standings: list[dict]) -> dict | None:
    if len(standings) < 2 or standings[0]["points"] <= 0:
        return None
    first, second = standings[0], standings[1]
    return {
        "points": _clean_number(first["points"] - second["points"]),
        "leader": _who(first),
        "leader_points": first["points"],
        "second": _who(second),
        "second_points": second["points"],
    }


def _movers(before: list[dict], now: list[dict]) -> list[dict]:
    """The biggest position changes in the drivers' standings across the span.

    Only drivers present at both ends, and only those with points now: below
    the scorers, everyone is level on zero and their order is countback noise,
    not movement. Ranked by size of the move, then by points gained.
    """
    then_by_id = {s["driver_id"]: s for s in before}
    moves = []
    for entry in now:
        previous = then_by_id.get(entry["driver_id"])
        if not previous or entry["points"] <= 0:
            continue
        change = previous["position"] - entry["position"]
        if change == 0:
            continue
        moves.append({
            **_who(entry),
            "from_position": previous["position"],
            "to_position": entry["position"],
            "change": change,
            "points_gained": _clean_number(entry["points"] - previous["points"]),
        })
    moves.sort(key=lambda m: (-abs(m["change"]), -m["points_gained"], m["name"]))
    return moves[:MAX_MOVERS]


def _wins(window_sessions: list[tuple], kind: str, race_names: dict[int, str]) -> list[dict]:
    """Who won the missed Grands Prix (or sprints), tallied per driver.

    Counted here because the first live narrative over a whole season, handed
    sixteen podiums and left to tally them itself, credited Antonelli with two
    of Verstappen's wins and said each of five other drivers "claimed a race"
    when Russell had won three. Every number in it was real, so the grounding
    check passed it; the attribution was invented. Long spans now reach the
    model as this tally instead of a podium per round (`narrative_facts`).
    """
    tally: dict[str, dict] = {}
    for round_number, session_kind, results in window_sessions:
        if session_kind != kind:
            continue
        winner = _classified_session(results)["winner"]
        if not winner:
            continue
        entry = tally.setdefault(winner["driver_id"], {**_who(winner), "wins": 0, "races": []})
        entry["wins"] += 1
        entry["races"].append(race_names.get(round_number))
    return sorted(tally.values(), key=lambda e: (-e["wins"], e["name"]))


def _top_scorer(window_sessions: list[tuple]) -> dict | None:
    """Whoever scored the most points across the missed sessions."""
    gained = _standings(window_sessions)
    if not gained or gained[0]["points"] <= 0:
        return None
    top = gained[0]["points"]
    return {
        "drivers": [_who(s) for s in gained if s["points"] == top],
        "points": top,
    }


# --------------------------------- notable ---------------------------------


def _notable(
    window_sessions: list[tuple],
    all_sessions: list[tuple],
    race_names: dict[int, str],
    prior_winners: set[str] | None,
) -> list[dict]:
    """Facts that fall cleanly out of the data, and only those.

    - `first_career_win`: a missed Grand Prix (never a sprint) won by a driver
      with no earlier win in this season's results or in any earlier season of
      the historical winners index. Skipped entirely when `prior_winners` is
      None, i.e. the index could not vouch for every earlier season.
    - `leader_non_finish`: the championship leader going into a missed session
      (standings over every session before it) was not classified as a
      finisher. With co-leaders, each one is checked.
    """
    notable = []
    earlier_winners: set[str] = set()
    window_keys = {(r, k) for r, k, _ in window_sessions}

    for index, (round_number, kind, results) in enumerate(all_sessions):
        in_window = (round_number, kind) in window_keys

        if in_window:
            leader = _leader(_standings(all_sessions[:index]))
            by_id = {(r.get("Driver") or {}).get("driverId"): r for r in results}
            for person in (leader or {}).get("drivers", []):
                row = by_id.get(person["driver_id"])
                if row and not _is_finisher(row.get("status")):
                    notable.append({
                        "kind": "leader_non_finish",
                        "round": round_number,
                        "race_name": race_names.get(round_number),
                        "session": kind,
                        "driver": person,
                        "status": row.get("status"),
                    })

        if kind != "race":
            continue
        winner = _classified_session(results)["winner"]
        if not winner:
            continue
        if (
            in_window
            and prior_winners is not None
            and winner["name"] not in prior_winners
            and winner["name"] not in earlier_winners
        ):
            notable.append({
                "kind": "first_career_win",
                "round": round_number,
                "race_name": race_names.get(round_number),
                "session": "race",
                "driver": _who(winner),
            })
        earlier_winners.add(winner["name"])

    return notable


# --------------------------------- builder ---------------------------------


def build_catch_up(
    season: int,
    after_round: int,
    schedule: list[dict],
    race_docs: list[dict],
    sprint_docs: list[dict],
    prior_winners: set[str] | None = None,
    stored_standings: list[dict] | None = None,
) -> dict:
    """The deterministic half of the response: rounds and facts, no narrative.

    `latest_round` is the last round with any classified session -- a sprint
    alone counts, so a visitor who left on Friday of a sprint weekend hears
    about Saturday's sprint while Sunday's race is still `pending`. A round
    inside the span with no race result on file, before the latest one, is
    `missing` (cancelled, or not synced): stated, never guessed at.
    """
    race_by_round = {
        _round_number(d): d.get("results") or []
        for d in race_docs
        if _round_number(d) is not None and d.get("results")
    }
    sprint_by_round = {
        _round_number(d): d.get("results") or []
        for d in sprint_docs
        if _round_number(d) is not None and d.get("results")
    }
    race_names: dict[int, str] = {}
    dates: dict[int, str] = {}
    for doc in race_docs + sprint_docs:
        number = _round_number(doc)
        race = doc.get("race") or {}
        if number is not None and race.get("raceName"):
            race_names.setdefault(number, race["raceName"])
            dates.setdefault(number, race.get("date"))
    for race in schedule:
        number = _round_number(race)
        if number is not None:
            race_names[number] = race.get("raceName") or race_names.get(number)
            dates[number] = race.get("date") or dates.get(number)

    classified_rounds = set(race_by_round) | set(sprint_by_round)
    latest_round = max(classified_rounds) if classified_rounds else 0

    payload = {
        "season": season,
        "after_round": after_round,
        "latest_round": latest_round,
        "baseline": {
            "round": after_round,
            "race_name": race_names.get(after_round) if after_round else None,
        },
        "rounds": [],
        "facts": None,
    }
    if after_round >= latest_round:
        return payload

    span = sorted(
        r for r in set(race_names) | classified_rounds if after_round < r <= latest_round
    )
    for round_number in span:
        if race_by_round.get(round_number):
            race_block = _classified_session(race_by_round[round_number])
        elif round_number == latest_round:
            race_block = {"status": "pending", "winner": None, "podium": []}
        else:
            race_block = {"status": "missing", "winner": None, "podium": []}
        sprint_block = (
            _classified_session(sprint_by_round[round_number])
            if sprint_by_round.get(round_number)
            else None
        )
        payload["rounds"].append({
            "round": round_number,
            "round_key": f"{season}-{round_number}",
            "race_name": race_names.get(round_number),
            "date": dates.get(round_number),
            "race": race_block,
            "sprint": sprint_block,
        })

    sessions = _sessions(race_by_round, sprint_by_round)
    before_sessions = [s for s in sessions if s[0] <= after_round]
    window_sessions = [s for s in sessions if after_round < s[0] <= latest_round]

    now = _standings(sessions)
    before = _standings(before_sessions) if after_round else []
    leader_before = _leader(before) if after_round else None
    leader_now = _leader(now)
    leader_changed = bool(
        leader_before
        and leader_now
        and {d["driver_id"] for d in leader_before["drivers"]}
        != {d["driver_id"] for d in leader_now["drivers"]}
    )

    verified = standings_agree(now, stored_standings)
    notable = _notable(window_sessions, sessions, race_names, prior_winners)
    payload["facts"] = {
        "standings_verified": verified,
        # Withheld rather than shown with a caveat: a wrong "title gap" is
        # exactly the kind of number a reader takes away from this card.
        "standings": {
            "baseline_round": after_round,
            "leader_before": leader_before,
            "leader_now": leader_now,
            "leader_changed": leader_changed,
            "title_gap_before": _title_gap(before) if after_round else None,
            "title_gap_now": _title_gap(now),
            # From the start of a season everyone "moves" up from level on
            # zero, which is not movement worth a line.
            "movers": _movers(before, now) if after_round else [],
            "top_scorer": _top_scorer(window_sessions),
        } if verified else None,
        "grands_prix_classified": sum(1 for s in window_sessions if s[1] == "race"),
        "race_wins": _wins(window_sessions, "race", race_names),
        "sprint_wins": _wins(window_sessions, "sprint", race_names),
        # Who led going into a session is a standings fact too.
        "notable": [
            n for n in notable if verified or n["kind"] != "leader_non_finish"
        ],
    }
    return payload


def standings_agree(rebuilt: list[dict], stored: list[dict] | None) -> bool:
    """Whether the rebuilt standings match the season's stored standings.

    The rebuild is only as complete as the cached results it sums. A season
    whose sprints were never synced rebuilds wrong without any error: run on
    2025 while writing this, 17 of 21 drivers' totals were short (Norris 405
    against an official 423). The current season agreed for all 23. So the
    rebuilt "now" is checked, driver by driver, against the stored document
    before any standings fact is stated, and every one is withheld if it
    disagrees. A missing stored document cannot vouch either way and is
    treated as agreement: that is a fresh database, not a gap in one.

    This can also trip for the minutes between the results sync and the
    standings sync after a race. Withholding for that window is the safe
    direction.
    """
    if not stored:
        return True
    rebuilt_points = {s["driver_id"]: float(s["points"]) for s in rebuilt}
    for entry in stored:
        driver_id = (entry.get("Driver") or {}).get("driverId")
        if not driver_id:
            continue
        if rebuilt_points.get(driver_id, 0.0) != _points(entry.get("points")):
            return False
    return True


# ------------------------------- narrative --------------------------------


def narrative_facts(payload: dict) -> dict:
    """What the model sees: the payload minus every number it must not quote.

    Dates, round keys, ids and driver codes are dropped. They are noise to a
    three-sentence summary, and every number left in the bundle is a number the
    grounding check will accept, so a date's "10" and "11" would otherwise
    license an invented "10-point gap".
    """
    def person(p: dict | None) -> dict | None:
        return {"name": p.get("name"), "team": p.get("team")} if p else None

    def session(block: dict | None) -> dict | None:
        if not block:
            return None
        return {
            "status": block.get("status"),
            "podium": [
                {"position": p.get("position"), **person(p)} for p in block.get("podium") or []
            ],
        }

    def leader(block: dict | None) -> dict | None:
        if not block:
            return None
        return {
            "drivers": [person(d) for d in block.get("drivers") or []],
            "points": block.get("points"),
            "tied": block.get("tied", False),
        }

    def gap(block: dict | None) -> dict | None:
        if not block:
            return None
        return {
            "points": block.get("points"),
            "leader": person(block.get("leader")),
            "leader_points": block.get("leader_points"),
            "second": person(block.get("second")),
            "second_points": block.get("second_points"),
        }

    def wins(entries: list[dict] | None) -> list[dict]:
        return [
            {**person(e), "wins": e.get("wins"), "races": e.get("races")}
            for e in entries or []
        ]

    facts = payload.get("facts") or {}
    standings = facts.get("standings") or {}
    top_scorer = standings.get("top_scorer")
    rounds = [
        {
            "round": r.get("round"),
            "race_name": r.get("race_name"),
            "race": session(r.get("race")),
            "sprint": session(r.get("sprint")),
        }
        for r in payload.get("rounds") or []
    ]
    # Short spans get every podium; long ones get the win tally plus the most
    # recent round only. See `_wins` for the narrative that made this rule.
    long_span = len(rounds) > NARRATIVE_PODIUM_ROUNDS
    return {
        "season": payload.get("season"),
        "missed_since": (
            f"after round {payload['after_round']} ({payload['baseline']['race_name']})"
            if payload.get("after_round")
            else "the start of the season"
        ),
        "rounds_missed": len(rounds),
        "grands_prix_classified": facts.get("grands_prix_classified"),
        "race_wins": wins(facts.get("race_wins")),
        "sprint_wins": wins(facts.get("sprint_wins")),
        ("most_recent_round" if long_span else "rounds"): rounds[-1:] if long_span else rounds,
        # Null when the rebuilt standings could not be verified (see
        # `standings_agree`); the prompt then leaves the championship out.
        "standings": {
            "leader_before": leader(standings.get("leader_before")),
            "leader_now": leader(standings.get("leader_now")),
            "leader_changed": standings.get("leader_changed", False),
            "title_gap_before": gap(standings.get("title_gap_before")),
            "title_gap_now": gap(standings.get("title_gap_now")),
            "movers": [
                {
                    **person(m),
                    "from_position": m.get("from_position"),
                    "to_position": m.get("to_position"),
                    "points_gained": m.get("points_gained"),
                }
                for m in standings.get("movers") or []
            ],
            "top_scorer": (
                {
                    "drivers": [person(d) for d in top_scorer.get("drivers") or []],
                    "points": top_scorer.get("points"),
                }
                if top_scorer
                else None
            ),
        } if facts.get("standings") else None,
        "notable": [
            {
                "kind": n.get("kind"),
                "round": n.get("round"),
                "race_name": n.get("race_name"),
                "session": n.get("session"),
                "driver": person(n.get("driver")),
                **({"status": n["status"]} if n.get("status") else {}),
            }
            for n in facts.get("notable") or []
        ],
    }


# Digits with optional thousands separators and decimals. Unsigned on purpose:
# a "-" in prose is a hyphen ("1-2 finish") far more often than a minus sign.
_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")

# Spelled-out counts are numbers too ("his third straight win" is an ordinal
# and is left alone, but "three wins" is a count the facts must contain).
# "one" is excluded: it is a pronoun ("one of the drivers") far more often
# than a quantity, and the agent verifier's trivial-number carve-out exists
# for the same reason.
_NUMBER_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
}
_NUMBER_WORD_RE = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b", re.I)


def _canonical(token: str) -> str:
    value = float(token.replace(",", ""))
    return str(int(value)) if value.is_integer() else str(value)


def _numbers_in_facts(facts: dict) -> set[str]:
    return {_canonical(n) for n in _NUMBER_RE.findall(json.dumps(facts, default=str))}


def ungrounded_numbers(text: str, facts: dict) -> list[str]:
    """Every number in `text` that does not appear in `facts`, as written.

    Exact matching against the set of numbers in the bundle, not a substring
    search of its JSON: "2" must not pass because "25" is in there.
    """
    allowed = _numbers_in_facts(facts)
    offenders = []
    for token in _NUMBER_RE.findall(text or ""):
        if _canonical(token) not in allowed:
            offenders.append(token)
    for word in _NUMBER_WORD_RE.findall(text or ""):
        if str(_NUMBER_WORDS[word.lower()]) not in allowed:
            offenders.append(word)
    return sorted(set(offenders))


# Labels the prompt forbids and the model used anyway: the first whole-season
# narrative opened "Andrea Kimi Antonelli dominated". Enforced in Python for
# the reason `session_recap._QUALIFYING_BANNED_RE` is: a rule the model has to
# remember while writing is a rule it will sometimes break.
_BANNED_LABEL_RE = re.compile(
    r"\b(?:dominat\w*|favou?rites?|struggl\w*|masterclass|crisis|"
    r"unstoppable|title[- ]bound|cruis\w*)\b",
    re.I,
)


def narrative_violations(text: str, facts: dict) -> list[str]:
    """Everything wrong with a draft that Python can see: invented numbers and
    banned labels. Empty means it may ship."""
    labels = sorted({m.lower() for m in _BANNED_LABEL_RE.findall(text or "")})
    return ungrounded_numbers(text, facts) + labels


def _plain(text: str) -> str:
    """The card renders plain text; strip the emphasis the model adds anyway."""
    return re.sub(r"[*_`#]+", "", text or "").strip()


async def _collect(facts: dict, prompt: str) -> str:
    return _plain("".join([chunk async for chunk in _generate_recap(facts, prompt)]))


async def write_narrative(facts: dict) -> tuple[str | None, bool]:
    """`(text, rejected)`. `(None, False)` means no answer (cacheable: no).

    One regeneration on a failed check, told exactly what it got wrong -- the
    `session_recap` validator loop. A second failure drops the narrative and
    reports it rejected.
    """
    text = await _collect(facts, SYSTEM_PROMPT)
    if not text:
        return None, False
    violations = narrative_violations(text, facts)
    if not violations:
        return text, False

    print(f"Catch-up narrative failed its checks {violations}; regenerating once.")
    retry_prompt = (
        f"{SYSTEM_PROMPT}\nYOUR PREVIOUS ATTEMPT WAS REJECTED. It contained these "
        f"numbers that do not appear in the JSON, or these banned labels: "
        f"{', '.join(violations)}. Rewrite it using only numbers copied from the "
        f"JSON (or none at all) and without those words."
    )
    retried = await _collect(facts, retry_prompt)
    if not retried:
        return None, False
    still_wrong = narrative_violations(retried, facts)
    if still_wrong:
        print(f"Catch-up narrative rejected after retry: {still_wrong}.")
        return None, True
    return retried, False


def narrative_cache_key(season: int, after_round: int, latest_round: int) -> dict:
    return {
        "season": season,
        "after_round": after_round,
        "latest_round": latest_round,
        "prompt_version": PROMPT_VERSION,
    }


# One generation per cache key at a time, however many visitors arrive at once.
# Also what keeps a task started by a facts-only request alive (and referenced)
# until the follow-up request that waits for it.
_IN_FLIGHT: dict[tuple, asyncio.Task] = {}


async def _generate_and_cache(db, key: dict, inputs: str, facts: dict) -> str | None:
    # Caught here, not by the caller: a facts-only request starts this task
    # and never awaits it, and an exception nobody retrieves is only logged
    # as "Task exception was never retrieved", long after the fact.
    try:
        text, rejected = await write_narrative(facts)
    except Exception as error:
        print(f"catch_up: narrative generation failed: {error}")
        return None
    if text is None and not rejected:
        return None
    try:
        await db.catch_up_narrative.update_one(
            key,
            {"$set": {**key, "inputs": inputs, "text": text, "rejected": rejected}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache catch_up_narrative for {key}: {error}")
    return text


def _generation_task(db, key: dict, inputs: str, facts: dict) -> asyncio.Task:
    flight_key = (*key.values(), inputs)
    task = _IN_FLIGHT.get(flight_key)
    if task is None:
        task = asyncio.create_task(_generate_and_cache(db, key, inputs, facts))
        _IN_FLIGHT[flight_key] = task
        task.add_done_callback(lambda _: _IN_FLIGHT.pop(flight_key, None))
    return task


async def _prior_winners(db, season: int, candidates: set[str]) -> set[str] | None:
    """Which of `candidates` won a championship race before `season`.

    None when the historical winners index does not hold every earlier season,
    in which case no first-career-win claim is made at all.
    """
    if not candidates:
        return set()
    try:
        seasons = await db.historical_race_index.distinct("season", {"season": {"$lt": season}})
        if not set(range(FIRST_CHAMPIONSHIP_SEASON, season)) <= {_as_int(s) for s in seasons}:
            return None
        docs = await db.historical_race_index.find(
            {"season": {"$lt": season}, "driver": {"$in": sorted(candidates)}},
            {"_id": 0, "driver": 1},
        ).to_list(length=None)
    except Exception as error:
        print(f"catch_up: historical winners lookup failed: {error}")
        return None
    return {d.get("driver") for d in docs}


@router.get("/catch_up")
async def get_catch_up(
    season: int = Query(..., description="Season year, e.g. 2026"),
    after_round: int = Query(
        ..., ge=0, le=40, description="Last round the visitor had seen (0: none this season)"
    ),
    narrative: bool = Query(
        True,
        description=(
            "Wait (bounded) for the AI narrative. False answers with the facts "
            "at once and starts the narrative in the background."
        ),
    ),
):
    """Everything classified since `after_round`: rounds, facts and, if
    available, a grounded narrative. See the module docstring."""
    db = get_db()
    schedule, race_docs, sprint_docs, standings_doc = await asyncio.gather(
        db.races.find(
            {"season": season}, {"_id": 0, "round": 1, "raceName": 1, "date": 1}
        ).to_list(length=100),
        db.race_results.find(
            {"season": season}, {"_id": 0, "round": 1, "race": 1, "results": 1}
        ).to_list(length=100),
        db.sprint_results.find(
            {"season": season}, {"_id": 0, "round": 1, "race": 1, "results": 1}
        ).to_list(length=100),
        db.driver_standings.find_one({"season": season}, {"_id": 0, "standings": 1}),
    )

    # Winners of the missed Grands Prix, for the first-career-win check. Read
    # before building so `build_catch_up` itself stays pure.
    candidates = set()
    for doc in race_docs:
        number = _round_number(doc)
        if number is not None and number > after_round and doc.get("results"):
            winner = _classified_session(doc["results"])["winner"]
            if winner:
                candidates.add(winner["name"])
    prior = await _prior_winners(db, season, candidates)

    payload = build_catch_up(
        season,
        after_round,
        schedule,
        race_docs,
        sprint_docs,
        prior,
        stored_standings=(standings_doc or {}).get("standings"),
    )
    payload["narrative"] = None
    if not payload["rounds"]:
        return JSONResponse(content=payload)

    facts = narrative_facts(payload)
    # The prompt is an input too. A narrative is three sentences, so retiring
    # every one on a prompt edit costs little, and it cannot be forgotten the
    # way a version bump can.
    inputs = input_fingerprint(facts, SYSTEM_PROMPT)
    key = narrative_cache_key(season, after_round, payload["latest_round"])

    try:
        cached = await db.catch_up_narrative.find_one(key, {"_id": 0})
    except Exception as error:
        print(f"catch_up: narrative cache read failed: {error}")
        cached = None

    if cached and cached.get("inputs") == inputs:
        # A rejected narrative replays as null rather than regenerating.
        payload["narrative"] = cached.get("text")
        return JSONResponse(content=payload)

    task = _generation_task(db, key, inputs, facts)
    if narrative:
        try:
            payload["narrative"] = await asyncio.wait_for(
                asyncio.shield(task), NARRATIVE_WAIT_SECONDS
            )
        except asyncio.TimeoutError:
            print(f"catch_up: narrative still generating after {NARRATIVE_WAIT_SECONDS}s")

    return JSONResponse(content=payload)
