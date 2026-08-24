"""Driver-shaped tools: career bio, one season's shape, and a head-to-head.

`get_head_to_head` reuses `driver_comparison_recap`'s fact builder verbatim,
which is the whole point of it existing there: that module ports the
frontend's `buildHeadToHead` into Python so the counts a narrative quotes are
the same counts the compare modal renders. Its docstring says why the counting
is not left to the model — "a model asked to *compare* two drivers from raw
per-round results will confabulate a tally even when the underlying rows are
correct" — which is CP38 restated for comparison rather than for teammates.

`get_driver_season_summary` is the one genuinely new aggregation in this
package (§5.1 marks it "new"). Everything it reports is a count or an average,
i.e. exactly the arithmetic CP38's rule 3 forbids the model from doing, so it
is all resolved here.

**CP73: both of these now take a driver *name* as well as a driver id, and
`get_head_to_head` defaults its season.** That is not a convenience — it is
the fix for a measured failure. Two live traces recorded the same shape:
CP61's baseline (`agent/spikes/README.md` §5, run #4) watched two of three
tool calls come back `available: false` on a **driver-id mismatch** and get
silently dropped, and CP73's own live reproduction of "Compare Norris and
Verstappen this year" against the deployed service spent ten tool calls and
95.4s without ever calling `get_head_to_head`, exhausting the step budget.
A tool whose arguments are opaque Jolpica ids (`max_verstappen`, not
"Verstappen") makes every call a guess, and a guess that fails soft is
indistinguishable from "we have no data" — so the model abandons the
purpose-built tool and reassembles the answer from the neighbours whose
arguments it happened to get right. Resolving names here, in Python, against
the season's own roster is the same move `resolve_context` already makes for
the router, applied at the place the argument is actually consumed.
"""

from __future__ import annotations

import re

from app import driver_comparison_recap

from ..ledger import EvidenceLedger
from ..resolve_context import current_season, resolve_driver, today_utc
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
from .context import _load_calendar, _load_roster

# Same split `session_recap` uses. A classified finisher's status is
# "Finished", "+1 Lap"/"+2 Laps" or "Lapped"; anything else is a retirement.
# Imported by value rather than by reference so this module does not depend on
# a private name staying private.
_FINISHER_STATUSES = ("finished", "+", "lapped")


@fact_tool("get_driver_profile")
async def get_driver_profile(
    driver_id: str, *, ledger: EvidenceLedger | None = None, db=None
) -> dict:
    """Bio and career totals for one driver.

    Reads `driver_bios` only. `driver_bio.get_driver_bio` rebuilds a stale or
    missing document with roughly twenty Jolpica calls behind a concurrency cap
    and a retry ladder — a rebuild that takes tens of seconds and that its own
    module documents as "only on a genuine cache miss, not on the hot path".
    An agent turn is not the place for it, so a miss is reported instead.

    That module's own hard-won rule is inherited with the data: every total
    here is a *count*, so a partial answer is indistinguishable from a smaller
    real one. `driver_bio` refuses to cache a partial rebuild for that reason;
    this tool refuses to serve one for the same reason, and reports which
    fields were absent rather than defaulting them to zero.
    """
    driver_id = (driver_id or "").strip()
    if not driver_id:
        return unavailable("no driver id given")

    db = resolve_db(db)
    doc = await db.driver_bios.find_one({"driverId": driver_id})
    if not doc:
        return unavailable(
            f"no cached career profile for '{driver_id}'; it is built the first "
            "time the driver's page is opened on the site"
        )

    counts = {field: doc.get(field) for field in ("wins", "podiums", "poles", "championships")}
    missing = [field for field, value in counts.items() if value is None]

    return bundle(
        data={
            "driver_id": driver_id,
            "name": f"{doc.get('givenName', '')} {doc.get('familyName', '')}".strip(),
            "code": doc.get("code"),
            "number": doc.get("permanentNumber"),
            "date_of_birth": doc.get("dateOfBirth"),
            "nationality": doc.get("nationality"),
            "wikipedia_url": doc.get("wikiUrl"),
            **counts,
            "missing_fields": missing,
        },
        source=mongo_source("driver_bios", driver_id),
        docs=[doc],
        ledger=ledger,
        tool="get_driver_profile",
        args={"driver_id": driver_id},
    )


