"""The car-number <-> driver-id bridge, in a module with no heavy imports.

These two functions were born in `race_replay.py` (see that module's docstring
for the join they solve: `race_laps`/`race_stints` key a driver by
`driver_number`, `pit_stops` keys by `driver_id`, and the two namespaces have
no overlap, so a join written without noticing produces zero pit markers with
no error). `strategy_commentary.py` then imported them from there rather than
re-deriving a join with a silent failure mode.

They live here now because *where* they are imported from has a consequence
`race_replay` cannot avoid: `race_replay` imports `race_laps`, which imports
`fastf1`, which drags in pandas/numpy. That is fine for `f1-backend`, which
needs FastF1 anyway. It is not fine for the `f1-agent` service, whose tool
layer reuses `strategy_commentary.build_facts` and whose whole safety argument
is that it can **never** trigger a FastF1 fetch — `livetiming.formula1.com`
403s datacenter IPs and fails soft, so a FastF1 call in production returns
empty data with no error while working perfectly in local testing.

Keeping FastF1 out of `requirements-agent.txt` turns that rule from a
convention into a guarantee: the library is not installed in the agent image,
so a FastF1 fetch is impossible rather than merely forbidden. Moving twenty
lines of pure dictionary work into their own module is what buys that.

Both `race_replay` and `strategy_commentary` re-export these names, so every
existing caller and test keeps working unchanged.
"""


def _driver_directory(results: list[dict]) -> dict[str, dict]:
    """Static per-driver identity, keyed by car number as a string.

    Keyed by number because that is what the per-lap rows carry; `driver_id` is
    kept on each entry so pit stops can be mapped onto the same key. Emitted
    once per driver rather than repeated on all ~50 of their lap rows.
    """
    directory: dict[str, dict] = {}
    for row in results:
        number = str(row.get("number") or "").strip()
        driver = row.get("Driver") or {}
        if not number:
            continue
        directory[number] = {
            "number": number,
            "driver_id": driver.get("driverId"),
            "code": driver.get("code"),
            "name": f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip(),
            "team": (row.get("Constructor") or {}).get("name"),
            "grid": row.get("grid"),
            "finish_position": row.get("position"),
            "finish_status": row.get("status"),
        }
    return directory


def _number_by_driver_id(directory: dict[str, dict]) -> dict[str, str]:
    """The `driver_id` -> car-number bridge that makes pit stops joinable."""
    return {
        entry["driver_id"]: number
        for number, entry in directory.items()
        if entry.get("driver_id")
    }
