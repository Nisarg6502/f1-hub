"""Tests for `render_visual` and the visual buffer — `CHAT-VISUALS-CONTRACT.md`
§2, §4 and §7.

Deliberately framework-free, like the modules they cover: `agent/visuals.py`
and `agent/tools/visual.py` import nothing from LangChain, LangGraph or
deepagents, which is what lets the tool's whole validation surface — every
rejection in §2 and every failure mode in §7 — be exercised without an agent
stack or a model call. That is the same bet `agent/ledger.py` and
`agent/tools/base.py` already made and for the same reason: the free-tier
quota is shared, and a check the code can do must never need a GPU.

Frame assertions go through `sse.visual` and read the **wire bytes**, per
`test_agent_sse.py`'s standing rule: a documented output format is not
evidence of the format actually produced.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import sse, visuals
from agent.ledger import EvidenceLedger
from agent.tools.visual import render_visual


def run(coro):
    return asyncio.run(coro)


GOOD_CODE = (
    "export default function render({ data, apex, mount, width }) {\n"
    "  mount.replaceChildren();\n"
    "  const rows = (data && data.results) || [];\n"
    "  const x = apex.scaleBand({ domain: rows.map(r => r.driver),"
    " range: [0, width], padding: 0.2 });\n"
    "  mount.appendChild(apex.panel(apex.svg('svg', { width })));\n"
    "}\n"
)


def _ledger_with_one_bundle(data=None):
    ledger = EvidenceLedger()
    ledger.append(
        source="mongo:race_results/2026-14",
        data=data if data is not None else {"results": [{"driver": "Norris", "points": 25}]},
        as_of="2026-08-23T01:00:00+00:00",
        tool="get_session_result",
    )
    return ledger


async def _call(ledger=None, buffer=None, **overrides):
    kwargs = {
        "evidence_id": "ev_1",
        "title": "Points gap to the leader",
        "code": GOOD_CODE,
    }
    kwargs.update(overrides)
    return await render_visual(
        ledger=_ledger_with_one_bundle() if ledger is None else ledger,
        visuals=visuals.VisualBuffer() if buffer is None else buffer,
        **kwargs,
    )


class HappyPathTests(unittest.TestCase):
    def test_it_returns_ok_with_a_visual_id(self):
        """§2.5 — the model is told the call landed so it does not retry."""
        result = run(_call())

        self.assertEqual(result, {"ok": True, "visual_id": "vis_1"})

    def test_the_backend_attaches_the_ledgers_data_verbatim(self):
        """The guarantee the whole feature rests on (§1).

        The model supplied code and an id and nothing else; every number in the
        buffered visual came out of the ledger entry, not out of the call.
        """
        ledger = _ledger_with_one_bundle()
        buffer = visuals.VisualBuffer()

        run(_call(ledger=ledger, buffer=buffer))

        visual = list(buffer)[0]
        self.assertIs(visual.data, ledger.get("ev_1").data)
        self.assertEqual(visual.evidence_id, "ev_1")
        # §4: `as_of` is the evidence's own cutoff, not the clock — same rule
        # `tools/base.py` enforces for bundles, for the same reason.
        self.assertEqual(visual.as_of, "2026-08-23T01:00:00+00:00")

    def test_the_emitted_frame_matches_the_contracts_shape(self):
        """§4, asserted on the bytes `main.py` actually writes.

        `main.py` emits `sse.visual(**payload)` where `payload` is exactly a
        `Visual.to_dict()`, so composing them here is the real path, not a
        reconstruction of it.
        """
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer))

        raw = sse.visual(**buffer.frames()[0])

        self.assertTrue(raw.startswith("event: visual\ndata: "))
        self.assertTrue(raw.endswith("\n\n"))
        self.assertFalse(raw.endswith("\n\n\n"))
        # One `data:` line — the code is a multi-line ES module, and a raw
        # payload would split the frame at its first newline.
        body = raw.split("\n\n")[0]
        self.assertEqual(len(body.splitlines()), 2, msg=f"frame split: {raw!r}")

        payload = json.loads(body.splitlines()[1][len("data: "):])
        self.assertEqual(
            set(payload),
            {"visual_id", "evidence_id", "title", "caption", "as_of", "code", "data"},
        )
        self.assertEqual(payload["visual_id"], "vis_1")
        self.assertEqual(payload["evidence_id"], "ev_1")
        self.assertEqual(payload["title"], "Points gap to the leader")
        self.assertEqual(payload["caption"], "")
        self.assertEqual(payload["as_of"], "2026-08-23T01:00:00+00:00")
        self.assertEqual(payload["code"], GOOD_CODE)
        self.assertEqual(payload["data"], {"results": [{"driver": "Norris", "points": 25}]})

    def test_caption_rides_along_when_given(self):
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer, caption="Cumulative points, rounds 1-14."))

        self.assertEqual(
            buffer.frames()[0]["caption"], "Cumulative points, rounds 1-14."
        )


class UnknownEvidenceTests(unittest.TestCase):
    """§2.1 and §7's first row: nothing renders, and no nearest-neighbour guess."""

    def test_an_id_that_was_never_retrieved_is_refused(self):
        result = run(_call(evidence_id="ev_9"))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "unknown_evidence")

    def test_nothing_is_buffered_on_a_miss(self):
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer, evidence_id="ev_9"))

        self.assertEqual(len(buffer), 0)
        self.assertEqual(buffer.frames(), [])

    def test_it_does_not_fall_back_to_a_neighbouring_entry(self):
        """The failure nobody would notice: a chart that renders correctly
        from the wrong evidence."""
        ledger = _ledger_with_one_bundle()
        ledger.append(source="mongo:driver_standings/2026", data={"x": 1}, as_of="z")
        buffer = visuals.VisualBuffer()

        result = run(_call(ledger=ledger, buffer=buffer, evidence_id="ev_3"))

        self.assertEqual(result["reason"], "unknown_evidence")
        self.assertEqual(len(buffer), 0)

    def test_the_tool_appends_nothing_to_the_ledger(self):
        """It is not a fact tool: it retrieves nothing and cites nothing."""
        ledger = _ledger_with_one_bundle()
        before = ledger.ids()

        run(_call(ledger=ledger))

        self.assertEqual(ledger.ids(), before)


