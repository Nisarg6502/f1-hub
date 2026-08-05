"""End-to-end tests for `POST /api/chat` — the SSE transport CP59 exists to prove.

These drive the ASGI app directly rather than through `fastapi.testclient`.
Two reasons, and the second is the important one:

1. `TestClient` couples starlette to a specific httpx major, and this repo pins
   neither in `backend/requirements.txt`. The suite must not fail because an
   unrelated dependency moved.
2. Driving ASGI directly tests the thing that actually matters here — the
   *stream*: that the body arrives as multiple `http.response.body` messages
   with the right framing, not as one buffered blob. A client that reassembles
   the response for you cannot show you that.

Only the model seam is stubbed. The gate, the error mapping, the event
ordering and the headers are the genuine article.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import concurrency, main, model


class Response:
    def __init__(self, status: int, headers: list[tuple[str, str]], chunks: list[bytes]):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.chunks = chunks

    @property
    def body(self) -> str:
        return b"".join(self.chunks).decode("utf-8")

    @property
    def events(self) -> list[tuple[str, dict]]:
        """Parse the SSE body into (event, data) pairs, ignoring comments."""
        out: list[tuple[str, dict]] = []
        for block in self.body.split("\n\n"):
            block = block.strip()
            if not block or block.startswith(":"):
                continue
            name, payload = None, {}
            for line in block.splitlines():
                if line.startswith("event: "):
                    name = line[len("event: "):]
                elif line.startswith("data: "):
                    payload = json.loads(line[len("data: "):])
            if name is not None:
                out.append((name, payload))
        return out

    def names(self) -> list[str]:
        return [name for name, _ in self.events]

    def payload_of(self, event_name: str) -> dict:
        return next(data for name, data in self.events if name == event_name)

    def text(self) -> str:
        return "".join(d["text"] for n, d in self.events if n == "token")


async def _drive(method: str, path: str, body: dict | None = None) -> Response:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }
    payload = json.dumps(body).encode() if body is not None else b""
    inbound = [{"type": "http.request", "body": payload, "more_body": False}]

    async def receive():
        if inbound:
            return inbound.pop(0)
        # Block forever instead of reporting a disconnect. Starlette's
        # StreamingResponse runs a disconnect listener concurrently with the
        # stream and cancels the whole response the moment `receive()` returns
        # `http.disconnect` — so a harness that reports one immediately kills
        # the stream at its first `await`, which reads as the endpoint dropping
        # events. The listener is cancelled when the response completes, so
        # blocking here is both correct and safe.
        await asyncio.Event().wait()

    captured: dict = {"status": None, "headers": [], "chunks": []}

    async def send(message):
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
            captured["headers"] = [
                (k.decode(), v.decode()) for k, v in message.get("headers", [])
            ]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                captured["chunks"].append(chunk)

    await main.app(scope, receive, send)
    return Response(captured["status"], captured["headers"], captured["chunks"])


def post(message: str = "Who won Monaco?", **fields) -> Response:
    response = asyncio.run(_drive("POST", "/api/chat", {"message": message, **fields}))
    assert response.status == 200, f"{response.status}: {response.body[:300]}"
    return response


async def _fake_stream(*_args, **_kwargs):
    for chunk in ("Lando ", "Norris ", "won."):
        # The `await` matters. A fake that never yields to the event loop runs
        # to completion before any concurrent task is scheduled, which hides
        # every bug that only appears when the stream is actually suspended
        # mid-flight — including the disconnect-listener race above.
        await asyncio.sleep(0)
        yield chunk


class HappyPathTests(unittest.TestCase):
    def setUp(self):
        concurrency.reset_for_tests()

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_event_order_is_activity_then_tokens_then_sources_then_done(self):
        response = post()
        names = response.names()
        self.assertEqual(names[0], "activity")
        self.assertIn("token", names)
        self.assertEqual(names[-2:], ["sources", "done"])
        # Every token must precede the terminal events.
        self.assertLess(max(i for i, n in enumerate(names) if n == "token"),
                        names.index("sources"))

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_tokens_reassemble_to_the_model_output(self):
        self.assertEqual(post().text(), "Lando Norris won.")

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_body_arrives_in_multiple_chunks_not_one_blob(self):
        """The actual streaming assertion.

        If the response were buffered, every event would arrive in a single
        `http.response.body` message and the UI's token-by-token reveal would
        silently become a single late paint — which is exactly how this fails
        in production while looking fine locally.
        """
        response = post()
        self.assertGreater(len(response.chunks), 3,
                           msg=f"expected a stream, got {len(response.chunks)} chunk(s)")

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_done_reports_mode_model_and_the_model_name(self):
        done = post().payload_of("done")
        self.assertEqual(done["mode"], "model")
        self.assertEqual(done["model"], main.config.DEFAULT_MODEL)
        self.assertIn("elapsed_ms", done)
        self.assertIn("run_id", done)

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_streaming_headers_are_set(self):
        response = post()
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertIn("no-transform", response.headers["cache-control"])

    @patch.object(main.model, "stream_chat", _fake_stream)
    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_lone_caller_is_never_told_it_is_queued(self):
        """Regression for the queue-accounting bug in `concurrency.run_slot`."""
        labels = [d["label"] for n, d in post().events if n == "activity"]
        self.assertFalse(
            any("Queued" in label or "next" in label for label in labels),
            msg=f"idle service reported a queue: {labels}",
        )


class EchoFallbackTests(unittest.TestCase):
    def setUp(self):
        concurrency.reset_for_tests()

    @patch.object(main.config, "api_key", lambda: None)
    def test_missing_key_falls_back_to_echo_and_says_so(self):
        """The transport must be provable while the quota is exhausted.

        Free-tier session limits reset every 5 hours, so a deployment check
        that only works when quota happens to be available is not a check.
        """
        response = post("hello there")
        self.assertEqual(response.payload_of("done")["mode"], "echo")
        self.assertEqual(response.text().strip(), "hello there")
        labels = [d["label"] for n, d in response.events if n == "activity"]
        self.assertTrue(
            any("not configured" in label for label in labels),
            msg=f"echo mode must be announced, got {labels}",
        )


class FailureTests(unittest.TestCase):
    def setUp(self):
        concurrency.reset_for_tests()

    def test_empty_message_is_an_error_event_not_an_http_error(self):
        """The failure rides the stream, because the status is already 200.

        By the time anything is validated the response has been committed, so a
        4xx cannot carry it. Every failure in this system is an SSE event.
        """
        response = post("   ")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.names(), ["error"])
        self.assertEqual(response.payload_of("error")["code"], "bad_request")

    def test_overlong_message_is_rejected(self):
        self.assertEqual(post("x" * 4001).payload_of("error")["code"], "bad_request")

    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_quota_exhaustion_becomes_at_capacity_not_a_stack_trace(self):
        async def boom(*_a, **_k):
            raise model.ModelAtCapacity("HTTP 429 from ollama.com")
            yield  # pragma: no cover - makes this an async generator

        with patch.object(main.model, "stream_chat", boom):
            error = post().payload_of("error")

        self.assertEqual(error["code"], "at_capacity")
        self.assertNotIn("429", error["message"])
        self.assertNotIn("ollama.com", error["message"])

    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_timeout_maps_to_the_timeout_code(self):
        async def slow(*_a, **_k):
            raise model.ModelTimeout("too slow")
            yield  # pragma: no cover

        with patch.object(main.model, "stream_chat", slow):
            self.assertEqual(post().payload_of("error")["code"], "timeout")

    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_upstream_failure_does_not_leak_internals_to_the_client(self):
        async def broken(*_a, **_k):
            raise model.ModelError("connection refused to internal-host:11434")
            yield  # pragma: no cover

        with patch.object(main.model, "stream_chat", broken):
            error = post().payload_of("error")
        self.assertEqual(error["code"], "upstream")
        self.assertNotIn("internal-host", error["message"])

    @patch.object(main.config, "api_key", lambda: "test-key")
    def test_unexpected_exception_still_terminates_the_stream(self):
        """A stream that just stops is indistinguishable from a dead socket."""
        async def weird(*_a, **_k):
            raise ValueError("something nobody predicted")
            yield  # pragma: no cover

        with patch.object(main.model, "stream_chat", weird):
            response = post()
        self.assertEqual(response.payload_of("error")["code"], "internal")
        self.assertNotIn("something nobody predicted", response.body)


class HealthTests(unittest.TestCase):
    def test_health_reports_the_facts_needed_to_debug_a_deploy(self):
        response = asyncio.run(_drive("GET", "/health"))
        body = json.loads(response.body)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "f1-agent")
        for key in ("model", "inference_configured", "langsmith_tracing", "runs"):
            self.assertIn(key, body)


if __name__ == "__main__":
    unittest.main()
