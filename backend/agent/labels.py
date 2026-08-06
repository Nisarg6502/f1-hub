"""Friendly, present-tense labels for the activity timeline and for CP68's
human-readable citation titles.

Extracted out of `agent/graph.py` in CP68 rather than left there, because
`agent/ledger.py` needs `activity_label()` too (a citation's title is just
the label of the tool that produced it — see `ledger.Evidence.citation()`),
and `ledger.py`'s own docstring requires it stay importable with no
LangChain/LangGraph dependency at all. This module has none — it is a pair
of plain string dicts and a plain function, exactly what both `graph.py`
(which does depend on LangChain) and `ledger.py` (which must not) can both
safely import.

Anything not listed in `ACTIVITY_LABELS` still works — it falls back to a
generic label built from the tool's own name — so a future tool never goes
unlabelled just because this dict was not updated in lockstep.
"""

from __future__ import annotations

ACTIVITY_LABELS: dict[str, str] = {
    "get_season_calendar": "Reading the season calendar",
    "get_session_result": "Reading the session classification",
    "get_standings": "Reading the championship standings",
    "get_driver_profile": "Reading the driver's profile",
    "get_driver_season_summary": "Reading the driver's season",
    "get_head_to_head": "Comparing the two drivers",
    "get_race_narrative_facts": "Reading the race narrative",
    "get_race_strategy": "Reading the race strategy",
    "get_race_control": "Reading race control",
    "get_lap_summary": "Reading the lap summary",
    "get_pit_stops": "Reading the pit stops",
    "get_weather": "Reading the weather",
    "get_circuit_profile": "Reading the circuit profile",
    "get_circuit_history": "Reading the circuit history",
    "get_historical_race_index": "Searching the historical archive",
    "get_constructor_seasons": "Reading the constructor's seasons",
    "resolve_context": "Working out what you mean",
    "get_season_state": "Checking today's date and the season state",
    "web_search": "Searching the web",
    "web_extract": "Reading a web page",
    "wikipedia_summary": "Reading a Wikipedia summary",
}

SUBAGENT_ACTIVITY_LABELS: dict[str, str] = {
    "stats-scout": "Reading current F1 data",
    "historian": "Searching the historical archive",
    "web-researcher": "Researching the web",
    "race-analyst": "Analysing the race",
}


def activity_label(tool_name: str, *, subagent_type: str | None = None) -> str:
    if tool_name == "task" and subagent_type:
        return SUBAGENT_ACTIVITY_LABELS.get(
            subagent_type, f"Delegating to {subagent_type}"
        )
    return ACTIVITY_LABELS.get(tool_name, f"Running {tool_name}…")
