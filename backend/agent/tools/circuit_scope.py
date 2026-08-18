"""The "Ask about this circuit" tool — scoped retrieval over one circuit.

`ROADMAP.md` has carried this since Batch 11 as *"Ask about this circuit"
scoped chat (RAG over cached circuit history + Wikipedia extract)*, and
`CHAT-AGENT-PLAN.md` §13 folded it into the chat as a stretch checkpoint so it
would be **a tool in this agent rather than a second system**. This module is
that tool. It is not a second retrieval stack, it holds no index of its own,
and it obeys the same fact-bundle contract as its fifteen siblings.

## Why this is not Atlas Vector Search

The stretch item's stated premise was "Atlas is already the database, so the
RAG index adds no new infrastructure", with an explicit instruction to verify
the cluster tier first. Both halves were checked on **2026-08-18** and the
result is the opposite of the expected failure:

* **The database half passes.** A `vectorSearch` index was created on this
  cluster from the `mongodburi` credentials in `.env` alone — no Atlas Admin
  API key — and reached `status: READY, queryable: true` in about 25 seconds
  before being dropped again. The cluster runs 8.0.29 enterprise and
  `$listSearchIndexes` is served. Vector search is genuinely available here.
* **The inference half fails, and it is the half §4.2 said would decide
  everything.** Ollama Cloud's catalogue was listed live the same day
  (`GET https://ollama.com/api/tags`, a catalogue read, not inference): **19
  models, all chat/instruct, not one embedding model.** There is nothing on
  this project's only inference provider that can turn a question into a
  vector. Populating an Atlas vector index therefore needs either a second
  provider and a second key — which is exactly the "no new infrastructure"
  claim the item rested on, gone — or an embedding model inside the agent
  image, which is a torch-sized dependency in a `requirements-agent.txt` that
  deliberately excludes FastF1 to stay small.

And even granting a free embedding model, it would still be the wrong build
here, for a reason that has nothing to do with tiers: **there is no prose in
this corpus.** `circuit_history_cache` is 13 documents of five scalar fields,
`circuit_details` 27 of four, and everything `app/circuit_character.py`
computes is numeric. Vectors would mean synthesising sentences out of
structured rows, embedding them, and retrieving them *approximately* over 24
candidates that an exact `find` on `circuit_id` retrieves with perfect recall
and no model call at all. On a tier that allows one concurrent model and
meters GPU time, adding a per-query embedding call to the cheapest class of
question inverts §4.2, whose entire subject is getting from six model calls
per answer down to two.

So: the design that ships is exact structured retrieval, and the honest
one-line verdict is **"vector search is available and is still the wrong
tool"** rather than "the tier would not let us".

## What it actually adds

The retrieval that was missing was never "who has won here" — `get_circuit_
history` has answered that exactly, over the full 1950-present index, since
CP60. The gap was the *qualitative* question, "what makes Monaco hard to
overtake at?", which this app could not answer from data at all and which a
model will therefore answer from its weights, fluently and with no citation.

`app/circuit_character.py` measures it: Monaco produces **0.846 position
changes per racing lap against a 24-circuit median of 2.410**, the lowest in
the dataset. That is a retrieved, citable number where there was previously a
received opinion, and it is the entire point of the feature.

## Why `focus` is a model-visible argument

It is question-shaped, which is the standing test in `tests/test_agent_graph.py`
for whether an optional parameter belongs in the schema. The three focuses read
different collections and answer different questions — "is it hard to overtake
here" (lap-by-lap churn), "does it break cars" (classification outcomes), "how
many stops" (pit and safety-car data) — and only the asker knows which was
meant. Returning all three on every call would be the alternative, and it
triples a bundle for a question that wanted one third of it, against a plan
whose §5 context-budget rule is the thing that keeps this system affordable.

An unrecognised focus is a `reason`, not a guess: the failure names the valid
focuses *and* the sibling tool that owns what was probably wanted, so a model
that asks for `focus="winners"` is redirected to `get_circuit_history` instead
of being handed the nearest facts this tool happens to hold.
"""

from __future__ import annotations

from app.circuit_character import CACHE_COLLECTION, load_index

from ..ledger import EvidenceLedger
from .base import bundle, fact_tool, mongo_source, resolve_db, unavailable

