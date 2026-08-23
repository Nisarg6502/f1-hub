"""`render_visual` — the model draws, the backend supplies the numbers.

`CHAT-VISUALS-CONTRACT.md` §2. This is the only tool in this package that is
**not a fact tool**: it retrieves nothing, computes nothing, and appends
nothing to the `EvidenceLedger`. It is a *sink*, not a source — the model hands
it drawing code plus the id of evidence it has already retrieved, and this
module joins the two and queues the result for the stream.

**Why `@fact_tool` is deliberately not used here.** It is tempting — it is one
line, and it would give this function the never-raise guarantee for free. Three
reasons against, in order of how much they would actually cost:

1. **It would return the wrong failure shape.** `fact_tool`'s handler returns
   `unavailable(...)`, i.e. `{"available": false, "reason": ...}`, and
   `tools/base.py` is explicit about what that shape *means*: `available:
   false` is "a fact about the world the answer is allowed to state" — "I don't
   have qualifying for that round" — written to be quotable in the prose. None
   of this tool's failures are facts about the world. "Your code contained
   `fetch(`" is a message to the model about its own last action, and a model
   that quoted it to the reader would be doing exactly what that contract
   invites. §2 specifies `{"ok": bool, ...}` for precisely this reason, and the
   two vocabularies should stay visibly distinct.
2. **It would advertise a contract this tool does not honour.** `tools/base.py`
   and `tools/__init__.py` both state the fact-bundle contract as a property of
   everything decorated with `@fact_tool`: pre-joined facts, an `evidence_id`,
   an `as_of` derived from the data. A reader auditing "what can this answer
   cite" by grepping for the decorator would find this and have to work out
   that it is the one exception. Better that it is not there to find.
3. **`hidden_args` is not the right mechanism for `visuals`.** `ledger` and
   `visuals` are both this package's own plumbing, meaning the same thing on
   every tool that takes one, which is `graph._HIDDEN_ARGS`'s stated criterion
   for a global entry — not a per-tool declaration.

What is kept from `fact_tool`, because it is not negotiable: **this tool never
raises.** §2 says so and `tools/base.py` explains why at length — a tool is a
leaf call inside a run that has already spent metered GPU time, and an escaping
exception there discards a whole answer to report a problem the answer could
have simply not mentioned. `_never_raises` below is the same blanket handler,
returning this tool's own failure shape instead of the fact bundle's.

**The static pre-checks in §2.3 are defence in depth, not the security
boundary.** The sandboxed iframe is — see `agent/visuals.py`'s
`FORBIDDEN_CONSTRUCTS` for the full argument, which is written where the list
lives so that anyone editing the list reads it.
"""

from __future__ import annotations

import functools
from typing import Any, Callable

from ..ledger import EvidenceLedger
from ..visuals import (
    MAX_CODE_CHARS,
    MAX_DATA_BYTES,
    VisualBuffer,
    data_size,
    forbidden_construct,
)


def _refused(reason: str, **extra: Any) -> dict:
    """The one failure shape, §2's `{"ok": false, "reason": ...}`.

    Deliberately not `base.unavailable()` — see the module docstring. `extra`
    carries the specific offending thing (which construct, which limit) so the
    model can fix its next attempt rather than retrying the same call; §2.5's
    "so it knows the call landed and does not retry" is the same concern from
    the other direction.
    """
    return {"ok": False, "reason": reason, **extra}


