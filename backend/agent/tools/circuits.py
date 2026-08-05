"""Circuit-shaped tools: one circuit's profile, and its cross-era history.

`get_circuit_history` deliberately does **not** mirror
`circuit_history.get_circuit_history`, which answers from live circuit-scoped
Ergast calls. It aggregates `historical_race_index` instead — the collection
`historical_index.py` already normalises to one clean winner record per race
for 1950-present — and enriches from the `circuit_history_cache` document when
one exists. Two reasons, both worth stating:

* It is offline. The Ergast path is two paginated fetches per circuit inside
  an agent turn, and the collection is right there.
* It carries `historical_index`'s five data corrections with it, which the raw
  Ergast path does not. Most relevantly the **Indianapolis 500** flag: the
  1950-60 Indy 500 counted for the World Championship, so four American
  roadster builders appear as "race winners" having never entered a Grand
  Prix. An answer to "who has won most often at Indianapolis" that silently
  merges those with the 2000-07 United States Grand Prix is wrong, and this
  bundle separates them so it cannot.
"""

from __future__ import annotations

from ..ledger import EvidenceLedger
from .base import bundle, fact_tool, mongo_source, resolve_db, unavailable


async def _latest_race_for_circuit(db, circuit_id: str) -> dict | None:
    """Any `races` document for this circuit, preferring the most recent.

    `circuitId` is stable across a circuit's whole history (the same
    assumption `circuit_history._resolve_circuit_id` makes), so any round
    resolves the name and location; the newest is preferred only so the
    reported layout is the current one.
    """
    docs = await db.races.find({"Circuit.circuitId": circuit_id}).to_list(length=200)
    if not docs:
        return None
    return max(docs, key=lambda d: (d.get("season") or 0, d.get("date") or ""))


@fact_tool("get_circuit_profile")
async def get_circuit_profile(
    circuit_id: str, *, ledger: EvidenceLedger | None = None, db=None
) -> dict:
    """Location, lap count, corner count and lap record for one circuit.

    §5.1 lists "layout, length, corners, elevation" for this tool. Two of those
    are not held anywhere this can reach, and are returned as explicit nulls
    with a stated reason rather than omitted:

    * **Length and race distance** are not in `circuit_details` at all —
      `data_sync._build_circuit_detail` says so directly, because FastF1's
      Event object does not carry them.
    * **Elevation** lives only in the 3D track-geometry payload, which is a
      JSON object in a GCS bucket rather than in Mongo. Fetching it would be a
      cross-service HTTP call per question. What *is* reported is whether that
      payload has been built, so an answer can honestly say the data exists and
      where, instead of implying nothing is known.

    `circuit_info.get_circuit_info` is not called: its cache miss loads a live
    FastF1 session, which is the exact path that works locally and returns
    nothing on Cloud Run.
    """
    circuit_id = (circuit_id or "").strip().lower()
    if not circuit_id:
        return unavailable("no circuit id given")

    db = resolve_db(db)
    race_doc = await _latest_race_for_circuit(db, circuit_id)
    if not race_doc:
        return unavailable(f"'{circuit_id}' is not a circuit in the synced calendar")

    circuit = race_doc.get("Circuit") or {}
    location = circuit.get("Location") or {}
    circuit_name = circuit.get("circuitName") or ""

    detail_doc = await db.circuit_details.find_one({"circuit_name": circuit_name})
    track = (detail_doc or {}).get("track_information") or {}

    build_doc = await db.track_geometry_builds.find_one({"_id": circuit_id})
    geometry_status = (build_doc or {}).get("status")

    return bundle(
        data={
            "circuit_id": circuit_id,
            "circuit_name": circuit_name,
            "locality": location.get("locality"),
            "country": location.get("country"),
            "latitude": location.get("lat"),
            "longitude": location.get("long"),
            "most_recent_race": {
                "season": race_doc.get("season"),
                "round": race_doc.get("round"),
                "race_name": race_doc.get("raceName"),
                "date": race_doc.get("date"),
            },
            "first_grand_prix": track.get("first_grand_prix"),
            "race_laps": track.get("number_of_laps"),
            "corners": track.get("number_of_corners"),
            "lap_record": track.get("lap_record"),
            "length_km": None,
            "elevation_change_m": None,
            "not_held": (
                "circuit length and elevation change are not stored by this app; "
                "elevation exists only inside the 3D track-geometry payload"
            ),
            "track_geometry_built": geometry_status == "done",
            "track_geometry_status": geometry_status,
        },
        source=mongo_source("circuit_details", circuit_id),
        docs=[race_doc, detail_doc, build_doc],
        ledger=ledger,
        tool="get_circuit_profile",
        args={"circuit_id": circuit_id},
    )


@fact_tool("get_circuit_history")
async def get_circuit_history(
    circuit_id: str,
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Winners, era span and win tallies across a circuit's whole history.

    Tallies are computed here, not left to the model: "who has the most Monaco
    wins ever" is a count over ~70 rows, and CP38's rule 3 exists because a
    model asked to count will sometimes get it wrong and always sound certain.

    Indy-500 wins are reported as their own tally alongside the Grand Prix one
    rather than merged into it — see the module docstring.
    """
    circuit_id = (circuit_id or "").strip().lower()
    if not circuit_id:
        return unavailable("no circuit id given")

    db = resolve_db(db)
    races = await db.historical_race_index.find({"circuit_id": circuit_id}).to_list(
        length=None
    )
    if not races:
        return unavailable(
            f"no races at '{circuit_id}' are in the historical index; it is "
            "seeded by the history sync"
        )

    races.sort(key=lambda r: (r.get("season") or 0, r.get("round") or 0))
    grand_prix = [r for r in races if not r.get("indy500")]
    indy = [r for r in races if r.get("indy500")]

    def _tally(rows: list[dict], field: str) -> list[dict]:
        counts: dict[str, int] = {}
        for row in rows:
            key = row.get(field)
            if key:
                counts[key] = counts.get(key, 0) + 1
        return [
            {"name": name, "wins": wins}
            for name, wins in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    seasons = [r.get("season") for r in races if r.get("season")]
    race_doc = await _latest_race_for_circuit(db, circuit_id)
    circuit_name = ((race_doc or {}).get("Circuit") or {}).get("circuitName") or ""

    # The Ergast-sourced cache is the only place a closest-finish gap lives;
    # the historical index carries winners only, not runner-up gaps.
    cache_doc = (
        await db.circuit_history_cache.find_one({"circuit_name": circuit_name})
        if circuit_name
        else None
    )

    return bundle(
        data={
            "circuit_id": circuit_id,
            "circuit_name": circuit_name or None,
            "races_held": len(races),
            "first_season": min(seasons) if seasons else None,
            "last_season": max(seasons) if seasons else None,
            "grand_prix_wins_by_driver": _tally(grand_prix, "driver")[:10],
            "grand_prix_wins_by_constructor": _tally(grand_prix, "constructor_name")[:10],
            "indy500_rounds": len(indy),
            "indy500_wins_by_driver": _tally(indy, "driver")[:10],
            "indy500_note": (
                "the 1950-60 Indianapolis 500 counted for the World Championship "
                "but was not a Grand Prix; its winners are tallied separately and "
                "must never be presented as Grand Prix wins"
            ),
            "closest_finish": (cache_doc or {}).get("closest_finish"),
            "tallies_cover": "race winners only; podiums and entries are not in this index",
        },
        source=mongo_source("historical_race_index", circuit_id),
        docs=[cache_doc, race_doc],
        ledger=ledger,
        tool="get_circuit_history",
        args={"circuit_id": circuit_id},
    )