def _find_row(results: list[dict], driver_id: str) -> dict | None:
    return next(
        (r for r in results if (r.get("Driver") or {}).get("driverId") == driver_id),
        None,
    )


# --- CP73: name → id, and a default season ----------------------------------
#
# `_load_calendar` / `_load_roster` are reached across from `tools/context.py`
# rather than re-implemented, deliberately and by the same reasoning that has
# this module import `driver_comparison_recap._build_rounds`: a second copy of
# "which drivers raced in season N" is a second thing that can disagree with
# the resolver the router already runs. Reaching for a sibling's private
# loader inside one package is a smaller cost than two rosters that drift.


async def _default_season(db) -> int | None:
    """The season the app itself considers current, from its own calendar.

    Exists so a comparative question does not *have* to be preceded by a
    `resolve_context` round trip just to turn "this year" into an integer.
    The live CP73 trace shows why that round trip is not free: the model made
    it, got the right answer (2026), and then second-guessed itself into a
    different season anyway — every extra hop is another chance to wander.
    """
    calendar, _ = await _load_calendar(db)
    if not calendar:
        return None
    return current_season(calendar, today_utc())


async def _resolve_driver_id(db, text: str, season: int | None) -> tuple[str | None, str | None]:
    """`(driver_id, None)` on success, `(None, reason)` on anything else.

    An id that is already canonical is returned untouched — the roster lookup
    is a fallback for human input, not a gate in front of correct input, and
    making a correct `max_verstappen` pay for a roster read would be a
    regression for every caller that already had the id.

    Ambiguity is passed through as a *reason*, never resolved by picking the
    first candidate. `resolve_context.py`'s module docstring is explicit that
    this is the whole point of that resolver existing, and a tool that
    quietly picked Jos over Max would produce exactly the fluent, cited,
    wrong-driver answer it was written to prevent.
    """
    text = (text or "").strip()
    if not text:
        return None, "no driver given"

    roster = await _load_roster(db, season)
    if any(entry.get("driver_id") == text for entry in roster):
        return text, None

    if not roster:
        # No roster to match against: assume the caller passed a real id
        # rather than refusing outright. The downstream query will report an
        # honest "no results synced" if it was wrong, which is a better
        # failure than inventing a resolution error for a season we simply
        # have not synced yet.
        return text, None

    resolution = resolve_driver(text, roster=roster)
    if resolution.resolved:
        return str(resolution.value), None
    if resolution.ambiguous:
        names = ", ".join(c.label for c in resolution.candidates)
        return None, (
            f"'{text}' matches more than one driver in {season} ({names}) — "
            "ask which one was meant rather than picking one"
        )
    return None, resolution.reason or f"no driver matching '{text}' in {season}"