class SizeLimitTests(unittest.TestCase):
    def test_oversized_code_is_refused(self):
        """§2.2."""
        oversized = GOOD_CODE + ("\n// " + "x" * 100) * 300
        self.assertGreater(len(oversized), visuals.MAX_CODE_CHARS)

        result = run(_call(code=oversized))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "code_too_large")

    def test_code_at_the_limit_is_accepted(self):
        """Non-vacuous: the rejection above is a limit, not a blanket refusal."""
        padding = visuals.MAX_CODE_CHARS - len(GOOD_CODE)
        result = run(_call(code=GOOD_CODE + "/" * padding))

        self.assertEqual(result["ok"], True)

    def test_oversized_data_is_refused_rather_than_truncated(self):
        """§2.4 — a trimmed payload is a chart that silently draws a subset."""
        big = {"rows": [{"lap": i, "note": "x" * 200} for i in range(2000)]}
        self.assertGreater(visuals.data_size(big), visuals.MAX_DATA_BYTES)
        buffer = visuals.VisualBuffer()

        result = run(_call(ledger=_ledger_with_one_bundle(big), buffer=buffer))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "data_too_large")
        self.assertEqual(len(buffer), 0)

    def test_unserialisable_data_is_refused_not_raised(self):
        """It would otherwise blow up in `sse.frame`, i.e. mid-stream."""
        result = run(_call(ledger=_ledger_with_one_bundle({"when": object()})))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "data_too_large")


