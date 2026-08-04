"""Tests for the SSE contract the frontend parses.

CP44's lesson is the reason these assert the *wire bytes* rather than calling
the helpers and comparing dicts: a documented output format is not evidence of
the format actually produced. If `frame()` ever stops emitting a blank line
between events, every helper still returns a string and every dict-level test
still passes, while the client silently receives one merged event.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import sse


class FrameFormatTests(unittest.TestCase):
    def test_frame_has_event_data_and_blank_line(self):
        raw = sse.frame("token", {"text": "hi"})
        self.assertEqual(raw, 'event: token\ndata: {"text": "hi"}\n\n')

    def test_frame_ends_with_exactly_one_blank_line(self):
        # Two newlines terminate an SSE event. One leaves the client waiting;
        # three inject an empty event into some parsers.
        raw = sse.frame("done", {})
        self.assertTrue(raw.endswith("\n\n"))
        self.assertFalse(raw.endswith("\n\n\n"))

    def test_newline_in_payload_cannot_split_the_event(self):
        """A Markdown answer with a newline must stay one event.

        This is the concrete reason `token` carries `{"text": ...}` rather than
        the bare string: answers are Markdown, newlines are routine, and a raw
        payload would terminate the frame mid-token.
        """
        raw = sse.token("line one\nline two")
        body = raw.split("\n\n")[0]
        self.assertEqual(len(body.splitlines()), 2, msg=f"frame split: {raw!r}")
        payload = json.loads(body.splitlines()[1][len("data: "):])
        self.assertEqual(payload["text"], "line one\nline two")

    def test_non_ascii_survives_round_trip(self):
        raw = sse.token("Kimi Räikkönen — P1")
        payload = json.loads(raw.split("data: ", 1)[1].strip())
        self.assertEqual(payload["text"], "Kimi Räikkönen — P1")


class EventVocabularyTests(unittest.TestCase):
    def test_activity_carries_label_and_state(self):
        payload = json.loads(sse.activity("Thinking…").split("data: ", 1)[1])
        self.assertEqual(payload, {"label": "Thinking…", "state": "start"})

    def test_sources_wraps_the_list(self):
        items = [{"id": "ev_1", "label": "race_results 2026-14", "url": None}]
        payload = json.loads(sse.sources(items).split("data: ", 1)[1])
        self.assertEqual(payload["sources"], items)

    def test_done_passes_arbitrary_fields_through(self):
        payload = json.loads(sse.done(run_id="r1", mode="model").split("data: ", 1)[1])
        self.assertEqual(payload, {"run_id": "r1", "mode": "model"})

    def test_error_keeps_known_codes(self):
        for code in sse.ERROR_CODES:
            payload = json.loads(sse.error(code, "x").split("data: ", 1)[1])
            self.assertEqual(payload["code"], code)

    def test_unknown_error_code_degrades_to_internal(self):
        """The UI styles errors by code, so an unknown one must not reach it.

        Degrading beats raising: this runs inside an already-committed
        streaming response, where an exception would truncate the stream with
        no terminal event at all.
        """
        payload = json.loads(sse.error("kaboom", "x").split("data: ", 1)[1])
        self.assertEqual(payload["code"], "internal")

    def test_comment_is_a_comment_not_an_event(self):
        self.assertEqual(sse.comment("ping"), ": ping\n\n")


class HeaderTests(unittest.TestCase):
    def test_buffering_is_disabled(self):
        """Without this header Cloud Run buffers the whole response.

        The symptom is not an error: the client receives one chunk at the end,
        so streaming "works" on localhost and silently does not in production —
        exactly the class of gap Batch 16 was spent on.
        """
        self.assertEqual(sse.SSE_HEADERS["X-Accel-Buffering"], "no")

    def test_no_transform_in_cache_control(self):
        # `no-transform` stops intermediaries compressing or chunk-rewriting
        # the stream, which also defeats incremental delivery.
        self.assertIn("no-transform", sse.SSE_HEADERS["Cache-Control"])

    def test_media_type(self):
        self.assertEqual(sse.MEDIA_TYPE, "text/event-stream")


if __name__ == "__main__":
    unittest.main()