def _never_raises(name: str) -> Callable:
    """`fact_tool`'s blanket handler, with this tool's failure shape.

    `tool_name` and `hidden_args` are attached in the same places `fact_tool`
    attaches them, because `tools/__init__.py`'s registry and
    `graph._public_signature` read both off the function — a tool missing
    either would be registered under a name it does not answer to, or would
    offer the model an argument it must never see.
    """

    def decorate(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> dict:
            try:
                return await fn(*args, **kwargs)
            except Exception as error:  # noqa: BLE001 - see module docstring
                print(f"agent tool {name} failed: {type(error).__name__}: {error}")
                return _refused("render_failed", error=type(error).__name__)

        wrapper.tool_name = name  # type: ignore[attr-defined]
        # Nothing tool-specific to hide: `ledger` and `visuals` are both in
        # `graph._HIDDEN_ARGS` already. Set anyway so this function is shaped
        # exactly like a `fact_tool`-decorated one for anything reading it.
        wrapper.hidden_args = frozenset()  # type: ignore[attr-defined]
        return wrapper

    return decorate


@_never_raises("render_visual")
async def render_visual(
    evidence_id: str,
    title: str,
    code: str,
    caption: str = "",
    *,
    ledger: EvidenceLedger | None = None,
    visuals: VisualBuffer | None = None,
) -> dict:
    """Draw a chart from evidence you already retrieved: pass that tool result's
    `evidence_id` plus an ES module exporting `render({data, apex, mount, width})`,
    and the backend attaches the numbers. At most twice per answer, and only when
    a picture says something a sentence or a small table cannot — most answers
    need no chart. Full rules are in your instructions.

    Everything below this line is for the human reader — `graph._tool_description`
    sends the model the first paragraph only, which is why the paragraph above
    is longer than every other tool's in this package. Those are point lookups
    whose name almost says it; this one is a code-authoring call the model gets
    wrong in a specific, expensive way (a chart nobody needed, or one drawn from
    an id it never retrieved), and the moment of choosing is where the cheapest
    correction lands. The detail — the `apex` surface, the rules the code must
    follow — is in `graph._VISUAL_RULE` rather than repeated here, so the two
    cannot drift.

    The checks run in the order §2 lists them, and the order is not arbitrary:
    the cheap local ones (does this even have a code string, is it too long,
    does it contain a construct we asked against) come before the ledger lookup
    and the JSON serialisation of a payload that can be a quarter of a
    megabyte. A model that has ignored the "no imports" rule pays a substring
    scan, not a serialisation.

    Returns `{"ok": true, "visual_id": "vis_N"}` on success, or `{"ok": false,
    "reason": ...}` with one of: `unavailable`, `visual_limit_reached`,
    `invalid_arguments`, `code_too_large`, `forbidden_construct`,
    `unknown_evidence`, `data_too_large`.
    """
    # `visuals`/`ledger` are injected by `graph._bind_tool` and are only ever
    # None when something calls this outside a bound agent run. Refusing
    # (rather than asserting) keeps the never-raise promise total, including on
    # a wiring mistake.
    if visuals is None or ledger is None:
        return _refused("unavailable")

    # Checked before anything else is validated so a third call reports the cap
    # rather than reporting whichever unrelated thing the third attempt got
    # wrong. §7: two per answer, "capped at 2 by the tool".
    if visuals.is_full:
        return _refused("visual_limit_reached", limit=len(visuals))

    evidence_id = str(evidence_id or "").strip()
    title = str(title or "").strip()
    code = str(code or "")
    caption = str(caption or "")
    if not evidence_id or not title or not code.strip():
        return _refused("invalid_arguments")

    # §2.2.
    if len(code) > MAX_CODE_CHARS:
        return _refused("code_too_large", limit=MAX_CODE_CHARS, length=len(code))

    # §2.3 — defence in depth only. See `visuals.FORBIDDEN_CONSTRUCTS`.
    construct = forbidden_construct(code)
    if construct is not None:
        return _refused("forbidden_construct", construct=construct)

    # §2.1. A miss is a refusal, never a nearest-neighbour guess: the entire
    # guarantee this tool exists to give is that the numbers on screen are ones
    # the model retrieved, and resolving `ev_4` to `ev_3` because they look
    # similar would break it in the one way nobody would notice — the chart
    # would render, correctly, from the wrong evidence.
    entry = ledger.get(evidence_id)
    if entry is None:
        return _refused("unknown_evidence", evidence_id=evidence_id)

    # §2.4. Rejected rather than trimmed, and `data_size` returning None (an
    # unserialisable payload) lands here too — both mean "this cannot ride in
    # an SSE frame", which is the only question being asked.
    size = data_size(entry.data)
    if size is None or size > MAX_DATA_BYTES:
        return _refused("data_too_large", limit=MAX_DATA_BYTES, bytes=size)

    visual = visuals.append(
        evidence_id=entry.evidence_id,
        title=title,
        caption=caption,
        as_of=entry.as_of,
        # Verbatim, per §2.4 — the entry's own `data`, not a reshaping of it.
        # `Evidence` is frozen, so this reference cannot drift.
        code=code,
        data=entry.data,
    )
    # §2.5's contract with the model: the id back means "this landed", so a
    # model that gets one and then wonders whether the call worked has an
    # answer and does not spend another step re-drawing the same chart. The
    # frame itself goes out later, from `graph.astream_answer` — see
    # `agent/visuals.py`'s docstring for why the tool cannot emit it here.
    return {"ok": True, "visual_id": visual.visual_id}
