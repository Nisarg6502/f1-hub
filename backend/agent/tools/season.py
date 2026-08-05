"""Season-shaped tools: the calendar, one session's classification, the
championship tables, and race-day weather.

All four read Mongo only. The endpoints that back the website
(`session_results.get_race_results`, `get_session_classification`,
`championship_standings.*`) each have a live fallback behind their cache read,
and two of those fallbacks are FastF1 (`f1_results.load_session`) — which 403s
from a datacenter IP and fails *soft*, so it would return an empty
classification with no error in production and a perfect one locally. These
tools therefore reuse those modules' **pure reshaping helpers** and read the
collections directly, rather than calling the endpoint functions. A round that
is genuinely not synced reports `available: false`, which is the honest answer
and is also what the rest of the app already does for the same case.
"""

from __future__ import annotations

from app import races as races_module
from app import session_recap

from ..ledger import EvidenceLedger
from .base import (
    as_float,
    as_int,
    bundle,
    driver_name,
    fact_tool,
    mongo_source,
    resolve_db,
    unavailable,
)

# Which cached collection backs each session code. Mirrors
# `session_recap.SESSION_COLLECTIONS` but keyed by the session codes the
# frontend and the router already speak (`R`/`Q`/`S`/`FP1`…), so a caller never
# has to translate twice.
_RACE_LIKE = {"R": "race_results", "S": "sprint_results"}
_QUALIFYING = {"Q": "qualifying_results"}
_PRACTICE = {"FP1", "FP2", "FP3", "SQ"}

_SESSION_ALIASES = {
    "RACE": "R",
    "GRAND PRIX": "R",
    "SPRINT": "S",
    "QUALIFYING": "Q",
    "QUALI": "Q",
    "SPRINT QUALIFYING": "SQ",
    "SPRINT SHOOTOUT": "SQ",
}


def _session_code(session: str) -> str:
    raw = (session or "R").strip().upper()
    return _SESSION_ALIASES.get(raw, raw)


@fact_tool("get_season_calendar")
async def get_season_calendar(
    year: int, *, ledger: EvidenceLedger | None = None, db=None
) -> dict:
    """Every round of a season with its date, circuit and (if run) its winner.

    Reuses `races._attach_winners`, which bulk-joins the season's winners in a
    single query — `HANDOFF.md` names re-deriving that as an N+1 worth
    avoiding, and it is also what makes this bundle answer "who won in X" for
    the whole season without a second tool call.
    """
    db = resolve_db(db)
    docs = await db.races.find({"season": year}).to_list(length=100)
    if not docs:
        return unavailable(f"the {year} calendar has not been synced")

    docs.sort(key=races_module._round_key)
    await races_module._attach_winners(db, year, docs)

    rounds = []
    for doc in docs:
        circuit = doc.get("Circuit") or {}
        location = circuit.get("Location") or {}
        winner = doc.get("winner") or {}
        rounds.append(
            {
                "round": as_int(doc.get("round")),
                "race_name": doc.get("raceName"),
                "date": doc.get("date"),
                "circuit_id": circuit.get("circuitId"),
                "circuit_name": circuit.get("circuitName"),
                "locality": location.get("locality"),
                "country": location.get("country"),
                "winner": (
                    f"{winner.get('givenName', '')} {winner.get('familyName', '')}".strip()
                    or None
                )
                if winner
                else None,
            }
        )

    run = [r for r in rounds if r["winner"]]
    return bundle(
        data={
            "season": year,
            "rounds_scheduled": len(rounds),
            # Derived here rather than left for the model to count: "how many
            # races are left this year" is arithmetic, and arithmetic is what
            # CP38's rule 3 took away from the model.
            "rounds_with_a_result": len(run),
            "rounds": rounds,
        },
        source=mongo_source("races", year),
        docs=docs,
        ledger=ledger,
        tool="get_season_calendar",
        args={"year": year},
    )


def _race_like_classification(results: list[dict]) -> dict:
    """Podium, full classification, teammates and retirements for a race/sprint.

    Every field is lifted from `session_recap`'s own fact builder helpers, so a
    classification the agent narrates is byte-identical to one the site's recap
    narrates. `teammates` in particular is the direct CP38 fix: the pairings
    are stated, never inferred.
    """
    classification = session_recap._classification_facts(results)
    return {
        "total_classified": len(classification),
        "podium": classification[:3],
        "classification": classification,
        "teammates": session_recap._teammates(results),
        "retirements": session_recap._retirements(classification),
        "biggest_movers": session_recap._biggest_movers(classification),
        "fastest_lap": session_recap._fastest_lap_facts(results),
    }


