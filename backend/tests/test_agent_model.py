"""Tests for the model seam.

These exist because an adversarial review of CP59 ran mutation testing over
this module and found that **every** safety guard in it could be deleted with
the whole suite still green — `test_agent_chat.py` stubs the seam entirely, so
none of `model.py` was ever executed. The mutations that survived, each of
which now has a test below:

- dropping the blank-line skip in the NDJSON parser
- never breaking on `done`
- dropping the 402/429 → `ModelAtCapacity` classification
- forwarding the whole `message` object, which **leaks raw chain-of-thought**
  into user-facing prose

That last one is the one that matters most: `model.py`'s docstring calls
suppressing `thinking` a post-mortem-derived invariant, and nothing checked it.
A documented invariant with no test is a comment, not a guarantee.

The transport is faked with `httpx.MockTransport`, so these exercise the real
parser, the real classification and the real error paths without a network.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from agent import model


def ndjson(*objects: dict) -> bytes:
    return "\n".join(json.dumps(o) for o in objects).encode("utf-8")


def run_stream(body: bytes, status: int = 200) -> list[str]:
    """Collect deltas from `stream_chat` against a faked transport."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body)

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    async def collect():
        with patch.object(model.httpx, "AsyncClient", client_factory):
            return [chunk async for chunk in model.stream_chat([{"role": "user", "content": "hi"}])]

    return asyncio.run(collect())


class KeyTests(unittest.TestCase):
    @patch.object(model.config, "api_key", lambda: None)
    def test_missing_key_raises_model_unavailable(self):
        async def collect():
            return [c async for c in model.stream_chat([])]

        with self.assertRaises(model.ModelUnavailable):
            asyncio.run(collect())


@patch.object(model.config, "api_key", lambda: "test-key")
class StreamParsingTests(unittest.TestCase):
    def test_yields_content_deltas_in_order(self):
        body = ndjson(
            {"message": {"content": "Lando "}},
            {"message": {"content": "Norris"}},
            {"message": {"content": ""}, "done": True},
        )
        self.assertEqual(run_stream(body), ["Lando ", "Norris"])

    def test_thinking_is_never_forwarded(self):
        """Reasoning models stream chain-of-thought beside the answer.

        Forwarding it leaks reasoning traces into user-facing prose, and it is
        not evidence-backed text, so it must not reach the verifier either.
        """
        body = ndjson(
            {"message": {"thinking": "The user wants X. I should recall Y.",
                         "content": "Norris won."}},
            {"message": {"content": ""}, "done": True},
        )
        deltas = run_stream(body)
        self.assertEqual(deltas, ["Norris won."])
        self.assertNotIn("I should recall", "".join(deltas))

    def test_blank_lines_are_skipped_not_parsed(self):
        body = b"\n" + ndjson({"message": {"content": "ok"}}) + b"\n\n" + \
            ndjson({"message": {"content": ""}, "done": True})
        self.assertEqual(run_stream(body), ["ok"])

    def test_malformed_line_is_tolerated(self):
        body = (
            json.dumps({"message": {"content": "a"}}).encode()
            + b"\n{not json at all\n"
            + json.dumps({"message": {"content": "b"}, "done": True}).encode()
        )
        self.assertEqual(run_stream(body), ["a", "b"])

    def test_stops_at_done(self):
        """Anything after `done` is not part of the answer."""
        body = ndjson(
            {"message": {"content": "first"}},
            {"message": {"content": "last"}, "done": True},
            {"message": {"content": "SHOULD NOT APPEAR"}},
        )
        self.assertEqual(run_stream(body), ["first", "last"])


@patch.object(model.config, "api_key", lambda: "test-key")
class InStreamErrorTests(unittest.TestCase):
    """Ollama reports mid-generation failures inside an already-200 stream.

    Found by review: ignoring the `error` object drained the loop silently and
    handed back whatever text had arrived first, so a **truncated answer was
    presented to the reader as a complete one**. An outage is honest; a wrong
    answer wearing a success is not.
    """

    def test_error_object_mid_stream_raises(self):
        body = ndjson(
            {"message": {"content": "Lando "}},
            {"error": "an internal error occurred"},
        )
        with self.assertRaises(model.ModelError) as caught:
            run_stream(body)
        self.assertNotIsInstance(caught.exception, model.ModelAtCapacity)

    def test_capacity_shaped_error_is_classified_as_at_capacity(self):
        body = ndjson(
            {"error": "model requires more system memory than is available"}
        )
        with self.assertRaises(model.ModelAtCapacity):
            run_stream(body)

    def test_rate_limit_wording_is_classified_as_at_capacity(self):
        with self.assertRaises(model.ModelAtCapacity):
            run_stream(ndjson({"error": "rate limit exceeded, try again later"}))

    def test_empty_stream_raises_rather_than_returning_silently(self):
        """A 200 that yields nothing reads as an answer if allowed through."""
        with self.assertRaises(model.ModelError):
            run_stream(b"")

    def test_stream_of_only_empty_content_raises(self):
        body = ndjson({"message": {"content": ""}, "done": True})
        with self.assertRaises(model.ModelError):
            run_stream(body)


@patch.object(model.config, "api_key", lambda: "test-key")
class StatusClassificationTests(unittest.TestCase):
    def test_429_is_at_capacity(self):
        with self.assertRaises(model.ModelAtCapacity):
            run_stream(b'{"error":"too many requests"}', status=429)

    def test_402_is_at_capacity(self):
        with self.assertRaises(model.ModelAtCapacity):
            run_stream(b'{"error":"payment required"}', status=402)

    def test_401_is_not_at_capacity(self):
        """A bad key must not be dressed up as a quota problem.

        Misclassifying it sends the next reader hunting a quota that is fine.
        """
        with self.assertRaises(model.ModelError) as caught:
            run_stream(b'{"error":"unauthorized"}', status=401)
        self.assertNotIsInstance(caught.exception, model.ModelAtCapacity)

    def test_500_is_a_plain_upstream_error(self):
        with self.assertRaises(model.ModelError) as caught:
            run_stream(b"boom", status=500)
        self.assertNotIsInstance(caught.exception, model.ModelAtCapacity)
        self.assertNotIsInstance(caught.exception, model.ModelTimeout)


class ToolCallNormalisationTests(unittest.TestCase):
    """Ollama returns `arguments` as an object; OpenAI-compatible surfaces
    return a JSON string. CP44's lesson applied to a model API."""

    def test_object_arguments(self):
        message = {"tool_calls": [
            {"function": {"name": "get_standings", "arguments": {"year": 2026}}}
        ]}
        self.assertEqual(model.tool_calls(message),
                         [("get_standings", {"year": 2026})])

    def test_string_arguments(self):
        message = {"tool_calls": [
            {"function": {"name": "get_standings", "arguments": '{"year": 2026}'}}
        ]}
        self.assertEqual(model.tool_calls(message),
                         [("get_standings", {"year": 2026})])

    def test_unparseable_arguments_degrade_to_empty(self):
        """Degrading beats raising: a malformed call should be a tool-layer
        rejection with a useful message, not a crash in the parser."""
        message = {"tool_calls": [
            {"function": {"name": "get_standings", "arguments": "{not json"}}
        ]}
        self.assertEqual(model.tool_calls(message), [("get_standings", {})])

    def test_no_tool_calls(self):
        self.assertEqual(model.tool_calls({"content": "just prose"}), [])


if __name__ == "__main__":
    unittest.main()
