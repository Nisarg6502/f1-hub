"""Deep-history tools over the 1950-present index.

The collection these read, `historical_race_index`, is not raw Ergast. It is
`historical_index.normalize_races`'s output, which applies five corrections
that raw Ergast data needs before anything can be said about it (that module's
docstring is the full list, and `HANDOFF.md` repeats the durable ones):

1. A handful of 1950s races carry **two P1 rows** — a driver swapped into a
   teammate's car mid-race and both were classified first — so Ergast's own
   `total` (1163) exceeds the real race count (1160). De-duplicated on
   `(season, round)`.
2. The `alfa` constructorId is **three unrelated teams** 70 years apart, split
   by era.
3. Lotus, Brabham, Cooper and McLaren each fragment into several chassis/engine
   constructorIds, collapsed via `CONSTRUCTOR_ALIASES`.
4. `lotus_f1` (2012-15) is **not** a Lotus — it is the Renault-descended team —
   and is deliberately left out of that merge.
5. The 1950-60 **Indianapolis 500** counted for the championship, so four
   American roadster builders are race winners having never entered a Grand
   Prix; kept, but flagged.

Reusing the collection rather than querying Ergast is therefore not just about
latency: it is the only way these facts arrive already correct. An agent that
paged Ergast itself would re-acquire every one of those five defects, and the
resulting answer ("Lotus won 6 races" instead of 79, because the wins are split
across four constructorIds) would be wrong in a way no prompt could catch.

Both tools return **aggregates plus a bounded sample**, never the index. 1160
race records is not a fact bundle, it is a database dump, and the plan's
context-budget rule applies to history exactly as it does to lap data.
"""

from __future__ import annotations

from app.historical_index import canonical_display_name, canonical_key

from ..ledger import EvidenceLedger
from .base import as_int, bundle, fact_tool, mongo_source, resolve_db, unavailable

# How many individual races come back beside the tallies. Ten is enough to name
# the specific rounds behind a claim (which is what a citation needs) without
# turning the bundle into the table it is summarising.
SAMPLE_LIMIT = 10


