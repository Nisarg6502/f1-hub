"""How a stored classification is presented.

Kept free of FastF1 and pandas on purpose: `session_recap` uses it, and the
agent imports `session_recap`, and `requirements-agent.txt` leaves FastF1 out
(see `agent/tools/__init__.py`).
"""


def _text(value) -> str:
    return "" if value is None else str(value).strip()


# Statuses of a car that took the chequered flag, in either vocabulary: classic
# Ergast writes "+1 Lap"/"+2 Laps", Jolpica's 2024+ feed writes "Lapped".
_FLAG_STATUSES = ("finished", "lapped", "+")


def mark_lapped_finishers(results: list[dict]) -> list[dict]:
    """Race or sprint rows with every lapped finisher stated as laps down.

    **A lapped car's `Time` is not a gap to the winner.** Classic Ergast left
    `Time` empty for a car a lap or more down and wrote "+1 Lap" in `status`,
    so "the time if there is one, else the status" was a safe way to show an
    interval. Jolpica's current feed does neither: a lapped car's status is
    the bare word "Lapped" and its `Time.time` is filled with the moment it
    crossed the line after the winner. In 2026 Singapore that put Gasly at
    "+2.171", one lap down; Bottas, three laps down, at "+17.347". Every
    consumer reading `Time.time` as an interval (the results tables, the AI
    recap's `gap_to_leader`, the agent) showed a car laps down as seconds
    behind.

    Restated here, once, the way the official classification does: status
    "+N Lap(s)" from the lap count against the winner's, and `Time.time`
    blanked so nothing can read it as an interval (`millis` is kept).

    A presentation of the stored rows, not a rewrite of them: the sync stores
    Ergast's rows verbatim so they can be compared against Ergast on every run.
    A no-op for rows without `laps` (qualifying, practice) and for retirements,
    whose shorter distance is what their status already explains.
    """
    rows = [dict(row) for row in (results or [])]
    winner = next((row for row in rows if _text(row.get("position")) == "1"), None)
    try:
        winner_laps = int(_text((winner or {}).get("laps")))
    except ValueError:
        return rows

    for row in rows:
        status = _text(row.get("status")).lower()
        if not status.startswith(_FLAG_STATUSES):
            continue
        # Only a classified car took the flag. Jolpica has a few rows that
        # are "Lapped" yet unclassified (positionText "R": 2026 R1 Stroll on
        # 43 of 58 laps); "+15 Laps" would present that as a finish.
        if not _text(row.get("positionText") or row.get("position")).isdigit():
            continue
        try:
            down = winner_laps - int(_text(row.get("laps")))
        except ValueError:
            continue
        if down <= 0:
            continue
        row["status"] = f"+{down} Lap" + ("s" if down > 1 else "")
        if isinstance(row.get("Time"), dict):
            row["Time"] = {**row["Time"], "time": ""}
    return rows
