import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import llm

FALLBACK_ENV = {
    "LLM_FALLBACK_BASE_URL": "https://fallback.test/v1",
    "LLM_FALLBACK_API_KEY": "fb-key",
    "LLM_FALLBACK_MODEL": "fb-model",
}


def ndjson(*objects) -> bytes:
    return "".join(json.dumps(o) + "\n" for o in objects).encode()


def sse(*objects, done=True) -> bytes:
    lines = [f"data: {json.dumps(o)}\n\n" for o in objects]
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def delta(content=None, finish=None, **extra):
    d = {"content": content} if content is not None else {}
    d.update(extra)
    return {"choices": [{"delta": d, "finish_reason": finish}]}


class LlmTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"OLLAMA_API_KEY": "primary-key"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for key in FALLBACK_ENV:
            os.environ.pop(key, None)
        self.requests = []

    def use_fallback(self):
        os.environ.update(FALLBACK_ENV)

    def run_stream(self, handler, **kwargs):
        def record_and_handle(request):
            self.requests.append(request)
            return handler(request)

        def make_client(timeout_s):
            return httpx.AsyncClient(transport=httpx.MockTransport(record_and_handle))

        result = llm.StreamResult()

        async def drain():
            return "".join(
                [chunk async for chunk in llm.stream_text("system", "facts", result=result, **kwargs)]
            )

        with patch.object(llm, "_make_client", make_client):
            text = asyncio.run(drain())
        return text, result

    def hosts(self):
        return [r.url.host for r in self.requests]

    def test_ollama_success_streams_content_and_marks_complete(self):
        def handler(request):
            return httpx.Response(
                200,
                content=ndjson(
                    {"message": {"content": "Hello"}},
                    {"message": {"content": " world"}},
                    {"done": True},
                ),
            )

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Hello world")
        self.assertEqual(result.provider, "ollama")
        self.assertTrue(result.complete)
        self.assertIsNone(result.failure)
        sent = self.requests[0]
        self.assertEqual(sent.url.host, "ollama.com")
        self.assertEqual(sent.headers["authorization"], "Bearer primary-key")
        body = json.loads(sent.content)
        self.assertTrue(body["stream"])
        self.assertEqual(body["messages"][0], {"role": "system", "content": "system"})
        self.assertEqual(body["messages"][1], {"role": "user", "content": "facts"})

    def test_thinking_is_never_forwarded(self):
        def handler(request):
            return httpx.Response(
                200,
                content=ndjson(
                    {"message": {"thinking": "secret reasoning", "content": ""}},
                    {"message": {"content": "Answer"}},
                    {"done": True},
                ),
            )

        text, _ = self.run_stream(handler)

        self.assertEqual(text, "Answer")

    def test_402_falls_back_to_openai_compatible(self):
        self.use_fallback()

        def handler(request):
            if request.url.host == "ollama.com":
                return httpx.Response(402, json={"error": "payment required"})
            return httpx.Response(
                200,
                content=sse(delta("Hi"), delta(finish="stop")),
            )

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Hi")
        self.assertEqual(result.provider, "fallback")
        self.assertTrue(result.complete)
        sent = self.requests[-1]
        self.assertEqual(str(sent.url), "https://fallback.test/v1/chat/completions")
        body = json.loads(sent.content)
        self.assertEqual(body["model"], "fb-model")
        self.assertTrue(body["stream"])
        self.assertEqual(sent.headers["authorization"], "Bearer fb-key")

    def test_no_fallback_configured_402_yields_nothing(self):
        def handler(request):
            return httpx.Response(402, json={"error": "payment required"})

        text, result = self.run_stream(handler)

        self.assertEqual(text, "")
        self.assertEqual(result.failure, "capacity")
        self.assertFalse(result.complete)
        self.assertIsNone(result.provider)

    def test_429_is_also_capacity(self):
        def handler(request):
            return httpx.Response(429)

        _, result = self.run_stream(handler)

        self.assertEqual(result.failure, "capacity")

    def test_other_http_errors_are_plain_errors(self):
        def handler(request):
            return httpx.Response(500)

        _, result = self.run_stream(handler)

        self.assertEqual(result.failure, "error")

    def test_cut_off_stream_is_incomplete_and_does_not_fall_back(self):
        self.use_fallback()

        def handler(request):
            if request.url.host == "ollama.com":
                # Text arrived, then the stream ended with no `done`.
                return httpx.Response(200, content=ndjson({"message": {"content": "Partial"}}))
            return httpx.Response(200, content=sse(delta("Other recap")))

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Partial")
        self.assertFalse(result.complete)
        self.assertEqual(self.hosts().count("fallback.test"), 0)

    def test_in_stream_quota_error_before_any_text_falls_back(self):
        self.use_fallback()

        def handler(request):
            if request.url.host == "ollama.com":
                return httpx.Response(
                    200, content=ndjson({"error": "you have reached your usage quota"})
                )
            return httpx.Response(200, content=sse(delta("Backup")))

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Backup")
        self.assertEqual(result.provider, "fallback")

    def test_missing_ollama_key_uses_fallback(self):
        os.environ.pop("OLLAMA_API_KEY", None)
        self.use_fallback()

        def handler(request):
            return httpx.Response(200, content=sse(delta("Hello")))

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Hello")
        self.assertEqual(result.provider, "fallback")
        self.assertEqual(self.hosts(), ["fallback.test"])

    def test_missing_ollama_key_and_no_fallback_is_unconfigured(self):
        os.environ.pop("OLLAMA_API_KEY", None)

        text, result = self.run_stream(lambda request: httpx.Response(200))

        self.assertEqual(text, "")
        self.assertEqual(result.failure, "unconfigured")
        self.assertEqual(self.requests, [])

    def test_fallback_ignores_reasoning_fields(self):
        self.use_fallback()
        os.environ.pop("OLLAMA_API_KEY", None)

        def handler(request):
            return httpx.Response(
                200,
                content=sse(
                    delta(None, reasoning="private thoughts"),
                    delta("A", reasoning_content="more private thoughts"),
                    delta(finish="stop"),
                ),
            )

        text, _ = self.run_stream(handler)

        self.assertEqual(text, "A")

    def test_fallback_length_finish_is_not_complete(self):
        self.use_fallback()
        os.environ.pop("OLLAMA_API_KEY", None)

        def handler(request):
            return httpx.Response(200, content=sse(delta("Cut"), delta(finish="length")))

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Cut")
        self.assertFalse(result.complete)

    def test_ollama_length_stop_is_not_complete(self):
        """`done` with `done_reason: length` is a token-limit cut, not a finished recap."""

        def handler(request):
            return httpx.Response(
                200,
                content=ndjson({"message": {"content": "Cut"}}, {"done": True, "done_reason": "length"}),
            )

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Cut")
        self.assertFalse(result.complete)
        self.assertEqual(result.failure, "error")

    def test_ollama_stop_reason_is_complete(self):
        def handler(request):
            return httpx.Response(
                200,
                content=ndjson({"message": {"content": "Done"}}, {"done": True, "done_reason": "stop"}),
            )

        _, result = self.run_stream(handler)

        self.assertTrue(result.complete)

    def test_fallback_content_filter_is_not_complete(self):
        self.use_fallback()
        os.environ.pop("OLLAMA_API_KEY", None)

        def handler(request):
            return httpx.Response(200, content=sse(delta("Partial"), delta(finish="content_filter")))

        text, result = self.run_stream(handler)

        self.assertEqual(text, "Partial")
        self.assertFalse(result.complete)

    def test_non_object_json_from_ollama_is_skipped_not_raised(self):
        def handler(request):
            return httpx.Response(
                200,
                content=ndjson(
                    123,
                    {"message": "just a string"},
                    {"message": {"content": "ok"}},
                    {"done": True},
                ),
            )

        text, result = self.run_stream(handler)

        self.assertEqual(text, "ok")
        self.assertTrue(result.complete)

    def test_non_object_json_from_the_fallback_is_skipped_not_raised(self):
        self.use_fallback()
        os.environ.pop("OLLAMA_API_KEY", None)

        def handler(request):
            return httpx.Response(
                200,
                content=sse([1, 2], {"choices": [None]}, {"choices": [{"delta": "x"}]}, delta("ok"), delta(finish="stop")),
            )

        text, result = self.run_stream(handler)

        self.assertEqual(text, "ok")
        self.assertTrue(result.complete)

    def test_an_unexpected_exception_mid_stream_never_escapes(self):
        class Exploding(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield ndjson({"message": {"content": "Hi"}})
                raise RuntimeError("transport blew up")

        text, result = self.run_stream(lambda request: httpx.Response(200, stream=Exploding()))

        self.assertEqual(text, "Hi")
        self.assertFalse(result.complete)
        self.assertEqual(result.failure, "error")

    def test_stray_whitespace_in_the_ollama_key_is_stripped(self):
        os.environ["OLLAMA_API_KEY"] = "  primary-key\n"

        def handler(request):
            return httpx.Response(200, content=ndjson({"message": {"content": "x"}}, {"done": True}))

        self.run_stream(handler)

        self.assertEqual(self.requests[0].headers["authorization"], "Bearer primary-key")

    def test_a_blank_ollama_key_counts_as_unconfigured(self):
        os.environ["OLLAMA_API_KEY"] = "   "

        text, result = self.run_stream(lambda request: httpx.Response(200))

        self.assertEqual(text, "")
        self.assertEqual(result.failure, "unconfigured")
        self.assertEqual(self.requests, [])

    def test_fallback_configured_needs_all_three_variables(self):
        self.assertFalse(llm.fallback_configured())
        os.environ["LLM_FALLBACK_BASE_URL"] = "https://fallback.test/v1"
        os.environ["LLM_FALLBACK_API_KEY"] = "fb-key"
        self.assertFalse(llm.fallback_configured())
        os.environ["LLM_FALLBACK_MODEL"] = "fb-model"
        self.assertTrue(llm.fallback_configured())


if __name__ == "__main__":
    unittest.main()
