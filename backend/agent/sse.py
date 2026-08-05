"""Server-Sent Events framing for `/api/chat`.

The event vocabulary is defined here, in code, and asserted in
`tests/test_agent_sse.py` — deliberately, because CP44's lesson was that a
*documented* output format is not evidence of the format actually produced.
The frontend parses what this module emits, so this module is the contract.

Event types, in the order a normal answer produces them:

    activity   {"label": str, "state": "start"|"done"}
        Narrates what the system is doing ("Reading Hungarian GP race
        control…"). This is what makes the agentic architecture visible in the
        UI rather than a spinner.
    token      {"text": str}
        One delta of answer text. Many of these.
    sources    {"sources": [{"id", "label", "url"|None, "as_of"}]}
        Emitted once, before `done`, so the UI can render citation chips.
    done       {"run_id": str|None, "model": str, "tier": int|None,
                 "verification": "passed"|"verification_failed"|None,
                 "cached": bool (optional), ...}
        Terminal success. The client should stop reading after this.
        `verification` is None for tier 1 (CP64 skips it there) and for the
        echo fallback — only tier 2/3 real answers carry a real value.
        `cached` (CP66) is present and `true` only when the answer was
        replayed from `agent_answer_cache` rather than freshly generated —
        absent (not `false`) on every other answer, so existing clients that
        never check for it see no shape change at all.
    error      {"code": str, "message": str}
        Terminal failure, and always a *stream* event rather than an HTTP
        error status: by the time anything goes wrong the response has already
        been committed with 200, so a status code cannot carry the failure.

`error` codes are a closed set so the UI can style them without string
matching: `at_capacity` (quota or concurrency), `timeout`, `upstream`,
`bad_request`, `internal`.
"""

from __future__ import annotations

import json
from typing import Any

# Cloud Run and most proxies buffer responses by default, which defeats
# streaming entirely — the client gets one big chunk at the end and the whole
# "tokens appear as they generate" premise silently fails in production while
# working perfectly on localhost. `X-Accel-Buffering: no` is the header that
# turns it off.
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

MEDIA_TYPE = "text/event-stream"

ERROR_CODES = frozenset(
    {"at_capacity", "timeout", "upstream", "bad_request", "internal"}
)


def frame(event: str, data: Any) -> str:
    """Encode one SSE event.

    Newlines inside `data` would terminate the frame early, so the payload is
    always JSON (which escapes them) rather than raw text. That is also why
    `token` carries `{"text": ...}` instead of the bare string — a token
    containing a newline is common in Markdown answers and would otherwise
    split into two malformed events.
    """
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def activity(label: str, state: str = "start") -> str:
    return frame("activity", {"label": label, "state": state})


def token(text: str) -> str:
    return frame("token", {"text": text})


def sources(items: list[dict]) -> str:
    return frame("sources", {"sources": items})


def done(**fields: Any) -> str:
    return frame("done", fields)


def error(code: str, message: str) -> str:
    if code not in ERROR_CODES:
        code = "internal"
    return frame("error", {"code": code, "message": message})


def comment(text: str = "") -> str:
    """An SSE comment line — a keep-alive frame clients ignore.

    **Nothing emits this yet.** It is kept because CP61 needs it and the need
    is easy to miss: once a deep agent thinks for 30-60s before its first
    token, a silent socket looks dead to intermediaries, and Cloud Run's
    300s ceiling is a long way past most idle timeouts. Emitting a comment on
    a timer keeps the connection warm without pushing an event the client
    would have to filter out.

    Wiring it needs a concurrent heartbeat task alongside the answer
    generator, which is why it is not done here — CP59 answers in seconds and
    would gain nothing from it.
    """
    return f": {text}\n\n"