# Each focus names the fields it lifts out of the cached circuit entry. Written
# as data rather than as branches so that adding a focus cannot accidentally
# widen an existing one, and so `VALID_FOCUSES` in the failure message can
# never drift from what the code actually accepts.
_FOCUS_FIELDS: dict[str, tuple[str, ...]] = {
    "overtaking": (
        "position_gains_per_lap",
        "rank_least_position_change",
        "raw_gains",
        "pit_excluded_gains",
        "racing_laps",
        "rounds_with_laps",
        "rounds_with_pit_data",
        "lap_data_seasons",
    ),
    "attrition": (),
    "strategy": (
        "safety_car_deployments",
        "rounds_with_race_control",
        "rounds_with_laps",
    ),
}

VALID_FOCUSES = tuple(sorted(_FOCUS_FIELDS))


async def _identity(db, circuit_id: str) -> tuple[dict | None, dict]:
    """The circuit's name, place and Wikipedia page, from the calendar.

    The Wikipedia URL is lifted straight off the stored `Circuit.url` rather
    than composed from the circuit name. That closes the "+ Wikipedia extract"
    half of the roadmap item without any new retrieval at all: `web_extract`
    already exists on `web-researcher`, and what it lacked was a *trustworthy*
    URL. A composed one ("https://en.wikipedia.org/wiki/" + name) silently
    resolves to a disambiguation page or a 404 for several circuits, which is
    how a model ends up extracting the wrong article and citing it
    confidently. This one came from the same Ergast record as the results.
    """
    docs = await db.races.find({"Circuit.circuitId": circuit_id}).to_list(length=200)
    if not docs:
        return None, {}
    newest = max(docs, key=lambda d: (d.get("season") or 0, d.get("date") or ""))
    circuit = newest.get("Circuit") or {}
    location = circuit.get("Location") or {}
    return newest, {
        "circuit_id": circuit_id,
        "circuit_name": circuit.get("circuitName"),
        "locality": location.get("locality"),
        "country": location.get("country"),
        "wikipedia_url": circuit.get("url"),
    }


