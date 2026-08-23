"""Generated visuals for one turn — the run-state half of `render_visual`.

`CHAT-VISUALS-CONTRACT.md` §1 is the whole design in one sentence: **the model
writes the drawing code, the backend supplies the numbers.** This module holds
the second half of that bargain. A `VisualBuffer` is created per turn beside
the `EvidenceLedger`, the `render_visual` tool appends to it mid-loop, and
`graph.astream_answer` drains it after the last answer token so `main.py` can
put the frames on the wire in the order §4 requires.

Why a buffer at all, rather than the tool emitting its own frame: the tool is
called *mid-loop*, several model turns before the answer text exists, and §4
pins the `visual` frames to a point in the stream ("after the last `token`,
before `sources`") that nothing inside a tool call can see. A tool that wrote
to the stream directly would either emit too early or need a handle on the SSE
generator, and the only way to give it one without threading it through every
binding is a process global — which is exactly what `graph.py`'s per-request
graph construction exists to avoid, for the same reason: two overlapping turns
must never be able to see each other's state.

Mirrors `ledger.py`'s posture deliberately, and for the same three reasons:

**Ids are assigned here, never by the tool or the model.** `vis_1`, `vis_2` —
opaque and monotonic, so the id in a `visual` frame is one this process minted
and can be matched against, not one a model could have guessed the shape of.

**Framework-free.** No LangGraph, no LangChain, no FastAPI. The whole thing is
a list of frozen dataclasses plus `to_dict`/`from_dict`, so the cache
round-trip (§7's last row) and every test can use it without an agent stack.

**Entries are frozen and the cap is enforced on append.** §7 allows two
visuals per answer and caps them "by the tool"; enforcing it on the container
rather than in the tool's own bookkeeping means the cap survives the repair
loop, where the tool function is called again from a second graph run against
the same turn's state.

The size limits below are transport limits, not taste. Each visual rides
inside one SSE frame with its data inlined, and the frontend inlines the same
payload into an `srcdoc`; §2 says to *reject* an oversized payload rather than
trim it, because a truncated `data` is a chart that silently draws a subset of
the facts and looks completely fine doing it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

# `vis_` mirrors `ledger.ID_PREFIX`'s reasoning: an opaque sequence, so a
# frontend or a future inline-marker scheme can key on an id this process
# actually issued.
ID_PREFIX = "vis_"

# §7: "Two visuals for one answer — allowed, capped at 2 by the tool." Two is
# the point at which a chat answer stops being an answer with a picture in it
# and becomes a dashboard; the cap is also what stops one turn from spending
# its whole step budget writing chart code.
MAX_VISUALS = 2

# §2.2, verbatim. Generous enough for a real hand-written chart with axes,
# legend and tooltips; small enough that two of them plus the answer text and
# the sources still fit comfortably in one response.
MAX_CODE_CHARS = 24_000

# §2.4. Measured on the serialised JSON in UTF-8 bytes, because that is what
# actually travels — a payload of 200k characters of non-ASCII is not 200KB.
MAX_DATA_BYTES = 256 * 1024

# §2's signature comments. Unlike the two above these are *clamped* rather
# than rejected — see `VisualBuffer.append`.
MAX_TITLE_CHARS = 80
MAX_CAPTION_CHARS = 200

# §2.3's list, verbatim and in the contract's order.
#
# **These are defence in depth. They are NOT the security boundary.**
#
# The boundary is the sandboxed iframe in §5: `sandbox="allow-scripts"` with no
# `allow-same-origin`, i.e. an opaque origin that cannot reach the parent DOM,
# cookies, storage or the network *whatever* the code in it says. That is a
# browser-enforced capability boundary. This tuple is a substring scan over
# JavaScript source, and a substring scan over JavaScript source can always be
# defeated — `window["fet"+"ch"]` is not in this list and never will be.
#
# The distinction matters because of how this list will be *loosened*. Sooner
# or later a legitimate visual will trip one of these entries (a series named
# `imports`, a variable called `topLine`) and someone will relax the rule. That
# is fine, and it is fine precisely because these checks were never what kept
# the frame harmless. What would not be fine is the reverse reasoning: treating
# this list as the control, concluding the sandbox attribute is therefore
# belt-and-braces, and dropping `allow-same-origin` back in to make something
# convenient work. If you are here to change this tuple, the question to ask is
# "does the sandbox still have no `allow-same-origin`?" — not "is this regex
# still tight enough?".
#
# What the list *is* good for: catching a model that has drifted into writing
# ordinary bundler-shaped JavaScript (`import * as d3 from "d3"`) and telling
# it so in the tool result, so it rewrites against `apex` instead of shipping a
# frame that would throw on load. It is a fast, cheap prompt-adherence check
# with a legible failure message, and that is the whole of its job.
FORBIDDEN_CONSTRUCTS: tuple[str, ...] = (
    "import ",
    "require(",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "eval(",
    "new Function",
    "document.cookie",
    "localStorage",
    "sessionStorage",
    "parent.",
    "top.",
    "window.open",
)


def forbidden_construct(code: str) -> str | None:
    """The first §2.3 construct present in `code`, or None. See above."""
    for needle in FORBIDDEN_CONSTRUCTS:
        if needle in code:
            return needle
    return None


def data_size(data: Any) -> int | None:
    """The serialised size of `data` in bytes, or None if it will not serialise.

    An unserialisable payload is rejected in the same breath as an oversized
    one rather than raising: a ledger entry holding something `json.dumps`
    cannot handle would blow up in `sse.frame` instead, i.e. *after* the answer
    is already streaming, which is the one place a failure costs the reader
    their whole turn.
    """
    try:
        return len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return None


def _clamp(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass(frozen=True)
class Visual:
    """One generated visual, in exactly the shape §4 puts on the wire.

    Frozen for `Evidence`'s reason: `data` here is a ledger entry's `data`, and
    a visual whose payload could be edited after the fact would be a chart that
    silently stops matching the evidence it claims to be drawn from.
    """

    visual_id: str
    evidence_id: str
    title: str
    caption: str
    as_of: str
    code: str
    data: Any = None

    def to_dict(self) -> dict:
        # Key order follows §4's example. JSON objects are unordered and no
        # parser cares, but a developer diffing a real frame against the
        # contract does.
        return {
            "visual_id": self.visual_id,
            "evidence_id": self.evidence_id,
            "title": self.title,
            "caption": self.caption,
            "as_of": self.as_of,
            "code": self.code,
            "data": self.data,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "Visual":
        raw = raw or {}
        return cls(
            visual_id=str(raw.get("visual_id") or ""),
            evidence_id=str(raw.get("evidence_id") or ""),
            title=str(raw.get("title") or ""),
            caption=str(raw.get("caption") or ""),
            as_of=str(raw.get("as_of") or ""),
            code=str(raw.get("code") or ""),
            data=raw.get("data"),
        )


class VisualBuffer:
    """The visuals one turn has produced, in call order.

    Append-only within a turn, like the ledger, and for a weaker but real
    version of the same reason: `graph.astream_answer` drains this *after* the
    verify-and-repair step, so a buffer whose entries could be replaced would
    let a repair run swap the payload under a visual the first draft already
    committed to.
    """

    def __init__(self, visuals: list[Visual] | None = None):
        self._visuals: list[Visual] = list(visuals or [])

    def __len__(self) -> int:
        return len(self._visuals)

    def __iter__(self):
        return iter(self._visuals)

    @property
    def is_full(self) -> bool:
        return len(self._visuals) >= MAX_VISUALS

    def append(
        self,
        *,
        evidence_id: str,
        title: str,
        caption: str,
        as_of: str,
        code: str,
        data: Any,
    ) -> Visual:
        """Record one visual and return it. Raises when full — callers check.

        `data` is stored **by reference, verbatim**. §2.4 is explicit that the
        ledger entry's `data` is attached with "no reshaping, no truncation, no
        normalising", and the ledger's own `Evidence` is frozen, so there is
        nothing here to defensively copy against. A copy would also double the
        memory cost of a large bundle for no gain.

        `title` and `caption` are the one place this module normalises rather
        than rejects, and that is a deliberate departure from the "reject, do
        not trim" rule above. That rule exists because trimmed *data* is a
        chart that draws the wrong facts while looking right. A trimmed caption
        is a slightly shorter caption. Losing an otherwise-valid visual — one
        whose code passed every check and whose numbers are the ledger's —
        because the model wrote an 84-character title would be a worse trade
        than an ellipsis, so the chrome clamps and the payload does not.
        """
        if self.is_full:
            raise ValueError("visual buffer is full")
        visual = Visual(
            visual_id=f"{ID_PREFIX}{len(self._visuals) + 1}",
            evidence_id=evidence_id,
            title=_clamp(title, MAX_TITLE_CHARS),
            caption=_clamp(caption, MAX_CAPTION_CHARS),
            as_of=as_of,
            code=code,
            data=data,
        )
        self._visuals.append(visual)
        return visual

    def frames(self) -> list[dict]:
        """Every visual as an §4 payload, in call order."""
        return [visual.to_dict() for visual in self._visuals]

    @classmethod
    def from_dicts(cls, raw: list[dict] | None) -> "VisualBuffer":
        """Rehydrate from stored frames — the answer cache's replay path.

        §7's last row: visuals "are pure functions of `(code, data)`", so a
        replay needs nothing from the run that produced them. That is only true
        because the data was attached here rather than fetched at render time;
        a visual that re-read the ledger on display would be a different chart
        after a sync.
        """
        return cls([Visual.from_dict(item) for item in (raw or []) if item])