def _season_shape(rounds: list[dict], driver_id: str) -> dict | None:
    """Wins, podiums, points and finishing record for one driver in a season.

    Computed from the rounds `_build_rounds` already loaded rather than by a
    second Mongo read, and folded into `get_head_to_head`'s bundle so the
    comparison is genuinely *complete* in one call. That completeness is the
    checkpoint: the live trace shows the model reaching `get_head_to_head`'s
    subject matter through two `get_driver_season_summary` calls instead,
    which is not irrational — until now the head-to-head bundle carried the
    duel counts but not the season totals a comparison also wants, so a model
    that called it would still have had a reason to call something else next.
    A fact bundle that answers only half the question invites the other half
    to be assembled a round at a time, which is the failure this whole
    package exists to prevent.
    """
    wins = podiums = retirements = 0
    points_total = 0.0
    finishes: list[int] = []
    entered = 0
    team = None

    for rnd in rounds:
        row = _find_row(rnd.get("results") or [], driver_id)
        if not row:
            continue
        entered += 1
        position = as_int(row.get("position"))
        points_total += as_float(row.get("points")) or 0.0
        status = str(row.get("status") or "").strip().lower()
        if status.startswith(_FINISHER_STATUSES):
            if position is not None:
                finishes.append(position)
        else:
            retirements += 1
        if position == 1:
            wins += 1
        if position is not None and position <= 3:
            podiums += 1
        team = team or (row.get("Constructor") or {}).get("name")

    if not entered:
        return None

    return {
        "rounds_entered": entered,
        "team": team,
        "wins": wins,
        "podiums": podiums,
        "points": round(points_total, 2),
        "retirements": retirements,
        "best_finish": min(finishes) if finishes else None,
        "average_finish": round(sum(finishes) / len(finishes), 2) if finishes else None,
        "average_finish_basis": (
            "classified finishes only; retirements are counted separately and "
            "are not averaged in as a finishing position"
        ),
    }