class StaticPreCheckTests(unittest.TestCase):
    """§2.3 — defence in depth. The sandbox is the boundary; see
    `visuals.FORBIDDEN_CONSTRUCTS` for why that distinction is load-bearing
    and what it means for anyone loosening this list."""

    def test_every_listed_construct_is_rejected(self):
        samples = {
            "import ": 'import * as d3 from "d3";\n' + GOOD_CODE,
            "require(": 'const d3 = require("d3");\n' + GOOD_CODE,
            "fetch(": GOOD_CODE + '\nfetch("/api/x");\n',
            "XMLHttpRequest": GOOD_CODE + "\nnew XMLHttpRequest();\n",
            "WebSocket": GOOD_CODE + '\nnew WebSocket("wss://x");\n',
            "eval(": GOOD_CODE + '\neval("1+1");\n',
            "new Function": GOOD_CODE + '\nnew Function("return 1");\n',
            "document.cookie": GOOD_CODE + "\nconst c = document.cookie;\n",
            "localStorage": GOOD_CODE + '\nlocalStorage.getItem("k");\n',
            "sessionStorage": GOOD_CODE + '\nsessionStorage.getItem("k");\n',
            "parent.": GOOD_CODE + "\nparent.postMessage(1);\n",
            "top.": GOOD_CODE + "\ntop.location = 'x';\n",
            "window.open": GOOD_CODE + '\nwindow.open("https://x");\n',
        }
        # Every entry in the list is covered, so a construct added later
        # without a sample here fails loudly instead of going untested.
        self.assertEqual(set(samples), set(visuals.FORBIDDEN_CONSTRUCTS))

        for construct, code in samples.items():
            with self.subTest(construct=construct):
                buffer = visuals.VisualBuffer()
                result = run(_call(buffer=buffer, code=code))
                self.assertEqual(result["ok"], False)
                self.assertEqual(result["reason"], "forbidden_construct")
                self.assertEqual(result["construct"], construct)
                self.assertEqual(len(buffer), 0)

    def test_ordinary_apex_code_passes_every_check(self):
        """Non-vacuous, and the check that matters most: the house style the
        prompt asks for must not itself trip the list."""
        self.assertIsNone(visuals.forbidden_construct(GOOD_CODE))
        self.assertEqual(run(_call())["ok"], True)


class ArgumentTests(unittest.TestCase):
    def test_missing_arguments_are_refused(self):
        for overrides in (
            {"evidence_id": ""},
            {"title": "   "},
            {"code": "   "},
        ):
            with self.subTest(**overrides):
                result = run(_call(**overrides))
                self.assertEqual(result["reason"], "invalid_arguments")

    def test_an_overlong_title_is_clamped_rather_than_losing_the_visual(self):
        """The one deliberate departure from "reject, do not trim" — see
        `VisualBuffer.append`. Chrome clamps; the payload never does."""
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer, title="P" * 200, caption="C" * 500))

        frame = buffer.frames()[0]
        self.assertEqual(len(frame["title"]), visuals.MAX_TITLE_CHARS)
        self.assertEqual(len(frame["caption"]), visuals.MAX_CAPTION_CHARS)
        self.assertTrue(frame["title"].endswith("…"))

    def test_it_refuses_rather_than_raises_without_run_state(self):
        """A wiring mistake must not abort a turn — §2's never-raise rule."""
        result = run(
            render_visual("ev_1", "T", GOOD_CODE, ledger=None, visuals=None)
        )

        self.assertEqual(result, {"ok": False, "reason": "unavailable"})

    def test_it_never_raises_on_an_unexpected_failure(self):
        class _Exploding:
            is_full = False

            def append(self, **kwargs):
                raise RuntimeError("boom")

        result = run(_call(buffer=_Exploding()))

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "render_failed")
        self.assertEqual(result["error"], "RuntimeError")


class TwoVisualCapTests(unittest.TestCase):
    """§7: two visuals for one answer are allowed and capped at two."""

    def test_two_are_allowed_and_numbered_in_call_order(self):
        buffer = visuals.VisualBuffer()

        first = run(_call(buffer=buffer, title="One"))
        second = run(_call(buffer=buffer, title="Two"))

        self.assertEqual(first["visual_id"], "vis_1")
        self.assertEqual(second["visual_id"], "vis_2")
        self.assertEqual([f["title"] for f in buffer.frames()], ["One", "Two"])

    def test_a_third_is_refused_and_nothing_is_buffered(self):
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer))
        run(_call(buffer=buffer))

        third = run(_call(buffer=buffer, title="Three"))

        self.assertEqual(third["ok"], False)
        self.assertEqual(third["reason"], "visual_limit_reached")
        self.assertEqual(len(buffer), 2)

    def test_the_cap_is_reported_before_any_other_problem(self):
        """So a model over the cap is told the cap, not told about the code it
        happened to also get wrong on the third attempt."""
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer))
        run(_call(buffer=buffer))

        third = run(_call(buffer=buffer, evidence_id="ev_9", code="import x"))

        self.assertEqual(third["reason"], "visual_limit_reached")

    def test_the_buffer_refuses_to_append_past_the_cap(self):
        """Enforced on the container, so the repair loop's second graph run
        cannot smuggle in a third."""
        buffer = visuals.VisualBuffer()
        for _ in range(visuals.MAX_VISUALS):
            buffer.append(
                evidence_id="ev_1", title="t", caption="", as_of="z",
                code=GOOD_CODE, data={},
            )

        with self.assertRaises(ValueError):
            buffer.append(
                evidence_id="ev_1", title="t", caption="", as_of="z",
                code=GOOD_CODE, data={},
            )