def _qualifying_classification(results: list[dict]) -> dict:
    """Pole, the Q3 order and each segment's eliminations.

    Reuses `session_recap`'s qualifying derivations wholesale. Which segment a
    driver was eliminated in is a fact the raw rows only imply — a driver with
    no Q3 time might have been knocked out in Q2 or might have reached Q3 and
    set nothing — and that inference is exactly what rule 9 of the qualifying
    prompt forbids the model from making.
    """
    rows = session_recap._qualifying_rows(results)
    return {
        "total_entries": len(rows),
        "pole": session_recap._pole_facts(rows),
        "q3": session_recap._q3_order(rows),
        "q2_eliminated": session_recap._eliminated_in(rows, "Q2", "Q3"),
        "q1_eliminated": session_recap._eliminated_in(rows, "Q1", "Q2"),
        "no_time_set": [
            {"position": r["position"], "driver": r["driver"], "team": r["team"]}
            for r in rows
            if r["final_segment"] is None
        ],
        "teammate_battles": session_recap._teammate_battles(rows),
    }


def _practice_classification(results: list[dict]) -> dict:
    """A practice session's timing sheet, flattened.

    Practice rows come from FastF1 via the sync job and carry a thinner shape
    than Ergast's — no grid, no points, no status — so this cannot go through
    `_classification_facts` without inventing empty fields.
    """
    rows = []
    for entry in results:
        rows.append(
            {
                "position": entry.get("position"),
                "driver": driver_name(entry) or entry.get("driver"),
                "team": (entry.get("Constructor") or {}).get("name"),
                "time": (entry.get("Time") or {}).get("time"),
            }
        )
    return {"total_entries": len(rows), "classification": rows}