@fact_tool("get_driver_season_summary")
async def get_driver_season_summary(
    driver_id: str,
    year: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """One driver's season: wins, podiums, points, average finish and the teammate qualifying battle. `driver_id` accepts a name ("Norris") or a Jolpica id. For comparing TWO drivers, call `get_head_to_head` instead — do not call this twice.

    The teammate comparison is the field that justifies this being a tool
    rather than a prompt instruction. It is a *relational* fact — who a driver's
    teammate even is has to be read off the constructor on each round's row,
    not assumed — and CP38 is the record of what happens when a model is asked
    to work that out for itself. The pairing is resolved per round, so a
    mid-season driver swap produces two teammates rather than a wrong one.

    `average_finish` counts classified finishes only, and says so on the
    bundle: averaging a retirement as "position 20" would flatter a driver who
    finished every race they completed and quietly punish one who did not.

    CP73 added the name resolution. CP61's baseline measured this exact tool
    returning `available: false` on a guessed id and the model dropping the
    call silently instead of retrying with a corrected one; making the guess
    unnecessary is cheaper than hoping the model recovers from it.
    """
    driver_id = (driver_id or "").strip()
    if not driver_id:
        return unavailable("no driver id given")

    db = resolve_db(db)
    driver_id, reason = await _resolve_driver_id(db, driver_id, year)
    if not driver_id:
        return unavailable(reason or "driver could not be resolved")

    race_docs = await db.race_results.find({"season": year}).to_list(length=100)
    quali_docs = await db.qualifying_results.find({"season": year}).to_list(length=100)

    appearances = [
        (doc, row)
        for doc in race_docs
        if (row := _find_row(doc.get("results") or [], driver_id))
    ]
    if not appearances:
        return unavailable(
            f"no {year} race results are synced for '{driver_id}'"
        )

    name = driver_name(appearances[0][1])
    wins = podiums = points_total = 0.0
    finishes: list[int] = []
    retirements = 0
    teams: list[str] = []
    teammate_ids: dict[str, str] = {}

    for doc, row in appearances:
        position = as_int(row.get("position"))
        points_total += as_float(row.get("points")) or 0.0
        status = str(row.get("status") or "").strip().lower()
        classified = status.startswith(_FINISHER_STATUSES)
        if classified and position is not None:
            finishes.append(position)
        elif not classified:
            retirements += 1
        if position == 1:
            wins += 1
        if position is not None and position <= 3:
            podiums += 1

        team = (row.get("Constructor") or {}).get("name")
        if team and team not in teams:
            teams.append(team)
        for other in doc.get("results") or []:
            other_id = (other.get("Driver") or {}).get("driverId")
            if (
                other_id
                and other_id != driver_id
                and (other.get("Constructor") or {}).get("name") == team
            ):
                teammate_ids[other_id] = driver_name(other)

    # Qualifying head-to-head against each teammate, over the rounds both
    # actually set a comparable time. `_best_common_quali_time` picks the last
    # segment both reached — comparing one driver's Q3 to the other's Q1 would
    # be meaningless, and is precisely the comparison a model would make.
    teammate_battles = []
    for teammate_id, teammate_name in teammate_ids.items():
        ahead = behind = 0
        for doc in quali_docs:
            results = doc.get("results") or []
            mine = _find_row(results, driver_id)
            theirs = _find_row(results, teammate_id)
            if not mine or not theirs:
                continue
            common = driver_comparison_recap._best_common_quali_time(mine, theirs)
            if not common:
                continue
            if common["seconds_driver1"] < common["seconds_driver2"]:
                ahead += 1
            elif common["seconds_driver2"] < common["seconds_driver1"]:
                behind += 1
        teammate_battles.append(
            {
                "teammate_id": teammate_id,
                "teammate": teammate_name,
                "out_qualified_them": ahead,
                "out_qualified_by_them": behind,
                "rounds_compared": ahead + behind,
            }
        )

    return bundle(
        data={
            "season": year,
            "driver_id": driver_id,
            "driver": name,
            "teams": teams,
            "rounds_entered": len(appearances),
            "wins": int(wins),
            "podiums": int(podiums),
            "points": round(points_total, 2),
            "classified_finishes": len(finishes),
            "retirements": retirements,
            "best_finish": min(finishes) if finishes else None,
            "average_finish": round(sum(finishes) / len(finishes), 2) if finishes else None,
            "average_finish_basis": (
                "classified finishes only; retirements are counted separately "
                "and are not averaged in as a finishing position"
            ),
            "qualifying_teammate_battles": teammate_battles,
        },
        source=mongo_source("race_results", year, driver_id),
        docs=list(race_docs) + list(quali_docs),
        ledger=ledger,
        tool="get_driver_season_summary",
        args={"driver_id": driver_id, "year": year},
    )


@fact_tool("get_head_to_head")
async def get_head_to_head(
    driver_a: str,
    driver_b: str,
    season: int | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """THE tool for comparing two drivers over a season — one call returns the complete comparison. Takes driver names ("Norris", "Verstappen") or ids, and `season` defaults to the current one, so no other tool is needed first. Returns each driver's championship standing, points, wins, podiums and finishing record, plus the round-by-round race and qualifying duel counts. Never assemble this from two `get_driver_season_summary` calls.

    The first paragraph above is what the model actually sees — `graph.py`'s
    `_tool_description` sends only the first docstring paragraph — so it is
    written for tool *selection*, not for a human reader. That is a deliberate
    change of register from every other tool in this package, and CP73's live
    measurement is the reason. Asked "Compare Norris and Verstappen this year"
    against the deployed service, the model spent ten tool calls and 95.4s and
    never called this tool once: it resolved the season correctly, pulled both
    drivers' `get_driver_season_summary` bundles, then kept going — checking
    the season state, re-reading a *different* season, reaching for
    `get_driver_profile` and `get_standings` — until `AGENT_MAX_STEPS` cut it
    off and the turn degraded to the step-budget message. CP61's baseline had
    already recorded the same tool being skipped in favour of `get_standings`.

    Three things had to change for that trace to have gone differently, and
    all three are code rather than prompt, per this repo's CP38/CP41/CP44 rule:

    1. **Names, not ids.** `driver_a="Verstappen"` used to be an
       `available: false`; a failed call that fails *soft* teaches the model
       the tool is useless, not that its argument was wrong.
    2. **A default season.** Requiring an integer made this tool unreachable
       without a prior `resolve_context` hop, and the trace shows the model
       taking that hop, getting 2026, and then talking itself into 2025.
    3. **A complete bundle.** The old bundle carried the duel counts but not
       the season totals a comparison also wants, so even a model that called
       it correctly still had a reason to call two more tools afterwards.
       `_season_shape` folds those in from rounds already loaded.

    Reuses `driver_comparison_recap._build_rounds` (a direct Mongo read of
    `race_results` + `qualifying_results`, mirroring the frontend's
    `getSeasonResultsByRound`) and its `build_facts`, so the tallies here are
    the same tallies the site's compare modal shows.

    §5.1 gives this tool a `scope` argument. Only a **season** scope is
    implemented: a career head-to-head would need every round both drivers ever
    entered, which lives in Ergast rather than in this app's collections, and
    fetching it would be dozens of paged HTTP calls inside a single agent turn.
    The per-round arrays are trimmed off the returned bundle — a 24-row list
    per driver pair is a table, and the counts beside it are what any claim
    would actually cite.
    """
    a = (driver_a or "").strip()
    b = (driver_b or "").strip()
    if not a or not b:
        return unavailable("two drivers are required")

    db = resolve_db(db)

    if season is None:
        season = await _default_season(db)
        if season is None:
            return unavailable(
                "no season given and no calendar is synced to infer one from"
            )
    season = as_int(season)
    if season is None:
        return unavailable("season must be a year, e.g. 2026")

    resolved_a, reason_a = await _resolve_driver_id(db, a, season)
    if not resolved_a:
        return unavailable(reason_a or f"could not resolve '{a}'")
    resolved_b, reason_b = await _resolve_driver_id(db, b, season)
    if not resolved_b:
        return unavailable(reason_b or f"could not resolve '{b}'")

    if resolved_a == resolved_b:
        return unavailable("a driver cannot be compared against themselves")

    # Sorted into a canonical order for the same reason the endpoint does it:
    # `driver1`/`driver2` in the returned facts are positional, and letting the
    # caller's argument order decide them would make two calls with the same
    # meaning produce two differently-shaped bundles.
    first, second = sorted([resolved_a, resolved_b])

    rounds = await driver_comparison_recap._build_rounds(db, season)
    if not rounds:
        return unavailable(f"no {season} results are synced")

    standings_doc = await db.driver_standings.find_one({"season": season})
    standings = (standings_doc or {}).get("standings") or []

    facts = driver_comparison_recap.build_facts(season, first, second, standings, rounds)

    shared = facts["race_head_to_head"]["shared_rounds"]
    if shared == 0:
        return unavailable(
            f"{first} and {second} share no classified {season} rounds to compare"
        )

    facts["race_head_to_head"].pop("rounds", None)
    facts["qualifying_head_to_head"].pop("rounds", None)
    facts["driver1"]["season_totals"] = _season_shape(rounds, first)
    facts["driver2"]["season_totals"] = _season_shape(rounds, second)
    facts["scope"] = f"season {season}"
    facts["completeness"] = (
        "this bundle is the whole season comparison for these two drivers; "
        "no further tool call is needed to answer a comparative question"
    )

    return bundle(
        data=facts,
        source=mongo_source("race_results", season, f"{first}-vs-{second}"),
        docs=[standings_doc],
        ledger=ledger,
        tool="get_head_to_head",
        args={"driver_a": first, "driver_b": second, "season": season},
    )


def _short_race_name(name: str) -> str:
    """Trims the boilerplate off a race name so it fits a chart label.

    Ports `frontend/src/lib/season-results.ts`'s `shortRaceName` so a chart
    built from this tool's data uses the same round labels the standings
    page's own progression chart does.
    """
    trimmed = re.sub(r"\s*Grand Prix\s*", " ", name or "", flags=re.IGNORECASE)
    trimmed = re.sub(r"\s*\bGP\b\s*", " ", trimmed, flags=re.IGNORECASE)
    trimmed = trimmed.strip()
    return trimmed or (name or "")


def _driver_progression(rounds: list[dict], driver_id: str) -> dict | None:
    """Round-by-round points, name and team for one driver.

    None if the driver has no classified round in `rounds` at all, so the
    caller can tell "resolved to a real id but never raced" apart from a
    driver who raced and simply scored zero every round.
    """
    series: list[dict] = []
    running = 0.0
    name = None
    team = None

    for rnd in rounds:
        row = _find_row(rnd.get("results") or [], driver_id)
        if not row:
            continue
        if name is None:
            name = driver_name(row)
        if team is None:
            team = (row.get("Constructor") or {}).get("name")

        points = as_float(row.get("points")) or 0.0
        running += points
        position_text = row.get("positionText") or row.get("position")

        series.append({
            "round": as_int(rnd.get("round")),
            "race_name": rnd.get("raceName") or "",
            "short_name": _short_race_name(rnd.get("raceName") or ""),
            "points": round(points, 2),
            "cumulative_points": round(running, 2),
            "position": as_int(position_text),
        })

    if not series:
        return None

    return {
        "driver_id": driver_id,
        "name": name or driver_id,
        "team": team,
        "points_by_round": series,
    }


@fact_tool("get_points_progression")
async def get_points_progression(
    driver_a: str,
    driver_b: str | None = None,
    season: int | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Round-by-round championship points for one or two drivers over a season — the series a progression/trend chart needs, which `get_head_to_head` does not carry. Takes driver names or ids; `season` defaults to the current one. Pass `driver_b` to get both drivers' series in one call for a head-to-head progression chart.

    `get_head_to_head` answers "how do these two compare" with season totals
    and duel counts, and deliberately does not carry a per-round series — its
    own docstring explains why ("a 24-row list per driver pair is a table").
    This tool exists for the different question that provoked its own
    incident: a live `render_visual` call asked to compare two drivers' points
    had only `get_head_to_head`'s two scalars to work with, and drew a
    two-point line chart using each driver's array index as a fake x-axis —
    there was no real series in evidence to plot, so the model invented one
    that looked like there was. `get_points_progression` is the fix: when a
    question is about a TREND over the season (a progression chart, "how did
    the gap change", "who was ahead after round N") rather than a snapshot,
    call this instead, and pass its `points_by_round` series straight into
    `apex.lines`.

    Race points only, same scope as `_season_shape` in this module — sprint
    points are not in the rounds `driver_comparison_recap._build_rounds`
    reads. The returned bundle's `completeness` field says so explicitly
    rather than leaving `cumulative_points` looking authoritative when it can
    trail the official standings slightly on a sprint weekend.
    """
    a = (driver_a or "").strip()
    if not a:
        return unavailable("at least one driver is required")
    b = (driver_b or "").strip() if driver_b else None

    db = resolve_db(db)

    if season is None:
        season = await _default_season(db)
        if season is None:
            return unavailable(
                "no season given and no calendar is synced to infer one from"
            )
    season = as_int(season)
    if season is None:
        return unavailable("season must be a year, e.g. 2026")

    resolved_a, reason_a = await _resolve_driver_id(db, a, season)
    if not resolved_a:
        return unavailable(reason_a or f"could not resolve '{a}'")

    resolved_b = None
    if b:
        resolved_b, reason_b = await _resolve_driver_id(db, b, season)
        if not resolved_b:
            return unavailable(reason_b or f"could not resolve '{b}'")
        if resolved_b == resolved_a:
            return unavailable("a driver cannot be compared against themselves")

    rounds = await driver_comparison_recap._build_rounds(db, season)
    if not rounds:
        return unavailable(f"no {season} results are synced")

    driver_ids = [resolved_a] + ([resolved_b] if resolved_b else [])
    drivers = []
    for driver_id in driver_ids:
        progression = _driver_progression(rounds, driver_id)
        if progression is None:
            return unavailable(f"'{driver_id}' has no classified {season} rounds")
        drivers.append(progression)

    return bundle(
        data={
            "season": season,
            "drivers": drivers,
            "completeness": (
                "race points only; sprint points (if any this season) are not "
                "included, so cumulative_points here can trail the official "
                "standings slightly on a sprint weekend"
            ),
        },
        source=mongo_source("race_results", season, "-".join(driver_ids)),
        docs=[],
        ledger=ledger,
        tool="get_points_progression",
        args={"driver_a": resolved_a, "driver_b": resolved_b, "season": season},
    )