@fact_tool("get_circuit_dossier")
async def get_circuit_dossier(
    circuit_id: str,
    focus: str = "overtaking",
    *,
    ledger: EvidenceLedger | None = None,
    db=None,
) -> dict:
    """Measured racing character of one circuit: overtaking, attrition or strategy.

    Answers "what makes Monaco hard to overtake at" with a number this app
    computed from its own cached laps, not with received wisdom. `focus` picks
    one of `overtaking`, `attrition`, `strategy`.

    Every focus carries the same `sample` block, and that is deliberate rather
    than repetition. The sample here is **thin** — 1 to 3 races per circuit,
    from 2024-2026 — and a comparative index quoted without its own n invites
    exactly the overclaim this repo keeps writing post-mortems about. The
    bundle states the race count, the seasons and a `confidence` note so an
    answer can hedge from the evidence rather than from the model's mood.

    **`winners` is deliberately not a focus.** A second, quieter win tally over
    the three seasons this app has lap data for, sitting next to
    `get_circuit_history`'s all-time tally over 1950-present, is the same class
    of trap as the Indy-500 merge that tool's docstring exists to prevent: two
    true numbers that mean different things, one question, and no way for a
    reader to tell which they were given. `get_circuit_history` owns winners
    and this tool redirects to it.
    """
    circuit_id = (circuit_id or "").strip().lower()
    if not circuit_id:
        return unavailable("no circuit id given")

    focus = (focus or "overtaking").strip().lower()
    if focus not in _FOCUS_FIELDS:
        return unavailable(
            f"'{focus}' is not a focus this tool measures; it takes one of "
            f"{', '.join(VALID_FOCUSES)}. For all-time winners and win tallies "
            "at this circuit call get_circuit_history; for layout, corner count "
            "and lap record call get_circuit_profile",
            valid_focuses=list(VALID_FOCUSES),
        )

    db = resolve_db(db)
    race_doc, identity = await _identity(db, circuit_id)
    if race_doc is None:
        return unavailable(f"'{circuit_id}' is not a circuit in the synced calendar")

    index = await load_index(db)
    entry = ((index or {}).get("circuits") or {}).get(circuit_id)
    if not entry:
        return unavailable(
            f"no race at {identity.get('circuit_name') or circuit_id} has lap or "
            "result data cached, so its racing character has not been measured; "
            "the circuit itself is in the calendar"
        )

    field = (index or {}).get("field") or {}
    results = entry.get("results") or {}

    data: dict = {
        **identity,
        "focus": focus,
        "sample": {
            "races_with_lap_data": entry.get("rounds_with_laps", 0),
            "races_with_results": results.get("races_sampled", 0),
            "seasons": entry.get("lap_data_seasons") or [],
            "confidence": (
                "this is a small sample — one to three races per circuit, from "
                "the seasons this app has synced. Report it as what these races "
                "measured, not as a settled property of the circuit"
            ),
        },
        "see_also": {
            "all_time_winners": "get_circuit_history",
            "layout_corners_lap_record": "get_circuit_profile",
            "the_wikipedia_page_for_this_circuit": identity.get("wikipedia_url"),
        },
    }

    if focus == "overtaking":
        for key in _FOCUS_FIELDS["overtaking"]:
            if key in entry:
                data[key] = entry[key]
        data["field_median_position_gains_per_lap"] = field.get(
            "median_position_gains_per_lap"
        )
        data["circuits_compared"] = field.get("circuits_with_lap_data")
        data["metric_definition"] = (
            "position_gains_per_lap counts every place a driver gained between "
            "one lap and the next, summed over the field and divided by the "
            "race distance, averaged over the races listed in `sample`. "
            "rank_least_position_change is 1 for the circuit with the LEAST "
            "position change"
        )
        data["metric_caveat"] = (
            "this is NOT an overtake count. A place gained can come from a "
            "pass, a retirement ahead, a pit cycle or a safety car. Gains on a "
            "pit in-lap or out-lap are already excluded where pit data exists "
            "(rounds_with_pit_data of rounds_with_laps); the rest is not "
            "separable from this data. Never call this number 'overtakes'"
        )
        data["grid_to_flag"] = {
            "mean_abs_grid_to_finish": results.get("mean_abs_grid_to_finish"),
            "median_places_gained": results.get("median_places_gained"),
            "drivers_who_gained_places": results.get("drivers_who_gained_places"),
            "drivers_compared": results.get("drivers_compared"),
            "winner_grid_slots": results.get("winner_grid_slots"),
            "pole_to_win": results.get("pole_to_win"),
            "note": (
                "grid-to-flag movement over the same races; it includes the "
                "start, which position_gains_per_lap deliberately does not"
            ),
        }

    elif focus == "attrition":
        if not results:
            return unavailable(
                f"no race results are cached for {identity.get('circuit_name')}, "
                "so retirements at this circuit cannot be counted"
            )
        data["outcomes"] = results.get("outcomes")
        data["retirement_rate"] = results.get("retirement_rate")
        data["entries"] = results.get("entries")
        data["finishers"] = results.get("finishers")
        data["metric_definition"] = (
            "outcomes are counted from each entry's positionText, which is the "
            "field that distinguishes a classified finisher from a retirement "
            "in this database; the status string does not, and disagrees with "
            "it on 15 of 801 stored rows"
        )

    else:  # strategy
        for key in _FOCUS_FIELDS["strategy"]:
            if key in entry:
                data[key] = entry[key]
        if "safety_car_deployments" not in data:
            data["safety_car_deployments"] = None
            data["safety_car_note"] = (
                "no race replay is cached for any round at this circuit, so "
                "safety-car deployments have not been counted here"
            )
        else:
            data["safety_car_note"] = (
                "counted from the cached race replay's distilled race-control "
                "events over `rounds_with_race_control` races; VSC and full "
                "safety car are both 'deployed' events and are not split"
            )
        data["stops_note"] = (
            "per-race pit-stop tables are not summarised here; for one race's "
            "stops and undercut/overcut resolution call get_race_strategy with "
            "that year and round"
        )

    return bundle(
        data=data,
        source=mongo_source(CACHE_COLLECTION, circuit_id, focus),
        docs=[index, race_doc],
        ledger=ledger,
        tool="get_circuit_dossier",
        args={"circuit_id": circuit_id, "focus": focus},
    )
