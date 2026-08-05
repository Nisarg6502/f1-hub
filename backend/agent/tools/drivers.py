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
"""

from __future__ import annotations

from app import driver_comparison_recap

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


@fact_tool("get_driver_season_summary")
async def get_driver_season_summary(
    driver_id: str,
    year: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Wins, podiums, points, average finish and the teammate qualifying battle.

    The teammate comparison is the field that justifies this being a tool
    rather than a prompt instruction. It is a *relational* fact — who a driver's
    teammate even is has to be read off the constructor on each round's row,
    not assumed — and CP38 is the record of what happens when a model is asked
    to work that out for itself. The pairing is resolved per round, so a
    mid-season driver swap produces two teammates rather than a wrong one.

    `average_finish` counts classified finishes only, and says so on the
    bundle: averaging a retirement as "position 20" would flatter a driver who
    finished every race they completed and quietly punish one who did not.
    """
    driver_id = (driver_id or "").strip()
    if not driver_id:
        return unavailable("no driver id given")

    db = resolve_db(db)
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
    season: int,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Round-by-round race and qualifying comparison of two drivers in a season.

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
        return unavailable("two driver ids are required")
    if a == b:
        return unavailable("a driver cannot be compared against themselves")

    db = resolve_db(db)
    # Sorted into a canonical order for the same reason the endpoint does it:
    # `driver1`/`driver2` in the returned facts are positional, and letting the
    # caller's argument order decide them would make two calls with the same
    # meaning produce two differently-shaped bundles.
    first, second = sorted([a, b])

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
    facts["scope"] = f"season {season}"

    return bundle(
        data=facts,
        source=mongo_source("race_results", season, f"{first}-vs-{second}"),
        docs=[standings_doc],
        ledger=ledger,
        tool="get_head_to_head",
        args={"driver_a": first, "driver_b": second, "season": season},
    )
