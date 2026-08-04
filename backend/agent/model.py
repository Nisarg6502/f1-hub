"""The model seam — the one place that knows how to talk to Ollama Cloud.

Everything above this module (the endpoint now; the deep agent from CP61) sees
`stream_chat` / `chat` and a small set of typed errors. Swapping the model, the
provider, or moving to `langchain-ollama`'s `ChatOllama` is a change to this
file alone. That is the whole point of naming it a "seam" in the plan rather
than calling Ollama from the endpoint.

Two behaviours here are inherited from CP38's post-mortem rather than invented:

- **`message.thinking` is never forwarded.** Reasoning models on Ollama Cloud
  stream raw chain-of-thought in a sibling field to `content`. Forwarding it
  leaks reasoning traces into user-facing prose, and it is not evidence-backed
  text, so it must not reach the verifier either.
- **Temperature is near-greedy.** This system narrates retrieved facts. Sampling
  variance is what produced the invented teammate relationship.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from . import config


class ModelError(Exception):
    """Base for every upstream inference failure.

    Carries an `sse_code` so the endpoint can map a failure to the SSE error
    vocabulary without re-deriving the classification from a status code.
    """

    sse_code = "upstream"

    def __init__(self, message: str, *, status: int | None = None):
        self.status = status
        super().__init__(message)


class ModelUnavailable(ModelError):
    """No API key configured — the service runs, inference does not."""

    sse_code = "at_capacity"


class ModelAtCapacity(ModelError):
    """Quota exhausted, rate limited, or payment required.

    Free-tier session limits reset every 5 hours and weekly limits every 7
    days, so this is an expected operating state rather than an exception —
    failure mode 6b in the plan. The caller degrades; it never shows a trace.
    """

    sse_code = "at_capacity"


class ModelTimeout(ModelError):
    sse_code = "timeout"


def _classify(status: int, body: str) -> ModelError:
    if status in (402, 429):
        return ModelAtCapacity(
            f"inference quota or rate limit reached (HTTP {status})", status=status
        )
    if status in (401, 403):
        # A bad key is not "at capacity" — surfacing it as such would send us
        # hunting a quota problem that does not exist.
        return ModelError(f"inference auth rejected (HTTP {status})", status=status)
    return ModelError(f"inference failed (HTTP {status}): {body[:200]}", status=status)


def _payload(messages: list[dict], *, model: str | None, tools: list[dict] | None,
             stream: bool) -> dict:
    body: dict[str, Any] = {
        "model": model or config.DEFAULT_MODEL,
        "messages": messages,
        "stream": stream,
        "options": {"temperature": config.TEMPERATURE},
    }
    if tools:
        body["tools"] = tools
    return body


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


async def stream_chat(
    messages: list[dict],
    *,
    model: str | None = None,
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Yield content deltas from one chat turn.

    Raises `ModelUnavailable` / `ModelAtCapacity` / `ModelTimeout` / `ModelError`
    rather than yielding nothing on failure. `session_recap.py` chose the
    opposite (silently yield nothing), which is right for a cached recap that
    can simply not exist — but a chat turn that produces no tokens and no error
    is indistinguishable from a hung connection, so this seam is explicit.
    """
    key = config.api_key()
    if not key:
        raise ModelUnavailable("OLLAMA_API_KEY is not configured")

    body = _payload(messages, model=model, tools=tools, stream=True)
    try:
        async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream(
                "POST",
                f"{config.OLLAMA_BASE_URL}/api/chat",
                json=body,
                headers=_headers(key),
            ) as response:
                if response.status_code != 200:
                    raw = await response.aread()
                    raise _classify(
                        response.status_code, raw.decode("utf-8", "replace")
                    )
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        # Ollama emits one JSON object per line; a partial line
                        # is a transport artefact, not a protocol error.
                        continue
                    content = ((chunk.get("message") or {}).get("content")) or ""
                    if content:
                        yield content
                    if chunk.get("done"):
                        break
    except httpx.TimeoutException as error:
        raise ModelTimeout(f"inference timed out: {error}") from error
    except httpx.HTTPError as error:
        raise ModelError(f"inference transport failed: {error}") from error


async def chat(
    messages: list[dict],
    *,
    model: str | None = None,
    tools: list[dict] | None = None,
) -> dict:
    """One buffered chat turn, returning the raw `message` object.

    Used where the *structure* of the reply matters rather than its prose —
    tool calls, and from CP64 the verifier's claim extraction. Streaming a
    reply only to reassemble it would add latency for nothing.
    """
    key = config.api_key()
    if not key:
        raise ModelUnavailable("OLLAMA_API_KEY is not configured")

    body = _payload(messages, model=model, tools=tools, stream=False)
    try:
        async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{config.OLLAMA_BASE_URL}/api/chat",
                json=body,
                headers=_headers(key),
            )
            if response.status_code != 200:
                raise _classify(response.status_code, response.text)
            return (response.json() or {}).get("message") or {}
    except httpx.TimeoutException as error:
        raise ModelTimeout(f"inference timed out: {error}") from error
    except httpx.HTTPError as error:
        raise ModelError(f"inference transport failed: {error}") from error


def tool_calls(message: dict) -> list[tuple[str, dict]]:
    """Normalise a reply's tool calls to `(name, args)` pairs.

    Ollama returns `arguments` as an object; OpenAI-compatible surfaces return
    a JSON string. Both are accepted and an unparseable value degrades to `{}`
    instead of raising — CP44's lesson applied to a model API: never build on
    the documented shape alone.
    """
    out: list[tuple[str, dict]] = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        raw = function.get("arguments")
        if isinstance(raw, str):
            try:
                args = json.loads(raw)
            except json.JSONDecodeError:
                args = {}
        elif isinstance(raw, dict):
            args = raw
        else:
            args = {}
        out.append((function.get("name") or "", args))
    return out
