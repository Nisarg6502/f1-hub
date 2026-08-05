"""The Mongo-reading half of `resolve_context`, plus the clock.

`agent/resolve_context.py` is deliberately pure — every function there takes
its calendar and roster as arguments — so that the entire resolution surface,
including every ambiguity case, is unit-testable with no database. This module
is the thin layer that loads those arguments and nothing else.

It is a tool rather than an internal helper because the resolution has to be
*visible*. When the answer says "the last race" meant round 13 in Hungary, the
ledger entry behind that is what lets CP64's verifier check the claim, and what
lets the UI show the user which race was assumed. A resolution done invisibly
inside the router would be an unciteable premise underneath every other
citation.
"""

from __future__ import annotations

import datetime

from ..ledger import EvidenceLedger
from ..resolve_context import (
    circuits_from_calendar,
    current_season,
    normalise_calendar,
    normalise_roster,
    resolve,
    season_state,
    today_utc,
)
from .base import bundle, fact_tool, mongo_source, resolve_db, unavailable


async def _load_calendar(db, seasons: int = 3) -> tuple[list[dict], list[dict]]:
    """The calendar for the recent seasons, newest-first-limited.

    Not the whole `races` collection: resolving "the last race" only needs
    enough history to cross a season boundary, and loading every synced season
    would grow this call without making any phrase resolvable that was not
    already. Older seasons are still reachable — an explicit year goes to the
    tools directly, which query by season rather than through here.
    """
    docs = await db.races.find({}).to_list(length=None)
    if not docs:
        return [], []
    years = sorted({d.get("season") for d in docs if d.get("season") is not None})
    recent = set(years[-seasons:])
    kept = [d for d in docs if d.get("season") in recent]
    return normalise_calendar(kept), kept


async def _load_roster(db, season: int | None) -> list[dict]:
    """The drivers of a season, preferring standings and falling back to results.

    Standings first because that document carries every driver who has scored
    and is one read; race results are the fallback for a season too early for
    standings to have been written, and for a driver who has never scored a
    point and so never appears in the table at all.
    """
    if season is None:
        return []
    standings_doc = await db.driver_standings.find_one({"season": season})
    rows = list((standings_doc or {}).get("standings") or [])
    result_docs = await db.race_results.find({"season": season}).to_list(length=100)
    for doc in result_docs:
        rows.extend(doc.get("results") or [])
    return normalise_roster(rows)


@fact_tool("resolve_context")
async def resolve_context(
    hint: str,
    today: str | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Resolve a vague reference to concrete ids, and report ties honestly.

    Returns a resolution per kind (season, race, driver, circuit) with a
    top-level `ambiguous` flag. **`ambiguous: true` is an instruction, not
    information**: the caller must ask which one was meant rather than call a
    tool with a guessed argument. That is the entire reason this exists — a
    model that guesses "Kimi" produces a fluent, cited answer about the wrong
    driver, which is strictly worse than a clarifying question.

    `today` overrides the clock, for tests and for replaying a past
    conversation. Left unset it is the real UTC date, which is the fact a model
    does not have and cannot infer.
    """
    hint = (hint or "").strip()
    if not hint:
        return unavailable("no hint given to resolve")

    when = today_utc()
    if today:
        try:
            when = datetime.date.fromisoformat(today[:10])
        except ValueError:
            return unavailable(f"'{today}' is not an ISO date")

    db = resolve_db(db)
    calendar, race_docs = await _load_calendar(db)
    if not calendar:
        return unavailable("no calendar is synced, so nothing can be resolved")

    # The roster is scoped to the season the hint itself points at, which is
    # what makes ambiguity era-correct: "Kimi" is unambiguous in 2019 and
    # ambiguous only in a season where both Räikkönen and Antonelli are on the
    # grid. A global roster would report a tie that does not exist.
    #
    # Falling back to the current season matters more than it looks: most
    # questions name a driver and no year at all ("how did Kimi do"), and a
    # resolution that loaded no roster for those would report every one of them
    # as an unknown driver.
    provisional = resolve(hint, calendar=calendar, roster=(), today=when)
    season = provisional["season"]["value"] or current_season(calendar, when)
    roster = await _load_roster(db, season)

    resolution = resolve(
        hint,
        calendar=calendar,
        roster=roster,
        circuits=circuits_from_calendar(calendar),
        today=when,
    )
    resolution["roster_season"] = season
    resolution["roster_size"] = len(roster)

    return bundle(
        data=resolution,
        source=mongo_source("races", "context"),
        docs=race_docs,
        ledger=ledger,
        tool="resolve_context",
        args={"hint": hint, "today": when.isoformat()},
    )


@fact_tool("get_season_state")
async def get_season_state(
    today: str | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Today's date plus where the season currently stands.

    Models do not know what day it is (§5.3), and a bare timestamp is not
    enough on its own — "is there a race this weekend" needs the calendar
    beside the clock, so both arrive together and neither has to be inferred
    from the other.
    """
    when = today_utc()
    if today:
        try:
            when = datetime.date.fromisoformat(today[:10])
        except ValueError:
            return unavailable(f"'{today}' is not an ISO date")

    db = resolve_db(db)
    calendar, race_docs = await _load_calendar(db)
    if not calendar:
        return unavailable("no calendar is synced")

    return bundle(
        data=season_state(calendar, when),
        source=mongo_source("races", "season-state"),
        docs=race_docs,
        ledger=ledger,
        tool="get_season_state",
        args={"today": when.isoformat()},
    )
