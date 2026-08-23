"""The internal F1 data tools — `CHAT-AGENT-PLAN.md` §5.1.

Every *fact* tool in this package obeys one contract, enforced in `base.py`
(`render_visual` is the single exception and says why in its own docstring —
it is a sink for the model's drawing code, not a source of facts):

    success  {"available": True, "data": {...}, "evidence_id": "ev_7",
              "source": "mongo:race_results/2026-14", "as_of": "..."}
    failure  {"available": False, "reason": "..."}

and three rules, each traceable to a post-mortem rather than to taste:

* **Pre-joined facts, never a raw document** (CP38 — a model handed correct raw
  rows invented a teammate relationship).
* **Never raises** — a tool failure must not abort an agent run that has
  already spent free-tier GPU time.
* **Never triggers a FastF1 fetch.** `livetiming.formula1.com` 403s datacenter
  IPs and fails *soft*, so a FastF1 path passes local testing and silently
  returns empty answers on Cloud Run. This package reuses the `app` modules'
  pure fact builders and reads their collections itself, never their endpoint
  functions. `app/driver_directory.py` exists so that reusing
  `strategy_commentary.build_facts` does not drag FastF1 in transitively —
  which in turn is what lets `requirements-agent.txt` leave FastF1 out
  entirely, making a fetch **impossible** rather than merely forbidden.

`TOOLS` is the registry CP61 binds. It is built by reading `tool_name` off each
function rather than by hand, so a tool cannot be listed under a name it does
not answer to.
"""

from __future__ import annotations

from .circuit_scope import get_circuit_dossier
from .circuits import get_circuit_history, get_circuit_profile
from .context import get_season_state, resolve_context
from .drivers import get_driver_profile, get_driver_season_summary, get_head_to_head
from .history import get_constructor_seasons, get_historical_race_index
from .race import (
    get_lap_summary,
    get_pit_stops,
    get_race_control,
    get_race_narrative_facts,
    get_race_strategy,
)
from .season import get_season_calendar, get_session_result, get_standings, get_weather
from .visual import render_visual

# §5.1's sixteen, plus the two utility tools from §5.3 that had to exist for
# them to be callable at all: `resolve_context` (which turns "the last race"
# into a round number) and `get_season_state` (which is the clock a model
# does not have) — and `get_circuit_dossier`, §13's "Ask about this circuit"
# stretch item, built as a seventeenth data tool rather than as the separate
# RAG system the roadmap first imagined (that module's docstring records why).
ALL_TOOLS = (
    get_season_calendar,
    get_session_result,
    get_standings,
    get_driver_profile,
    get_driver_season_summary,
    get_head_to_head,
    get_race_narrative_facts,
    get_race_strategy,
    get_race_control,
    get_lap_summary,
    get_pit_stops,
    get_weather,
    get_circuit_profile,
    get_circuit_history,
    get_circuit_dossier,
    get_historical_race_index,
    get_constructor_seasons,
    resolve_context,
    get_season_state,
    # The one member of this registry that is NOT a fact tool — it retrieves
    # nothing and appends nothing to the ledger. It is here because it is a
    # tool the model calls and therefore has to be bindable through the same
    # `TOOLS` registry `graph.py` reads; `tools/visual.py`'s docstring records
    # why `@fact_tool` was deliberately not applied to it. If you are auditing
    # this list for "what can an answer cite", this is the entry to skip.
    render_visual,
)

TOOLS = {fn.tool_name: fn for fn in ALL_TOOLS}

__all__ = ["ALL_TOOLS", "TOOLS", *sorted(TOOLS)]