class CacheReplayTests(unittest.TestCase):
    """§7's last row: visuals are cached with the answer and replayed, because
    they are pure functions of `(code, data)`."""

    def test_a_frame_round_trips_through_the_cache_unchanged(self):
        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer, caption="Cumulative points."))
        stored = buffer.frames()

        # What Mongo actually holds — JSON, not Python objects. Round-tripping
        # through `json` is the point: a payload that only survives in-process
        # is not a payload that survives a cache.
        replayed = visuals.VisualBuffer.from_dicts(
            json.loads(json.dumps(stored, ensure_ascii=False))
        )

        self.assertEqual(replayed.frames(), stored)
        self.assertEqual(
            sse.visual(**replayed.frames()[0]), sse.visual(**stored[0])
        )

    def test_a_row_written_before_visuals_existed_replays_as_none(self):
        """Additive by construction — the key is simply absent on old rows."""
        self.assertEqual(visuals.VisualBuffer.from_dicts(None).frames(), [])
        self.assertEqual(visuals.VisualBuffer.from_dicts([]).frames(), [])

    def test_a_partial_stored_payload_still_yields_a_complete_frame(self):
        """A missing key must not become a `TypeError` inside an
        already-committed stream."""
        replayed = visuals.VisualBuffer.from_dicts([{"visual_id": "vis_1"}])

        frame = replayed.frames()[0]
        self.assertEqual(
            set(frame),
            {"visual_id", "evidence_id", "title", "caption", "as_of", "code", "data"},
        )
        self.assertEqual(frame["code"], "")
        self.assertIsNone(frame["data"])

    def test_the_cache_write_stores_the_visuals(self):
        from agent import answer_cache

        class _Collection:
            def __init__(self):
                self.doc = None

            async def update_one(self, query, update, upsert=False):
                self.doc = update["$set"]

        class _DB:
            def __init__(self, collection):
                self.collection = collection

            def __getitem__(self, name):
                return self.collection

        buffer = visuals.VisualBuffer()
        run(_call(buffer=buffer))
        collection = _Collection()

        run(
            answer_cache.set_cached(
                "who won?", 4, tier=2, text="Norris did [ev_1].",
                sources=[], visuals=buffer.frames(), db=_DB(collection),
            )
        )

        self.assertEqual(collection.doc["visuals"], buffer.frames())

    def test_the_cache_write_defaults_to_an_empty_list(self):
        from agent import answer_cache

        class _Collection:
            def __init__(self):
                self.doc = None

            async def update_one(self, query, update, upsert=False):
                self.doc = update["$set"]

        class _DB:
            def __init__(self, collection):
                self.collection = collection

            def __getitem__(self, name):
                return self.collection

        collection = _Collection()
        run(
            answer_cache.set_cached(
                "who won?", 4, tier=2, text="x", sources=[], db=_DB(collection)
            )
        )

        self.assertEqual(collection.doc["visuals"], [])


class RegistrationTests(unittest.TestCase):
    def test_it_is_registered_under_the_name_it_answers_to(self):
        from agent.tools import TOOLS

        self.assertIs(TOOLS["render_visual"], render_visual)
        self.assertEqual(render_visual.tool_name, "render_visual")

    def test_it_has_a_friendly_activity_label(self):
        from agent.labels import activity_label

        self.assertEqual(activity_label("render_visual"), "Drawing a chart")


if __name__ == "__main__":
    unittest.main()
