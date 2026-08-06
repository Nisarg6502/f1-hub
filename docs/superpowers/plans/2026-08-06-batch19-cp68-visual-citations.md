# CP68 — Visual Citations, Narration, Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three concrete citation defects named in `BATCH-19-PLAN.md` §3 (raw machine-string labels, dead `[ev_N]` text, raw ISO timestamps) and enrich the activity timeline to say what a tool searched for and distinguish a tool step from a subagent delegation.

**Architecture:** Backend enrichment is additive-only (new optional fields on the existing `citation`/`activity` shapes). Frontend adds a markdown-link-rewrite trick (turn `[ev_N]` into a real markdown link the existing `ReactMarkdown` already renders, no new remark plugin or dependency) plus two new small components (`CitationPill` via the `a` override, `SourceCard`). Timestamps reuse the app's own existing `frontend/src/components/local-datetime.tsx` — do not build a second one.

**Tech Stack:** Python 3.11 backend (`unittest`), Next.js/React frontend (`react-markdown`, already a dependency — no new package).

## Global Constraints

- **Additive wire changes only.** `sse.py`'s `activity`/`sources`/`done` shapes gain optional fields; no existing field changes meaning or is removed. `backend/tests/test_agent_sse.py` and `frontend/src/lib/agent-api.ts`'s types must both stay in sync — this exact class of drift was a finding in CP67's final review, do not repeat it.
- **`agent/ledger.py` stays framework-free.** Its own docstring states this explicitly ("framework-free on purpose... a checker needs something concrete to check against... importing LangGraph here would make the tool layer untestable without the agent stack"). Do not import anything from `agent/graph.py` (which imports `langchain_core`/`langgraph`) into `ledger.py`. This is why Task 1 extracts the label-mapping logic into a new, dependency-free module both `graph.py` and `ledger.py` can import.
- **No new frontend dependency.** `react-markdown` already renders markdown links via its `a` component override; the citation-pill mechanism in Task 4 is built on that, not a custom remark plugin, specifically to avoid adding `unist-util-visit` or similar for something a link-rewrite already solves.
- **Streaming-safety is structural, not logic you write.** A regex requiring the closing `]` (`\[ev_(\d+)\]`) simply does not match a partial `[ev_` at a stream boundary — it stays literal text until the full marker arrives, then converts. Do not add extra buffering/debouncing logic to achieve this; the regex's own anchoring already provides it. Verify this with a test that feeds a split-across-chunks marker and confirms no garbled output at either the partial or complete stage.
- **`python -m unittest discover tests` from `backend/` must stay green.** Baseline going in: 762 passing, 3 skipped (CP67's final state).
- **`npm run build && npm run lint` from `frontend/` must stay green** for every frontend task.
- Follow this codebase's existing docstring convention (why a module exists, what past defect it fixes) in every new/changed module.

---

## File Structure

New:
- `backend/agent/labels.py` — extracted from `graph.py`: `ACTIVITY_LABELS`, `SUBAGENT_ACTIVITY_LABELS`, `activity_label()`. Zero LangChain/LangGraph imports.
- `backend/tests/test_agent_labels.py` — tests for the extracted module (mirrors what was implicitly tested via `graph.py` before).
- `frontend/src/components/citation-pill.tsx` — the `a`-override component rendering a numbered pill for a `#cite-ev_N` href, a plain link otherwise.
- `frontend/src/components/source-card.tsx` — replaces the bare `<li>` chip list with a real card per source (icon by kind, human title, relative timestamp via `LocalDateTime`, real link for web sources).

Modified:
- `backend/agent/ledger.py` — `Evidence` gains `kind` (derived) and citation gains a human `title` (via `agent/labels.py`); `citation()`'s returned shape gains `kind`, `title`, `n`.
- `backend/agent/graph.py` — imports `ACTIVITY_LABELS`/`SUBAGENT_ACTIVITY_LABELS`/`activity_label` from `agent/labels.py` instead of defining them; `_run_turn`'s `on_tool_start`/`on_tool_end` handling extracts a `detail` string (what the tool is doing, e.g. the search query) and a `kind` (`"tool"|"agent"`) and passes both through the `AgentEvent` tuple.
- `backend/agent/sse.py` — `activity()` gains optional `detail`, `kind`, `at` fields.
- `backend/agent/main.py` — forwards the new `AgentEvent` fields into `sse.activity(...)`.
- `frontend/src/lib/agent-api.ts` — `AgentSource` gains `kind`/`title`/`n`; `AgentHandlers.onActivity` signature gains `detail`/`kind`; `ActivityEntry`-equivalent parsing updated.
- `frontend/src/components/pitwall-assistant-panel.tsx` — `MessageBubble` uses a citation-rewriting helper before handing text to `ReactMarkdown`, registers `CitationPill` as the `a` component; sources list renders `SourceCard` instead of the bare chip `<li>`; `ActivityTimeline` renders a distinct icon/style for `kind === "agent"` vs `"tool"`; message send time renders via `LocalDateTime`.

---

## Task 1: Extract activity labels into a framework-free module

**Files:**
- Create: `backend/agent/labels.py`
- Create: `backend/tests/test_agent_labels.py`
- Modify: `backend/agent/graph.py:66-113` (delete the two dicts and `activity_label`, import from `labels` instead)

**Interfaces:**
- Produces: `labels.ACTIVITY_LABELS: dict[str, str]`, `labels.SUBAGENT_ACTIVITY_LABELS: dict[str, str]`, `labels.activity_label(tool_name: str, *, subagent_type: str | None = None) -> str` — identical names/signatures to what `graph.py` currently defines, so every existing caller (`graph.py`'s own `_run_turn`) just changes its import, not its call sites.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_agent_labels.py
"""Tests for `agent/labels.py` — CP68's extraction of CP63's activity-label
mapping out of `graph.py`.

This module has zero LangChain/LangGraph imports, unlike `graph.py`, because
`agent/ledger.py` needs to reuse `activity_label()` for CP68's human-readable
citation titles and `ledger.py`'s own docstring is explicit that it must stay
framework-free — importing `graph.py` from `ledger.py` would pull the whole
LangGraph dependency chain into a module whose entire design point is to be
unit-testable without it.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import labels


class ActivityLabelTests(unittest.TestCase):
    def test_known_tool_gets_its_friendly_label(self):
        self.assertEqual(labels.activity_label("web_search"), "Searching the web")

    def test_unknown_tool_falls_back_to_a_generic_label(self):
        self.assertEqual(labels.activity_label("some_future_tool"), "Running some_future_tool…")

    def test_task_tool_with_subagent_type_uses_the_subagent_label(self):
        self.assertEqual(
            labels.activity_label("task", subagent_type="web-researcher"),
            "Researching the web",
        )

    def test_task_tool_with_unknown_subagent_type_falls_back(self):
        self.assertEqual(
            labels.activity_label("task", subagent_type="some-future-agent"),
            "Delegating to some-future-agent",
        )

    def test_module_has_no_langchain_import(self):
        # Structural guarantee, not just a style preference — see module
        # docstring. Import failure here would mean this module pulled in
        # LangChain/LangGraph transitively, breaking `ledger.py`'s
        # framework-free contract the moment it imports `labels`.
        import sys as _sys

        before = set(_sys.modules)
        import importlib

        importlib.reload(labels)
        after = set(_sys.modules)
        newly_imported = after - before
        self.assertFalse(
            any("langchain" in m or "langgraph" in m for m in newly_imported),
            f"agent.labels pulled in a LangChain/LangGraph module: {newly_imported}",
        )
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m unittest tests.test_agent_labels -v`
Expected: `ModuleNotFoundError: No module named 'agent.labels'`

- [ ] **Step 3: Create `agent/labels.py`**

Move the two dicts and the function verbatim out of `backend/agent/graph.py` (currently lines 66-113 — read the exact current content before copying, the line numbers may have shifted slightly since CP67 landed) into a new file:

```python
# backend/agent/labels.py
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
```

- [ ] **Step 4: Update `graph.py` to import from the new module**

In `backend/agent/graph.py`, delete the `ACTIVITY_LABELS`, `SUBAGENT_ACTIVITY_LABELS` dicts and the `activity_label` function (and their surrounding comment block), and add near the top imports:

```python
from .labels import ACTIVITY_LABELS, SUBAGENT_ACTIVITY_LABELS, activity_label
```

Every existing call site in `graph.py` (`_run_turn`'s `on_tool_start`/`on_tool_end` handling) calls `activity_label(...)` exactly as before — no call-site changes needed, only the import line.

- [ ] **Step 5: Run to verify the new test passes and nothing broke**

Run: `cd backend && python -m unittest tests.test_agent_labels tests.test_agent_graph -v`
Expected: all PASS

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && python -m unittest discover tests`
Expected: all PASS, same 762+ baseline (this task adds 5 new tests, no existing behavior changes).

- [ ] **Step 7: Commit**

```bash
git add backend/agent/labels.py backend/agent/graph.py backend/tests/test_agent_labels.py
git commit -m "refactor(agent): CP68 extract activity labels into framework-free labels.py"
```

---

## Task 2: Citations gain a human title and a kind

**Files:**
- Modify: `backend/agent/ledger.py` (`Evidence.citation()`)
- Modify: `backend/tests/test_agent_ledger.py`

**Interfaces:**
- Consumes: `labels.activity_label` (Task 1).
- Produces: `Evidence.citation()` now returns `{"id", "n", "kind", "label", "title", "url", "as_of"}` — additive to the existing `{"id", "label", "url", "as_of"}` shape (`label` and `url` keep their exact current meaning and values; nothing existing is removed or renamed, per Global Constraints).

**Design note, read before writing code:** `agent/tools/base.py`'s `mongo_source()` docstring currently says the raw `mongo:collection/tail` string "is rendered to the user as a source chip... deliberately readable." That was CP60's original design intent, and this task changes that decision — the raw string stays in the `label` field (untouched, for debugging/citation-string identity) but the UI-facing text moves to the new `title` field, human-readable via `activity_label`. State this plainly in `ledger.py`'s updated docstring as a deliberate revision of that earlier decision, not a silent contradiction of it.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_agent_ledger.py` (read the file's current structure first, follow its existing class/style conventions):

```python
class CitationShapeTests(unittest.TestCase):
    def test_citation_gains_a_human_title_from_the_tool_name(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="mongo:race_results/2026-14",
            data={"winner": "Norris"},
            tool="get_session_result",
        )
        citation = entry.citation()
        self.assertEqual(citation["title"], "Reading the session classification")
        # `label` keeps its existing raw value — additive, not a rename.
        self.assertEqual(citation["label"], "mongo:race_results/2026-14")

    def test_citation_without_a_tool_falls_back_to_the_raw_source_as_title(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="mongo:race_results/2026-14", data={})
        citation = entry.citation()
        self.assertEqual(citation["title"], "mongo:race_results/2026-14")

    def test_citation_kind_is_data_for_a_mongo_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="mongo:race_results/2026-14", data={})
        self.assertEqual(entry.citation()["kind"], "data")

    def test_citation_kind_is_wikipedia_for_a_wikipedia_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="web:wikipedia/Ayrton Senna", data={})
        self.assertEqual(entry.citation()["kind"], "wikipedia")

    def test_citation_kind_is_web_for_any_other_web_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="web:tavily-search/2027 regulations", data={})
        self.assertEqual(entry.citation()["kind"], "web")

    def test_citation_n_is_the_numeric_suffix_of_the_evidence_id(self):
        ledger = EvidenceLedger()
        ledger.append(source="s", data={})
        second = ledger.append(source="s", data={})
        self.assertEqual(second.citation()["n"], 2)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m unittest tests.test_agent_ledger -v`
Expected: `KeyError: 'title'` (or similar) on the new assertions.

- [ ] **Step 3: Implement**

In `backend/agent/ledger.py`, add the import and rewrite `citation()`:

```python
from .labels import activity_label
```

```python
    def citation(self) -> dict:
        """The shape `sse.sources()` renders as a source card under the answer.

        `label` keeps its original raw `source` string (e.g.
        `mongo:race_results/2026-14`) for identity/debugging — CP60's
        `mongo_source()` docstring called this "deliberately readable," which
        was true for a developer but not for the end user CP68 is fixing this
        for. `title` is the new user-facing text: `activity_label(self.tool)`
        when a tool produced this entry (the overwhelming majority — every
        internal and web tool passes `tool=`), falling back to the raw
        `source` only for the rare hand-built entry with no `tool` at all.

        `kind` is derived from `source`'s own prefix convention
        (`agent/tools/base.py`'s `mongo_source`/web tools already establish
        `mongo:`/`web:` prefixes) rather than stored separately, so it can
        never drift out of sync with the string it describes.

        `n` is the evidence id's own numeric suffix, exposed directly so the
        frontend never needs to parse `ev_N` itself.
        """
        title = activity_label(self.tool) if self.tool else self.source
        if self.source.startswith("web:wikipedia/"):
            kind = "wikipedia"
        elif self.source.startswith("web:"):
            kind = "web"
        else:
            kind = "data"
        n = int(self.evidence_id.rsplit("_", 1)[-1]) if "_" in self.evidence_id else 0
        return {
            "id": self.evidence_id,
            "n": n,
            "kind": kind,
            "label": self.source,
            "title": title,
            "url": None,
            "as_of": self.as_of,
        }
```

- [ ] **Step 4: Run to verify tests pass**

Run: `cd backend && python -m unittest tests.test_agent_ledger -v`
Expected: all PASS

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && python -m unittest discover tests`
Expected: all PASS. Pay attention to any existing test asserting the exact shape of `ledger.citations()`/`entry.citation()` (e.g. in `test_agent_verifier.py`, `test_agent_golden_set.py`, or `test_agent_chat.py`) — if any existing test does an exact-dict-equality comparison against the OLD 4-key shape, that test needs updating to the new additive shape (this is expected, not a regression, since the shape genuinely grew) — if you find one and are unsure whether it's expected, report it rather than silently changing the assertion's intent.

- [ ] **Step 6: Commit**

```bash
git add backend/agent/ledger.py backend/tests/test_agent_ledger.py
git commit -m "feat(agent): CP68 citations gain a human title and a kind"
```

---

## Task 3: Activity events gain detail, kind, and a timestamp

**Files:**
- Modify: `backend/agent/sse.py` (`activity()`)
- Modify: `backend/tests/test_agent_sse.py`
- Modify: `backend/agent/graph.py` (`_run_turn`, `AgentEvent`)
- Modify: `backend/agent/main.py` (`_stream`'s activity-event forwarding)
- Modify: `backend/tests/test_agent_graph.py`

**Interfaces:**
- Produces: `sse.activity(label, state="start", *, detail=None, kind="tool", at=None) -> str`, emitting `{"label", "state", "detail", "kind", "at"}` — `detail`/`kind`/`at` are always present now (not optional-omitted), since every call site can supply them and an always-present shape is simpler for the frontend to parse than a sometimes-present one. Existing tests calling `sse.activity(label, state)` positionally keep working unchanged since the new params are keyword-only with defaults.
- `AgentEvent`'s `"activity"` tuple grows from `("activity", label, state)` to `("activity", label, state, detail, kind)` — every yield site and consumer in `graph.py`/`main.py` must be updated together, in the same commit, since this is an internal tuple contract with no independent versioning (unlike the SSE wire format, which stays additive).

- [ ] **Step 1: Write the failing SSE test**

Add to `backend/tests/test_agent_sse.py`:

```python
    def test_activity_includes_detail_kind_and_timestamp(self):
        raw = sse.activity(
            "Searching the web", "start", detail="2027 engine regulations", kind="tool", at="2026-08-06T10:00:00+00:00"
        )
        payload = json.loads(raw.split("data: ", 1)[1].strip())
        self.assertEqual(payload["detail"], "2027 engine regulations")
        self.assertEqual(payload["kind"], "tool")
        self.assertEqual(payload["at"], "2026-08-06T10:00:00+00:00")

    def test_activity_defaults_when_detail_and_kind_are_omitted(self):
        raw = sse.activity("Thinking…", "start")
        payload = json.loads(raw.split("data: ", 1)[1].strip())
        self.assertIsNone(payload["detail"])
        self.assertEqual(payload["kind"], "tool")
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m unittest tests.test_agent_sse -v`
Expected: `KeyError: 'detail'`

- [ ] **Step 3: Update `sse.py`**

```python
def activity(
    label: str,
    state: str = "start",
    *,
    detail: str | None = None,
    kind: str = "tool",
    at: str | None = None,
) -> str:
    return frame(
        "activity",
        {"label": label, "state": state, "detail": detail, "kind": kind, "at": at},
    )
```

Update the module docstring's `activity` event description (near the top of the file) to document the three new fields, matching this file's existing per-field documentation density.

- [ ] **Step 4: Run to verify the SSE tests pass**

Run: `cd backend && python -m unittest tests.test_agent_sse -v`

- [ ] **Step 5: Extend `_run_turn` in `graph.py` to compute and yield `detail`/`kind`**

Read `backend/agent/graph.py`'s current `_run_turn` function in full first (the `on_tool_start`/`on_tool_end` branches). Add a small helper above it:

```python
import datetime

# Tools whose single most-useful argument is worth surfacing verbatim in the
# activity timeline — CP68's answer to "say what it's searching for", scoped
# to the tools where a human-legible detail actually exists in the call
# arguments. Internal data tools (season/round/driver ids) are left
# unlabelled here rather than surfaced as raw ids a user cannot read.
_DETAIL_ARG: dict[str, str] = {
    "web_search": "query",
    "web_extract": "urls",
    "wikipedia_summary": "title",
    "resolve_context": "query",
}


def _activity_detail(tool_name: str, tool_input: dict) -> str | None:
    arg_name = _DETAIL_ARG.get(tool_name)
    if not arg_name:
        return None
    value = tool_input.get(arg_name)
    if isinstance(value, list):
        value = ", ".join(str(v) for v in value)
    if not value:
        return None
    text = str(value)
    return text if len(text) <= 80 else text[:77] + "…"
```

Change the `on_tool_start`/`on_tool_end` branches in `_run_turn` from:

```python
        elif kind == "on_tool_start" and name:
            subagent_type = ((event.get("data") or {}).get("input") or {}).get("subagent_type")
            yield ("activity", activity_label(name, subagent_type=subagent_type), "start")

        elif kind == "on_tool_end" and name:
            subagent_type = ((event.get("data") or {}).get("input") or {}).get("subagent_type")
            yield ("activity", activity_label(name, subagent_type=subagent_type), "done")
```

to:

```python
        elif kind == "on_tool_start" and name:
            tool_input = (event.get("data") or {}).get("input") or {}
            subagent_type = tool_input.get("subagent_type")
            activity_kind = "agent" if name == "task" and subagent_type else "tool"
            yield (
                "activity",
                activity_label(name, subagent_type=subagent_type),
                "start",
                _activity_detail(name, tool_input),
                activity_kind,
            )

        elif kind == "on_tool_end" and name:
            tool_input = (event.get("data") or {}).get("input") or {}
            subagent_type = tool_input.get("subagent_type")
            activity_kind = "agent" if name == "task" and subagent_type else "tool"
            yield (
                "activity",
                activity_label(name, subagent_type=subagent_type),
                "done",
                _activity_detail(name, tool_input),
                activity_kind,
            )
```

Every OTHER `yield ("activity", ...)` call site in `graph.py`/`main.py` (the queue-wait messages, "Thinking…", "Answered from cache", the echo-mode notice) is a 3-tuple `("activity", label, state)`, not a 5-tuple — these represent `kind="system"` (not a tool, not an agent). Rather than changing every one of those call sites' tuple shape, update `main.py`'s event-unpacking (Step 6 below) to accept BOTH a 3-tuple and a 5-tuple for the `"activity"` kind, defaulting `detail=None, kind="system"` when only 3 elements are present. This is deliberately the simplest correct option — do not go back and touch every system-message call site just to pad them to 5-tuples.

- [ ] **Step 6: Update `main.py`'s `_stream` to forward the new fields**

Find the block in `_stream` that currently does:

```python
                        elif kind == "activity":
                            _, label, state = event
                            yield sse.activity(label, state)
```

Change it to:

```python
                        elif kind == "activity":
                            if len(event) == 5:
                                _, label, state, detail, activity_kind = event
                            else:
                                _, label, state = event
                                detail, activity_kind = None, "system"
                            yield sse.activity(
                                label, state, detail=detail, kind=activity_kind,
                                at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            )
```

Add `import datetime` to `main.py`'s existing import block if not already present.

- [ ] **Step 7: Write a regression test in `test_agent_graph.py`**

Read the file's existing mock-agent fixture (the same `_ScriptedAgent` pattern CP67's Task 6 used) and add a test confirming a `web_search` tool call yields an activity event whose `detail` matches the search query passed in the tool's input, and `kind == "tool"`; and confirming a `task` tool call with a `subagent_type` yields `kind == "agent"`. Follow the exact fixture-construction pattern already in this file — do not invent a new mocking approach.

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && python -m unittest discover tests`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/agent/sse.py backend/agent/graph.py backend/agent/main.py backend/tests/test_agent_sse.py backend/tests/test_agent_graph.py
git commit -m "feat(agent): CP68 activity events gain detail, kind and a timestamp"
```

---

## Task 4: Frontend types + `CitationPill` component

**Files:**
- Modify: `frontend/src/lib/agent-api.ts`
- Create: `frontend/src/components/citation-pill.tsx`
- Create: `frontend/src/lib/agent-api.test.ts` (or extend an existing test file for this module if one already exists — check `frontend/src` for any `*.test.ts` alongside `agent-api.ts` first; if none exists anywhere in this frontend, this codebase has no established frontend unit-test runner and this step should instead be a manual dev-route verification per `HANDOFF.md`'s documented verification pattern — confirm which applies before writing anything, do not assume Jest/Vitest is configured)

**Interfaces:**
- Consumes: backend's additive `citation`/`activity` shapes (Tasks 2-3).
- Produces: `AgentSource` gains `kind: "data" | "web" | "wikipedia"`, `title: string`, `n: number`. `AgentHandlers.onActivity` gains `detail?: string | null` and `kind?: "tool" | "agent" | "system"` params. `rewriteCitations(text: string) -> string`, a pure string function turning `[ev_N]` into `[N](#cite-ev_N)`. `CitationPill`, a component matching `react-markdown`'s `components.a` signature.

- [ ] **Step 1: Check for an existing frontend test runner**

Run: `cd frontend && cat package.json | grep -E '"test"|vitest|jest'`
If a test script exists, use it and write real tests for `rewriteCitations` per the shape below. If none exists, skip to Step 3 and verify via the dev-server browser check in Task 6 instead — do not introduce a new test framework for one function.

- [ ] **Step 2 (only if a test runner exists): Write the failing test**

```typescript
import { rewriteCitations } from "./agent-api";

describe("rewriteCitations", () => {
  it("converts a complete citation marker into a markdown link", () => {
    expect(rewriteCitations("Norris won [ev_2].")).toBe("Norris won [2](#cite-ev_2).");
  });

  it("converts multiple markers independently", () => {
    expect(rewriteCitations("[ev_1] and [ev_12]")).toBe("[1](#cite-ev_1) and [12](#cite-ev_12)");
  });

  it("leaves a partial, still-streaming marker untouched", () => {
    // The exact streaming-safety property Global Constraints requires:
    // no closing bracket yet, so this must not be touched or garbled.
    expect(rewriteCitations("Norris won [ev_")).toBe("Norris won [ev_");
  });

  it("leaves text with no citation markers untouched", () => {
    expect(rewriteCitations("Norris won the race.")).toBe("Norris won the race.");
  });
});
```

- [ ] **Step 3: Implement `rewriteCitations` in `agent-api.ts`**

Add near the other exported pure functions (`splitFrames`, `parseFrame`):

```typescript
/**
 * Turn a complete `[ev_N]` citation marker into a markdown link
 * `[N](#cite-ev_N)`, which `react-markdown`'s existing link rendering (via
 * a `components.a` override, see `CitationPill`) turns into a numbered pill.
 *
 * Deliberately a plain string rewrite rather than a custom remark plugin —
 * `react-markdown` already parses markdown links correctly, so reusing that
 * avoids a new AST-visiting dependency for something a regex already solves.
 * The regex's own requirement of a closing `]` is what makes this
 * streaming-safe: a partial marker at a chunk boundary (`"...[ev_"`) simply
 * does not match yet and passes through as literal text, unmodified, until
 * the closing bracket arrives in a later chunk.
 */
export function rewriteCitations(text: string): string {
  return text.replace(/\[ev_(\d+)\]/g, "[$1](#cite-ev_$1)");
}
```

- [ ] **Step 4: Update `AgentSource` and `AgentHandlers` types**

```typescript
export interface AgentSource {
  id: string;
  n: number;
  kind: "data" | "web" | "wikipedia";
  label: string;
  title: string;
  url?: string | null;
  as_of?: string | null;
}
```

```typescript
export interface AgentHandlers {
  onActivity?: (
    label: string,
    state: "start" | "done",
    detail?: string | null,
    kind?: "tool" | "agent" | "system"
  ) => void;
  onToken?: (text: string) => void;
  onSources?: (sources: AgentSource[]) => void;
  onDone?: (done: AgentDone) => void;
  onError?: (code: AgentErrorCode, message: string) => void;
}
```

Update the `dispatch` function's `"activity"` case to pass the new fields through:

```typescript
    case "activity":
      handlers.onActivity?.(
        String(payload.label ?? ""),
        payload.state === "done" ? "done" : "start",
        payload.detail == null ? null : String(payload.detail),
        (payload.kind as "tool" | "agent" | "system" | undefined) ?? "system"
      );
      break;
```

- [ ] **Step 5: Create `CitationPill`**

```tsx
// frontend/src/components/citation-pill.tsx
"use client";

/**
 * Renders a `[ev_N]` citation marker (rewritten by `rewriteCitations` into a
 * `#cite-ev_N` markdown link) as a numbered, clickable pill that scrolls to
 * and briefly highlights its matching `SourceCard`. Registered as the `a`
 * component override for `react-markdown` — an ordinary markdown link
 * (anything not matching the `#cite-ev_` href shape) renders as a normal
 * link, unchanged, so this component is safe to register globally on every
 * answer even for messages containing a genuine external link.
 */
export default function CitationPill({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const match = href?.match(/^#cite-(ev_\d+)$/);
  if (!match) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    );
  }
  const evidenceId = match[1];
  return (
    <button
      type="button"
      onClick={() => {
        const target = document.getElementById(`source-${evidenceId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
        target.classList.add("apex-citation-flash");
        window.setTimeout(() => target.classList.remove("apex-citation-flash"), 1200);
      }}
      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)]/20 px-1 text-[10px] font-semibold text-[var(--color-primary)] align-super transition-colors duration-150 hover:bg-[var(--color-primary)]/35"
      aria-label={`Jump to source ${children}`}
    >
      {children}
    </button>
  );
}
```

Before writing this component, invoke the `emil-design-eng` skill for the press-feedback/transition polish per `ROADMAP.md`'s own mandate for any UI checkpoint — apply its guidance to the hover/press states above rather than treating the Tailwind classes shown here as final.

- [ ] **Step 6: `npm run build && npm run lint` from `frontend/`**

Expected: no new type errors, no new lint errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/agent-api.ts frontend/src/components/citation-pill.tsx
git commit -m "feat(agent-ui): CP68 rewriteCitations + CitationPill component"
```

---

## Task 5: `SourceCard` component with real timestamps

**Files:**
- Create: `frontend/src/components/source-card.tsx`

**Interfaces:**
- Consumes: `AgentSource` (Task 4), `frontend/src/components/local-datetime.tsx`'s existing `LocalDateTime` component (already in this codebase — reuse directly, do not build a second timestamp component; it is already hydration-safe for this use since the Pitwall Assistant panel only ever renders after user interaction via a client portal, never during SSR).

- [ ] **Step 1: Read the existing chip rendering being replaced**

Read `frontend/src/components/pitwall-assistant-panel.tsx`'s current `MessageBubble` function, specifically the `message.sources.length > 0` block (the `<ul>`/`<li>` chip list) — this task's component replaces it, wired up in Task 6.

- [ ] **Step 2: Read `local-datetime.tsx` in full**

Confirm its exact prop shape (`timestampMs: number`, optional `options`) before using it — `AgentSource.as_of` is an ISO string, not a timestamp, so you'll need `new Date(source.as_of).getTime()`.

- [ ] **Step 3: Implement `SourceCard`**

```tsx
// frontend/src/components/source-card.tsx
"use client";

import LocalDateTime from "./local-datetime";
import type { AgentSource } from "@/lib/agent-api";

const KIND_ICON: Record<AgentSource["kind"], string> = {
  data: "database",
  web: "public",
  wikipedia: "menu_book",
};

/**
 * One retrieved source, rendered as a real card rather than a bare chip —
 * CP68's fix for `BATCH-19-PLAN.md` §3's citation defects: a human `title`
 * instead of a raw `mongo:collection/id` string, a real relative timestamp
 * instead of a raw ISO string in a tooltip, and (for `kind !== "data"`, which
 * has no public address per `agent/tools/base.py`'s `mongo_source` docstring)
 * a genuine clickable link.
 */
export default function SourceCard({ source }: { source: AgentSource }) {
  const asOfMs = source.as_of ? new Date(source.as_of).getTime() : null;
  const body = (
    <>
      <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">
        {KIND_ICON[source.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[var(--color-on-surface)]">
          {source.title}
        </span>
        {asOfMs && (
          <span className="block text-[10px] text-[var(--color-on-surface-variant)]">
            <LocalDateTime timestampMs={asOfMs} options={{ dateStyle: "medium", timeStyle: "short" }} />
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      id={`source-${source.id}`}
      className="flex items-center gap-2 rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-2.5 py-2 transition-[background-color,box-shadow] duration-300"
    >
      {source.kind === "data" ? (
        body
      ) : (
        <a
          href={source.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {body}
        </a>
      )}
    </div>
  );
}
```

Add the `apex-citation-flash` transition class `CitationPill` (Task 4) toggles — a brief highlight ring — to this codebase's global stylesheet (find where other `apex-*` utility classes are defined, e.g. `apex-glass-strong`/`apex-sheen`, likely `frontend/src/app/globals.css`, and follow that exact pattern):

```css
.apex-citation-flash {
  box-shadow: 0 0 0 2px var(--color-primary);
}
```

Invoke `emil-design-eng` for the flash transition's exact timing/easing before finalizing — 1200ms with an abrupt add/remove (as scaffolded above) is a placeholder, not a design decision.

- [ ] **Step 4: `npm run build && npm run lint` from `frontend/`**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/source-card.tsx frontend/src/app/globals.css
git commit -m "feat(agent-ui): CP68 SourceCard component with real timestamps"
```

---

## Task 6: Wire it all into the Pitwall Assistant panel

**Files:**
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx`

**Interfaces:**
- Consumes: `rewriteCitations`, `CitationPill` (Task 4), `SourceCard` (Task 5), the enriched `onActivity(label, state, detail, kind)` handler (Task 4).

- [ ] **Step 1: Read the current full file**

Read `frontend/src/components/pitwall-assistant-panel.tsx` in full — this task touches `Message`/`ActivityEntry` types, `MessageBubble`, and `ActivityTimeline`.

- [ ] **Step 2: Extend `ActivityEntry` and the `onActivity` wiring**

```typescript
type ActivityEntry = {
  label: string;
  state: "start" | "done";
  detail?: string | null;
  kind: "tool" | "agent" | "system";
};
```

Update the `onActivity` callback passed to `streamChat` (currently `(label, state) => patch(...)`) to accept and store the two new params:

```typescript
          onActivity: (label, state, detail, kind) =>
            patch((m) => ({
              ...m,
              activity: [...m.activity, { label, state, detail, kind: kind ?? "system" }],
            })),
```

- [ ] **Step 3: Render `[ev_N]` markers as pills and sources as cards**

In `MessageBubble`, change:

```tsx
            <ReactMarkdown>{message.text}</ReactMarkdown>
```

to:

```tsx
            <ReactMarkdown components={{ a: CitationPill }}>
              {rewriteCitations(message.text)}
            </ReactMarkdown>
```

Add the import: `import CitationPill from "./citation-pill";` and `import { rewriteCitations } from "@/lib/agent-api";` (adjust the import path to match this file's existing import style for sibling components/lib functions).

Change the sources block from the bare `<ul>`/`<li>` chip list to:

```tsx
      {message.sources.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {message.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      )}
```

Add the import: `import SourceCard from "./source-card";`

- [ ] **Step 4: Distinguish tool vs. agent steps in `ActivityTimeline`**

In the `ActivityTimeline` function, give a `kind === "agent"` entry a visually distinct marker (a filled dot or a small icon) from a `kind === "tool"` entry, and append `detail` in parentheses when present:

```tsx
          <li key={`${entry.label}-${index}`} className="flex items-center gap-1.5">
            <span
              className={
                entry.kind === "agent"
                  ? "h-1.5 w-1.5 rounded-full bg-[var(--color-secondary)]"
                  : "h-1 w-1 rounded-full bg-[var(--color-warm-500)]"
              }
            />
            {entry.label}
            {entry.detail && (
              <span className="text-[var(--color-on-surface-variant)]">— {entry.detail}</span>
            )}
          </li>
```

Apply the equivalent change to both the "done" list and the "still active" list in this function — read the function's current full body first, since it filters the same `activity` array twice (once for done entries, once for the still-in-flight one).

Invoke `emil-design-eng` before finalizing the agent-vs-tool visual distinction — a color/size difference is a starting point, not a final design decision, per this codebase's own established skill-usage convention for UI checkpoints.

- [ ] **Step 5: Verify in the browser**

Start the dev server (`apex-frontend` preview target per `HANDOFF.md`'s documented pattern, or `npm run dev` from `frontend/` if no preview target exists in this environment) and the backend agent service locally. Open the Pitwall Assistant panel, ask "Who has the most wins at Monaco in F1 history?" (a tier-2 question that reliably produces a citation per `golden_set.py`'s own notes for this exact case — "converged in 18.7s, one tool call... cited [ev_1]"), and confirm:
- The `[ev_1]` marker in the answer text renders as a numbered pill, not literal text
- Clicking the pill scrolls to and flashes the matching source card
- The source card shows a human title (not `mongo:...`) and a real relative timestamp (not a raw ISO string)
- The activity timeline shows at least one step

If a real backend isn't reachable in this environment (no `OLLAMA_API_KEY`), verify instead via a throwaway dev route with mocked `streamChat` events, per `HANDOFF.md`'s own documented pattern: "Write a throwaway route at `frontend/src/app/dev-test-<thing>/page.tsx` that renders the component directly with hardcoded mock props (or mocked `fetch`)." Delete the throwaway route before committing.

- [ ] **Step 6: `npm run build && npm run lint` from `frontend/`**

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/pitwall-assistant-panel.tsx
git commit -m "feat(agent-ui): CP68 wire citation pills, source cards and richer activity timeline into the assistant panel"
```

---

## Self-Review

**1. Spec coverage against `BATCH-19-PLAN.md` §6 (CP68):**
- Backend `Evidence` gains `kind` and human title — Task 2. ✅
- Backend `activity` gains `detail`, `kind`, `at` — Task 3. ✅
- Frontend numbered citation pills, click-to-source — Task 4/6. ✅
- Frontend `SourceCard` with icon/human label/relative timestamp/real link — Task 5. ✅
- Timestamps in a stable, hydration-safe way — reused existing `LocalDateTime`, Task 5, no new hydration risk introduced. ✅
- Streaming-safety for citation markers — structural (regex requires closing bracket), tested in Task 4. ✅

**2. Placeholder scan:** Task 4 Step 1 has a genuine conditional ("if a test runner exists... if none exists...") because this repo's frontend test tooling was not established in earlier research — this is an explicit decision point for the implementer to resolve by checking `package.json`, not a vague placeholder.

**3. Type consistency:** `AgentSource`'s `kind` union (`"data" | "web" | "wikipedia"`) matches exactly what `ledger.py`'s `citation()` can produce (Task 2). `ActivityEntry`'s `kind` union (`"tool" | "agent" | "system"`) matches `sse.activity()`'s `kind` parameter's three possible values as established across Tasks 3-6.

**4. Ambiguity check:** The `_run_turn` tuple-shape question (3-tuple system messages vs. 5-tuple tool/agent messages) is resolved explicitly in Task 3 Step 5-6 rather than left for the implementer to guess — main.py accepts both shapes rather than requiring every call site to be padded.
