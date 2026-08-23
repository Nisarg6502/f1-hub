"""Server-Sent Events framing for `/api/chat`.

The event vocabulary is defined here, in code, and asserted in
`tests/test_agent_sse.py` — deliberately, because CP44's lesson was that a
*documented* output format is not evidence of the format actually produced.
The frontend parses what this module emits, so this module is the contract.

Event types, in the order a normal answer produces them:

    activity   {"label": str, "state": "start"|"done", "detail": str|None,
                 "kind": "tool"|"agent"|"system", "at": str|None}
        Narrates what the system is doing ("Reading Hungarian GP race
        control…"). This is what makes the agentic architecture visible in the
        UI rather than a spinner. `detail` (CP68) is the human-legible
        argument behind a tool call — a search query, a page title — when one
        exists; `None` for tools with no single legible argument (internal
        data lookups keyed by raw ids) and for `kind="system"` events (queue
        waits, "Thinking…", the echo notice). `kind` distinguishes a direct
        tool call from a delegated subagent call (`"agent"`) from a
        system-level narration (`"system"`), so the UI can style each
        differently. `at` is a live ISO-8601 UTC timestamp set when the event
        is actually put on the wire, not when the underlying tool call
        started — always present.
    token      {"text": str}
        One delta of answer text. Many of these.
    visual     {"visual_id": str, "evidence_id": str, "title": str,
                 "caption": str, "as_of": str, "code": str, "data": any}
        A generated visualisation — `CHAT-VISUALS-CONTRACT.md` §4. `code` is
        an ES module the *model* wrote; `data` is the cited ledger entry's
        payload, attached verbatim by the backend, which is what makes the
        chart structurally incapable of showing a number the tools did not
        retrieve. Emitted after the last `token` and before `sources`, zero to
        two per answer, rendered in arrival order. Additive by construction:
        `agent-api.ts`'s `dispatch` ignores unknown event types, so a client
        built before this existed sees an answer with no picture rather than a
        parse error.
    sources    {"sources": [{"id", "n", "kind", "label", "title", "url"|None,
                              "as_of", "snippet", "anchors": [...]}],
                 "anchors": [{"evidence_id", "text", "start", "end", "claim",
                              "field", "value", "path", "row"}]}
        Emitted once, before `done`. From CP72 the list is the answer's
        *anchor* set, not everything the tools retrieved: an entry the answer
        never cited is no longer listed (it stays in the ledger for the
        verifier and for tracing). Each anchor names a span of the answer text
        and the field and row of the evidence proving it, so a citation can
        point at the value that answers the question instead of at the bundle
        it came from. `anchors` is the same set flattened into draft order.
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
    suggestions {"suggestions": [str, ...]}
        CP75's follow-up chips. **The one event emitted AFTER `done`**, which
        reads like a protocol violation and is the point: generating them
        costs a model call, and a reader must never wait on their own chips.
        `done` still means "the answer is complete"; a client that stops
        reading there loses nothing but the chips, which is the correct
        degrade for an additive surface. Never empty — `followups.suggest`
        returns `[]` for every failure and for a set the router emptied, and
        `main.py` skips the frame entirely rather than sending one, so the
        frontend has no "zero chips" state to render.
    error      {"code": str, "message": str}
        Terminal failure, and always a *stream* event rather than an HTTP
        error status: by the time anything goes wrong the response has already
        been committed with 200, so a status code cannot carry the failure.

`error` codes are a closed set so the UI can style them without string
matching: `at_capacity` (quota or concurrency), `timeout`, `upstream`,
`bad_request`, `internal`, `refused` (CP67 input guardrail).
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
    {"at_capacity", "timeout", "upstream", "bad_request", "internal", "refused"}
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


def token(text: str) -> str:
    return frame("token", {"text": text})


def visual(
    *,
    visual_id: str,
    evidence_id: str,
    title: str,
    code: str,
    data: Any,
    as_of: str,
    caption: str = "",
) -> str:
    """One generated visualisation — `CHAT-VISUALS-CONTRACT.md` §4.

    Keyword-only, and that is worth a sentence: seven fields of which five are
    strings, three of which (`visual_id`, `evidence_id`, `title`) would swap
    silently and produce a frame that renders a chart under the wrong caption
    citing the wrong entry. There is no positional call of this that is easier
    to read than the keyword one.

    `caption` defaults to `""` rather than being optional, because §4's shape
    always carries the key — the frontend reads it unconditionally, exactly as
    it does `sources`' `anchors`.

    `data` is passed through untouched. Anything that reshapes, rounds or
    truncates it here would break the guarantee the whole feature rests on:
    that every number in the picture is one the ledger actually holds. Size is
    bounded upstream in `tools/visual.py` (§2.4), by rejecting an oversized
    payload rather than trimming one.
    """
    return frame(
        "visual",
        {
            "visual_id": visual_id,
            "evidence_id": evidence_id,
            "title": title,
            "caption": caption,
            "as_of": as_of,
            "code": code,
            "data": data,
        },
    )


def sources(items: list[dict], anchors: list[dict] | None = None) -> str:
    """The evidence behind the answer: which records, and where in them.

    Two views of one anchor set, which is the point rather than duplication.
    `sources` is grouped by record for the strip under the answer; `anchors` is
    flat and in draft order for marking values inline. CP71 shipped those two
    surfaces derived from *different* sets and they disagreed about how many
    citations an answer had; deriving both from one set is what makes that
    disagreement unrepresentable.

    `anchors` defaults to `[]` rather than being omitted, so a client can read
    the key unconditionally — including on the paths that legitimately have no
    anchors to offer, such as an echo fallback or a cached answer written
    before this checkpoint.
    """
    return frame("sources", {"sources": items, "anchors": list(anchors or [])})


def suggestions(items: list[str]) -> str:
    """CP75's follow-up chips, after `done`. See this module's docstring."""
    return frame("suggestions", {"suggestions": list(items)})


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
