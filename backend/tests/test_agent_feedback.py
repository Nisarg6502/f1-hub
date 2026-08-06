"""Tests for `POST /api/feedback` — CP69's LangSmith feedback route.

Follows `test_agent_chat.py`'s own convention: drive the ASGI app directly
rather than through `fastapi.testclient`, for the same reason that file gives
(no `httpx`/starlette version coupling). Unlike `/api/chat` this route is not
a stream, so the helper here is a much smaller single-response drive, but it
reuses the same `_drive`-style scope/receive/send plumbing.

This is telemetry, so every test is really asserting the fail-soft contract:
a `200` with `{"recorded": bool}` always, never a 500, and no LangSmith call
attempted when there is plainly nothing to attach it to (no run id, tracing
not configured).
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import main


async def _drive(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
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
        await asyncio.Event().wait()

    captured: dict = {"status": None, "chunks": []}

    async def send(message):
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                captured["chunks"].append(chunk)

    await main.app(scope, receive, send)
    body_text = b"".join(captured["chunks"]).decode("utf-8")
    return captured["status"], (json.loads(body_text) if body_text else {})


def post_feedback(payload: dict) -> tuple[int, dict]:
    return asyncio.run(_drive("POST", "/api/feedback", payload))


class RecordsWhenConfiguredTests(unittest.TestCase):
    @patch.object(main, "_TRACING_LIVE", True)
    def test_valid_thumbs_up_records_via_langsmith(self):
        fake_client = MagicMock()
        fake_client_cls = MagicMock(return_value=fake_client)
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"run_id": "run-123", "score": 1})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"recorded": True})
        fake_client.create_feedback.assert_called_once()
        args, kwargs = fake_client.create_feedback.call_args
        self.assertEqual(args[0], "run-123")
        self.assertEqual(kwargs["key"], "user-score")
        self.assertEqual(kwargs["score"], 1)

    @patch.object(main, "_TRACING_LIVE", True)
    def test_thumbs_down_with_comment_records(self):
        fake_client = MagicMock()
        fake_client_cls = MagicMock(return_value=fake_client)
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback(
                {"run_id": "run-456", "score": -1, "comment": "wrong driver"}
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, {"recorded": True})
        _, kwargs = fake_client.create_feedback.call_args
        self.assertEqual(kwargs["score"], -1)
        self.assertEqual(kwargs["comment"], "wrong driver")


class FailsSoftTests(unittest.TestCase):
    @patch.object(main, "_TRACING_LIVE", True)
    def test_null_run_id_is_a_pydantic_422_and_calls_nothing(self):
        """`run_id` is a required, non-optional `str` per the model — a JSON
        `null` fails validation before the route body runs at all, so this is
        a genuine client bug (422), not a telemetry soft-fail. The soft-fail
        path (falsy-but-valid `run_id`, e.g. `""`) is covered separately
        below, matching what the frontend can actually send once `runId`
        being falsy already suppresses the thumbs UI client-side.
        """
        fake_client_cls = MagicMock()
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"run_id": None, "score": 1})

        self.assertEqual(status, 422)
        fake_client_cls.assert_not_called()

    @patch.object(main, "_TRACING_LIVE", True)
    def test_missing_run_id_field_is_a_pydantic_422_and_calls_nothing(self):
        fake_client_cls = MagicMock()
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"score": 1})

        self.assertEqual(status, 422)
        fake_client_cls.assert_not_called()

    @patch.object(main, "_TRACING_LIVE", True)
    def test_empty_run_id_is_not_recorded_and_calls_nothing(self):
        fake_client_cls = MagicMock()
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"run_id": "", "score": 1})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"recorded": False})
        fake_client_cls.assert_not_called()

    @patch.object(main, "_TRACING_LIVE", True)
    def test_create_feedback_raising_degrades_to_not_recorded_not_500(self):
        fake_client = MagicMock()
        fake_client.create_feedback.side_effect = RuntimeError("langsmith is down")
        fake_client_cls = MagicMock(return_value=fake_client)
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"run_id": "run-789", "score": 1})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"recorded": False})

    def test_score_outside_thumb_values_is_a_422(self):
        status, _ = post_feedback({"run_id": "run-1", "score": 2})
        self.assertEqual(status, 422)

    @patch.object(main, "_TRACING_LIVE", False)
    def test_tracing_not_configured_records_nothing_and_imports_nothing(self):
        fake_client_cls = MagicMock()
        fake_langsmith = MagicMock(Client=fake_client_cls)

        with patch.dict(sys.modules, {"langsmith": fake_langsmith}):
            status, body = post_feedback({"run_id": "run-1", "score": 1})

        self.assertEqual(status, 200)
        self.assertEqual(body, {"recorded": False})
        fake_client_cls.assert_not_called()


if __name__ == "__main__":
    unittest.main()