@fact_tool("get_session_result")
async def get_session_result(
    year: int,
    round_number: int,
    session: str = "R",
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """The classification for one session of one round.

    `session` is a code (`R`, `Q`, `S`, `FP1`-`FP3`, `SQ`) or a plain word
    ("race", "qualifying"). Race and Sprint share a shape; qualifying gets its
    own, because a qualifying result is not a short race result — it has no
    gaps to leader, no points and no retirements, but it does have three
    segments and an elimination at each boundary.
    """
    code = _session_code(session)
    key = {"season": year, "round": str(round_number)}

    db = resolve_db(db)
    if code in _PRACTICE:
        doc = await db.practice_results.find_one({**key, "session": code})
        collection = "practice_results"
    elif code in _QUALIFYING:
        doc = await db.qualifying_results.find_one(key)
        collection = "qualifying_results"
    elif code in _RACE_LIKE:
        collection = _RACE_LIKE[code]
        doc = await db[collection].find_one(key)
    else:
        return unavailable(
            f"'{session}' is not a session this app stores; "
            "use R, Q, S, SQ, FP1, FP2 or FP3"
        )

    results = (doc or {}).get("results") or []
    if not results:
        return unavailable(
            f"the {code} session for {year} round {round_number} has not been synced"
        )

    race = (doc or {}).get("race") or {}
    if code in _PRACTICE:
        detail = _practice_classification(results)
        race_name = doc.get("event_name")
    elif code in _QUALIFYING:
        detail = _qualifying_classification(results)
        race_name = race.get("raceName")
    else:
        detail = _race_like_classification(results)
        race_name = race.get("raceName")

    return bundle(
        data={
            "season": year,
            "round": round_number,
            "session": code,
            "race_name": race_name,
            "circuit": (race.get("Circuit") or {}).get("circuitName"),
            "date": race.get("date"),
            **detail,
        },
        source=mongo_source(collection, year, round_number),
        docs=[doc],
        ledger=ledger,
        tool="get_session_result",
        args={"year": year, "round": round_number, "session": code},
    )


def _standing_rows(standings: list[dict], kind: str) -> list[dict]:
    rows = []
    for entry in standings:
        if kind == "constructor":
            constructor = entry.get("Constructor") or {}
            rows.append(
                {
                    "position": as_int(entry.get("position")),
                    "constructor_id": constructor.get("constructorId"),
                    "constructor": constructor.get("name"),
                    "points": as_float(entry.get("points")),
                    "wins": as_int(entry.get("wins")),
                }
            )
        else:
            driver = entry.get("Driver") or {}
            constructors = entry.get("Constructors") or []
            rows.append(
                {
                    "position": as_int(entry.get("position")),
                    "driver_id": driver.get("driverId"),
                    "driver": f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip(),
                    "team": constructors[0].get("name") if constructors else None,
                    "points": as_float(entry.get("points")),
                    "wins": as_int(entry.get("wins")),
                }
            )
    return rows


def _leader_gaps(rows: list[dict]) -> list[dict]:
    """Attach each row's points gap to the leader.

    Precomputed for the same reason `session_recap` precomputes race gaps: a
    model asked "how far behind is he" will subtract two numbers, and CP38's
    rule 3 bans it from doing arithmetic at all.
    """
    leader = next((r["points"] for r in rows if r.get("points") is not None), None)
    for row in rows:
        points = row.get("points")
        row["points_behind_leader"] = (
            round(leader - points, 2) if leader is not None and points is not None else None
        )
    return rows


async def _standings_after_round(db, year: int, kind: str, after_round: int) -> tuple[list[dict], list[dict]]:
    """Rebuild a championship table as it stood after a given round.

    The `driver_standings`/`constructor_standings` collections hold only the
    *current* table — Ergast has no per-round snapshot in what this app syncs —
    so a historical standing has to be re-tallied from the results themselves.
    Sprint points are included, because they count; leaving them out would
    produce a table that is quietly wrong for every sprint weekend.
    """
    race_docs = await db.race_results.find({"season": year}).to_list(length=100)
    sprint_docs = await db.sprint_results.find({"season": year}).to_list(length=100)

    # Tagged rather than tested by identity later: two documents from different
    # collections can compare equal by value, and "is this a Grand Prix?" is
    # load-bearing for the win count below.
    tagged = [(doc, True) for doc in race_docs] + [(doc, False) for doc in sprint_docs]

    totals: dict[str, dict] = {}
    for doc, is_race in tagged:
        round_number = as_int(doc.get("round"))
        if round_number is None or round_number > after_round:
            continue
        for entry in doc.get("results") or []:
            driver = entry.get("Driver") or {}
            constructor = entry.get("Constructor") or {}
            if kind == "constructor":
                key = constructor.get("constructorId") or constructor.get("name")
                label = {"constructor_id": key, "constructor": constructor.get("name")}
            else:
                key = driver.get("driverId")
                label = {
                    "driver_id": key,
                    "driver": driver_name(entry),
                    "team": constructor.get("name"),
                }
            if not key:
                continue
            row = totals.setdefault(key, {**label, "points": 0.0, "wins": 0})
            row["points"] += as_float(entry.get("points")) or 0.0
            # Only a Grand Prix win is a win. A sprint victory is not counted
            # as one anywhere in the sport's own standings, and counting it
            # here would make this table disagree with every other one.
            if is_race and as_int(entry.get("position")) == 1:
                row["wins"] += 1

    rows = sorted(totals.values(), key=lambda r: (-r["points"], -r["wins"]))
    for index, row in enumerate(rows, start=1):
        row["position"] = index
        row["points"] = round(row["points"], 2)
    return rows, list(race_docs) + list(sprint_docs)


@fact_tool("get_standings")
async def get_standings(
    year: int,
    kind: str = "driver",
    after_round: int | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """The driver or constructor championship table.

    With `after_round`, the table is re-tallied from race and sprint results up
    to that round — see `_standings_after_round` for why the stored collections
    cannot answer it. Without it, the stored table is served, which is the one
    the site itself renders.
    """
    kind = (kind or "driver").strip().lower().rstrip("s")
    if kind not in ("driver", "constructor"):
        return unavailable(f"'{kind}' is not a standings kind; use driver or constructor")

    db = resolve_db(db)

    if after_round is not None:
        rows, docs = await _standings_after_round(db, year, kind, after_round)
        if not rows:
            return unavailable(
                f"no {year} results up to round {after_round} have been synced"
            )
        return bundle(
            data={
                "season": year,
                "kind": kind,
                "after_round": after_round,
                "computed_from": "race_results + sprint_results",
                "standings": _leader_gaps(rows),
            },
            source=mongo_source("race_results", year, f"through-r{after_round}"),
            docs=docs,
            ledger=ledger,
            tool="get_standings",
            args={"year": year, "kind": kind, "after_round": after_round},
        )

    collection = "constructor_standings" if kind == "constructor" else "driver_standings"
    doc = await db[collection].find_one({"season": year})
    standings = (doc or {}).get("standings") or []
    if not standings:
        return unavailable(f"{year} {kind} standings have not been synced")

    return bundle(
        data={
            "season": year,
            "kind": kind,
            "after_round": None,
            "standings": _leader_gaps(_standing_rows(standings, kind)),
        },
        source=mongo_source(collection, year),
        docs=[doc],
        ledger=ledger,
        tool="get_standings",
        args={"year": year, "kind": kind, "after_round": None},
    )


@fact_tool("get_weather")
async def get_weather(
    year: int,
    round_number: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Representative mid-race conditions for a round.

    Reads `weather_cache` only. `session_results.get_race_weather` falls back
    to a live OpenF1 query on a miss; that call is left to the website's own
    endpoint rather than run inside an agent turn, where a slow upstream would
    burn latency against a gate that admits one run at a time.

    `rainfall` is OpenF1's 0/1 flag, surfaced as an explicit boolean so the
    model is never asked to interpret what a `1` means.
    """
    db = resolve_db(db)
    doc = await db.weather_cache.find_one({"season": year, "round": str(round_number)})
    if not doc:
        return unavailable(
            f"no weather has been captured for {year} round {round_number}"
        )

    rainfall = doc.get("rainfall")
    return bundle(
        data={
            "season": year,
            "round": round_number,
            "date": doc.get("date"),
            "air_temperature_c": doc.get("air_temperature"),
            "track_temperature_c": doc.get("track_temperature"),
            "humidity_pct": doc.get("humidity"),
            "pressure_mbar": doc.get("pressure"),
            "wind_speed": doc.get("wind_speed"),
            "wind_direction": doc.get("wind_direction"),
            "raining": bool(rainfall) if rainfall is not None else None,
            "sample": "one representative mid-session reading, not a session average",
        },
        source=mongo_source("weather_cache", year, round_number),
        docs=[doc],
        ledger=ledger,
        tool="get_weather",
        args={"year": year, "round": round_number},
    )