@fact_tool("get_historical_race_index")
async def get_historical_race_index(
    season_from: int | None = None,
    season_to: int | None = None,
    circuit_id: str | None = None,
    driver: str | None = None,
    constructor_key: str | None = None,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Win tallies across 1950-present, filtered, plus a sample of the races.

    Every filter is optional and they combine, so this answers both "how many
    races has Ferrari won at Monza" and "who won most often in the 1980s". The
    driver filter is a case-insensitive substring on the winner's full name,
    because the index stores a display name rather than a `driverId` — an exact
    match would fail on every accented surname a user types unaccented.

    `constructor_key` is a **canonical** key, not a raw Ergast constructorId.
    Passing a raw one still works: it is normalised through
    `historical_index.canonical_key` first, so `team_lotus` and `lotus-ford`
    both resolve to the same lineage instead of returning two small wrong
    numbers.
    """
    db = resolve_db(db)

    query: dict = {}
    season_clause: dict = {}
    if season_from is not None:
        season_clause["$gte"] = season_from
    if season_to is not None:
        season_clause["$lte"] = season_to
    if season_clause:
        query["season"] = season_clause
    if circuit_id:
        query["circuit_id"] = circuit_id.strip().lower()

    rows = await db.historical_race_index.find(query).to_list(length=None)

    if constructor_key:
        # Normalised on both sides rather than compared raw, so a caller who
        # passes `brabham-repco` gets Brabham's whole lineage.
        wanted = canonical_key(constructor_key.strip(), None)
        rows = [
            r
            for r in rows
            if canonical_key(str(r.get("constructor_key") or ""), r.get("season"))
            == wanted
        ]
    if driver:
        needle = driver.strip().lower()
        rows = [r for r in rows if needle in str(r.get("driver") or "").lower()]

    if not rows:
        return unavailable(
            "no races in the historical index match those filters",
            filters={
                "season_from": season_from,
                "season_to": season_to,
                "circuit_id": circuit_id,
                "driver": driver,
                "constructor_key": constructor_key,
            },
        )

    rows.sort(key=lambda r: (r.get("season") or 0, r.get("round") or 0))

    def _tally(field: str, limit: int = 10) -> list[dict]:
        counts: dict[str, int] = {}
        for row in rows:
            key = row.get(field)
            if key:
                counts[key] = counts.get(key, 0) + 1
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return [{"name": name, "wins": wins} for name, wins in ranked[:limit]]

    indy = [r for r in rows if r.get("indy500")]
    seasons = [r.get("season") for r in rows if r.get("season")]

    return bundle(
        data={
            "filters": {
                "season_from": season_from,
                "season_to": season_to,
                "circuit_id": circuit_id,
                "driver": driver,
                "constructor_key": constructor_key,
            },
            "races_matched": len(rows),
            "season_range": [min(seasons), max(seasons)] if seasons else None,
            "wins_by_driver": _tally("driver"),
            "wins_by_constructor": _tally("constructor_name"),
            "indy500_races_included": len(indy),
            "indy500_note": (
                "the 1950-60 Indianapolis 500 counted for the World Championship "
                "but was not a Grand Prix; never present these as Grand Prix wins"
            ),
            "sample": [
                {
                    "season": r.get("season"),
                    "round": r.get("round"),
                    "race_name": r.get("race_name"),
                    "circuit_id": r.get("circuit_id"),
                    "winner": r.get("driver"),
                    "constructor": r.get("constructor_name"),
                    "indy500": bool(r.get("indy500")),
                }
                for r in rows[:SAMPLE_LIMIT]
            ],
            "sample_note": (
                f"the sample is the first {SAMPLE_LIMIT} matching races in "
                "chronological order, not a ranking; the tallies above cover all "
                f"{len(rows)}"
            ),
        },
        source=mongo_source("historical_race_index"),
        docs=[],
        ledger=ledger,
        tool="get_historical_race_index",
        args={
            "season_from": season_from,
            "season_to": season_to,
            "circuit_id": circuit_id,
            "driver": driver,
            "constructor_key": constructor_key,
        },
    )


@fact_tool("get_constructor_seasons")
async def get_constructor_seasons(
    constructor_id: str, *, ledger: EvidenceLedger | None = None, db=None
) -> dict:
    """A constructor's active seasons and its winning seasons, genealogy-aware.

    Two different things, kept apart on purpose. **Active seasons** come from
    `constructor_seasons_cache`, which is a per-raw-constructorId pass-through
    of Ergast's own season list — deliberately *not* normalised, because the
    genealogy tree maps raw ids to lineage nodes itself. **Winning seasons**
    come from the historical index and *are* normalised, so Lotus's wins are
    not split four ways across its chassis-era ids.

    A constructor that never won a race has an empty winning-seasons list and a
    populated active one, which is the correct and non-obvious answer — the
    genealogy page exists precisely so those constructors are sized against
    real data rather than dropped.

    `historical_index.get_constructor_seasons` fetches from Jolpica on a cache
    miss; that call is left to the website's endpoint, so an uncached
    constructor reports what it does know (wins) and says the season list is
    absent, rather than either blocking on HTTP or claiming the team never raced.
    """
    constructor_id = (constructor_id or "").strip()
    if not constructor_id:
        return unavailable("no constructor id given")

    db = resolve_db(db)
    cache_doc = await db.constructor_seasons_cache.find_one(
        {"constructor_id": constructor_id}
    )
    active_seasons = (cache_doc or {}).get("seasons") or []

    key = canonical_key(constructor_id, None)
    rows = await db.historical_race_index.find({}).to_list(length=None)
    wins = [
        r
        for r in rows
        if canonical_key(str(r.get("constructor_key") or ""), r.get("season")) == key
    ]

    winning_seasons = sorted({as_int(r.get("season")) for r in wins if r.get("season")})
    display = (
        canonical_display_name(key, wins[0].get("constructor_name") or constructor_id)
        if wins
        else canonical_display_name(key, constructor_id)
    )

    if not active_seasons and not wins:
        return unavailable(
            f"nothing is cached for constructor '{constructor_id}'; its season "
            "list is fetched the first time the genealogy page is opened"
        )

    return bundle(
        data={
            "constructor_id": constructor_id,
            "canonical_key": key,
            "name": display,
            "active_seasons": active_seasons,
            "active_seasons_available": bool(active_seasons),
            "wins": len(wins),
            "winning_seasons": winning_seasons,
            "first_win_season": winning_seasons[0] if winning_seasons else None,
            "last_win_season": winning_seasons[-1] if winning_seasons else None,
            "genealogy_note": (
                "active_seasons is the raw Ergast id's own list; wins are tallied "
                "over the canonical lineage, which merges chassis/engine-era ids "
                "such as team_lotus/lotus-ford. lotus_f1 is NOT part of the "
                "classic Lotus lineage — it is the Renault-descended 2012-15 team"
            ),
        },
        source=mongo_source("constructor_seasons_cache", constructor_id),
        docs=[cache_doc],
        ledger=ledger,
        tool="get_constructor_seasons",
        args={"constructor_id": constructor_id},
    )
