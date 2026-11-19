"""One place that asks a language model for one-shot prose.

Session recaps, strategy commentary and the driver head-to-head each used to
carry their own copy of the same Ollama Cloud call, and each treated a failure
the same way: yield nothing, so the page quietly drops the card. That is how
every AI card went blank when Ollama Cloud's usage cap started answering HTTP
402 (production logs, 2026-11-10 onwards). This module is the single call, with
two additions:

- An optional second provider. If `LLM_FALLBACK_BASE_URL`,
  `LLM_FALLBACK_API_KEY` and `LLM_FALLBACK_MODEL` are all set, it is asked
  (OpenAI-compatible `/chat/completions`) when Ollama Cloud refuses or fails
  before writing a single character. Without them nothing changes.
- A `StreamResult` the caller can read afterwards. `complete` is true only when
  a provider closed its stream cleanly, which is what a caller must check
  before caching the text: a stream cut off part-way looks exactly like a
  short answer.

The agent (`backend/agent/`) has its own model seam and is not routed through
here; it needs tool calling, which this does not.

Never raises. A failure is one log line and a `StreamResult.failure`.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

OLLAMA_BASE = "https://ollama.com"
DEFAULT_MODEL = "gpt-oss:120b"

_FALLBACK_ENV = ("LLM_FALLBACK_BASE_URL", "LLM_FALLBACK_API_KEY", "LLM_FALLBACK_MODEL")

# Ollama reports in-stream problems as prose, not codes, so classification is a
# string match, kept narrow: over-matching would call an outage a quota problem.
_CAPACITY_RE = re.compile(r"quota|rate.?limit|too many requests|usage limit|capacity|insufficient", re.I)


@dataclass
class StreamResult:
    """What happened, readable once the stream has ended."""

    # Which provider is responsible for the text: "ollama", "fallback", or
    # None when neither produced a successful response.
    provider: str | None = None
    # True only when the provider closed its stream cleanly. Never cache text
    # while this is False.
    complete: bool = False
    # The last failure seen: "unconfigured", "capacity" or "error". It can be
    # set even when the fallback then succeeded (the primary's failure).
    failure: str | None = None


def fallback_configured() -> bool:
    return all((os.getenv(name) or "").strip() for name in _FALLBACK_ENV)


def _make_client(timeout_s: float) -> httpx.AsyncClient:
    # The one place tests replace, so no test ever touches the network.
    return httpx.AsyncClient(timeout=timeout_s)


def _fail(result: StreamResult, provider: str, failure: str, status: int | None = None, detail: str | None = None) -> None:
    result.failure = failure
    if status is not None:
        suffix = f" (HTTP {status})"
    elif detail:
        suffix = f" ({detail[:120]})"
    else:
        suffix = ""
    print(f"LLM {provider} failed: {failure}{suffix}")


def _classify_status(status: int) -> str:
    return "capacity" if status in (402, 429) else "error"


def _classify_message(message: str) -> str:
    return "capacity" if _CAPACITY_RE.search(message) else "error"


async def _stream_ollama(
    system_prompt: str,
    user_content: str,
    *,
    model: str | None,
    temperature: float,
    timeout_s: float,
    result: StreamResult,
) -> AsyncIterator[str]:
    payload = {
        "model": model or os.getenv("OLLAMA_MODEL") or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "stream": True,
        # Near-greedy: these are factual summaries, and sampling variance is
        # what produced the original recap hallucination.
        "options": {"temperature": temperature},
    }
    headers = {"Authorization": f"Bearer {os.getenv('OLLAMA_API_KEY')}"}
    try:
        async with _make_client(timeout_s) as client:
            async with client.stream("POST", f"{OLLAMA_BASE}/api/chat", json=payload, headers=headers) as response:
                if response.status_code != 200:
                    _fail(result, "ollama", _classify_status(response.status_code), status=response.status_code)
                    return
                result.provider = "ollama"
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("error"):
                        message = str(chunk["error"])
                        _fail(result, "ollama", _classify_message(message), detail=message)
                        return
                    # Only `content`. `thinking` is raw chain-of-thought and
                    # must never reach a reader.
                    content = (chunk.get("message") or {}).get("content") or ""
                    if content:
                        yield content
                    if chunk.get("done"):
                        result.complete = True
                        break
                else:
                    _fail(result, "ollama", "error", detail="stream ended before done")
    except httpx.HTTPError as error:
        _fail(result, "ollama", "error", detail=str(error))


async def _stream_fallback(
    system_prompt: str,
    user_content: str,
    *,
    temperature: float,
    timeout_s: float,
    result: StreamResult,
) -> AsyncIterator[str]:
    base = os.environ["LLM_FALLBACK_BASE_URL"].strip().rstrip("/")
    payload = {
        "model": os.environ["LLM_FALLBACK_MODEL"].strip(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "stream": True,
        "temperature": temperature,
    }
    headers = {"Authorization": f"Bearer {os.environ['LLM_FALLBACK_API_KEY'].strip()}"}
    finished = False
    truncated = False
    try:
        async with _make_client(timeout_s) as client:
            async with client.stream("POST", f"{base}/chat/completions", json=payload, headers=headers) as response:
                if response.status_code != 200:
                    _fail(result, "fallback", _classify_status(response.status_code), status=response.status_code)
                    return
                result.provider = "fallback"
                async for raw in response.aiter_lines():
                    line = raw.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        finished = True
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("error"):
                        message = json.dumps(chunk["error"]) if not isinstance(chunk["error"], str) else chunk["error"]
                        _fail(result, "fallback", _classify_message(message), detail=message)
                        return
                    choice = (chunk.get("choices") or [{}])[0]
                    # Only `content`: `reasoning` / `reasoning_content` are
                    # chain-of-thought and are dropped, as for the primary.
                    content = (choice.get("delta") or {}).get("content") or ""
                    if content:
                        yield content
                    finish = choice.get("finish_reason")
                    if finish == "length":
                        truncated = True
                    elif finish:
                        finished = True
    except httpx.HTTPError as error:
        _fail(result, "fallback", "error", detail=str(error))
        return
    if finished and not truncated:
        result.complete = True
    else:
        _fail(result, "fallback", "error", detail="truncated" if truncated else "stream ended early")


async def stream_text(
    system_prompt: str,
    user_content: str,
    *,
    model: str | None = None,
    temperature: float = 0.2,
    result: StreamResult | None = None,
    timeout_s: float = 180.0,
) -> AsyncIterator[str]:
    """Yield the model's reply as content deltas.

    Pass a `StreamResult` and read it after the stream ends; check `complete`
    before caching. The fallback is tried only when the primary produced
    nothing, so a reader never gets one recap glued to another.
    """
    result = result if result is not None else StreamResult()
    emitted = False

    if not os.getenv("OLLAMA_API_KEY"):
        result.failure = "unconfigured"
    else:
        async for text in _stream_ollama(
            system_prompt,
            user_content,
            model=model,
            temperature=temperature,
            timeout_s=timeout_s,
            result=result,
        ):
            emitted = True
            yield text

    if result.complete or emitted or not fallback_configured():
        return

    # The primary's response (if any) is not the one the reader gets.
    result.provider = None
    async for text in _stream_fallback(
        system_prompt,
        user_content,
        temperature=temperature,
        timeout_s=timeout_s,
        result=result,
    ):
        yield text
