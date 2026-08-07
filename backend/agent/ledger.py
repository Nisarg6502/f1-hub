"""The evidence ledger — every fact the answer is allowed to assert.

Each tool call appends one entry here and returns that entry's `evidence_id`
inside its fact bundle. The orchestrator attaches those ids to its claims, and
CP64's verifier walks the finished draft asking three questions it can answer
without a model: does every claim carry a marker, does every cited id exist in
this ledger, and do the numbers in the claim appear in that entry's data.

That is the whole reason this module exists as a first-class thing rather than
a list of dicts threaded through the graph. `CHAT-AGENT-PLAN.md` §1's table:
CP38 watched a model invent a teammate relationship from correct raw data, and
CP41 watched a prompt rule fail after being restated in ALL CAPS. The
conclusion both times was the same — do not ask the model to police itself,
check it in code — and a checker needs something concrete to check *against*.

Three design choices worth stating, because each was a real fork:

**Ids are assigned by the ledger, never by the tool.** A tool that minted its
own id could collide with another tool's, and a model that saw `ev_race_1`
would start inventing plausible-looking ids of the same shape. The sequence is
opaque and monotonic (`ev_1`, `ev_2`, …), so a hallucinated citation is a
lookup miss rather than a coincidental hit.

**Framework-free on purpose.** This will live in LangGraph state from CP61
onward, but importing LangGraph here would make the tool layer untestable
without the agent stack and would tie the ledger's lifetime to a graph run.
`to_dict`/`from_dict` are the whole integration surface; a state reducer can
serialise it and hand it back without this module knowing what a reducer is.

**`as_of` is carried per entry, not per answer.** The hourly sync means Mongo
can be an hour behind, and FastF1-sourced collections can only be filled from a
local machine at all (`HANDOFF.md`), so two facts in one answer routinely have
different cutoffs. An answer-level timestamp would be a lie about whichever
half is older; per-entry stamps let the verifier and the UI say which fact is
stale rather than hedging the whole answer.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Any, Iterator

from .labels import activity_label

# `ev_` rather than something descriptive: see the module docstring on why an
# id a model could guess the shape of is worse than an opaque one.
ID_PREFIX = "ev_"

# A citation's `snippet` rides on every `sources` SSE event, one per evidence
# entry, so its size is a frame-budget question rather than a taste one: a race
# payload carries 1000+ lap rows and a driver bio carries paragraphs. Six pairs
# at 120 characters is roughly one glanceable popover — enough to show the fact
# the claim rests on, small enough that ten citations still fit in one event.
SNIPPET_MAX_PAIRS = 6
SNIPPET_MAX_VALUE = 120


def _humanise_key(key: str) -> str:
    """`race_name` → `Race name`. Raw keys must never reach a reader."""
    text = str(key).replace("_", " ").strip()
    if not text:
        return "Value"
    return text[0].upper() + text[1:]


def _scalar(value: Any) -> str | None:
    """A displayable string for a leaf value, or None if it is not a leaf.

    `None` values are dropped rather than rendered as "None" — an absent
    penalty is not a fact worth spending one of six slots on.
    """
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    try:
        text = str(value).strip()
    except Exception:
        # A value whose own __str__ raises is not worth failing a turn over.
        return None
    if not text:
        return None
    if len(text) > SNIPPET_MAX_VALUE:
        return text[: SNIPPET_MAX_VALUE - 1] + "…"
    return text


def _summarise(value: Any) -> str:
    """What a nested structure gets instead of being dumped."""
    if isinstance(value, dict):
        return f"{len(value)} fields"
    return f"{len(value)} items"


def utcnow_iso() -> str:
    """Now, in UTC, in the same ISO form every `synced_at` in Mongo uses.

    Matching that format matters: `as_of` values are compared as strings when a
    bundle is assembled from several documents (see `agent/tools/base.py`), and
    a mixed-offset timestamp would sort wrongly against them.
    """
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


@dataclass(frozen=True)
class Evidence:
    """One retrieved fact bundle, as the verifier will see it.

    Frozen because an entry the answer already cited must not change underneath
    the citation — a mutable ledger entry is a citation that can quietly stop
    supporting its claim.
    """

    evidence_id: str
    source: str
    as_of: str
    data: Any
    tool: str | None = None
    args: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "evidence_id": self.evidence_id,
            "source": self.source,
            "as_of": self.as_of,
            "data": self.data,
            "tool": self.tool,
            "args": dict(self.args or {}),
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "Evidence":
        return cls(
            evidence_id=str(raw.get("evidence_id") or ""),
            source=str(raw.get("source") or ""),
            as_of=str(raw.get("as_of") or ""),
            data=raw.get("data"),
            tool=raw.get("tool"),
            args=dict(raw.get("args") or {}),
        )

    def citation(self) -> dict:
        """The shape `sse.sources()` renders as a source card under the answer.

        `label` keeps its original raw `source` string (e.g.
        `mongo:race_results/2026-14`) for identity/debugging — CP60's
        `mongo_source()` docstring called this "deliberately readable," which
        was true for a developer but not for the end user CP68 is fixing this
        for. `title` is the new user-facing text: `activity_label(self.tool)`
        when a tool produced this entry (the overwhelming majority — every
        internal and web tool passes `tool=`), falling back to the raw
        `source` only for the rare hand-built entry with no `tool` at all.

        `kind` is derived from `source`'s own prefix convention
        (`agent/tools/base.py`'s `mongo_source`/web tools already establish
        `mongo:`/`web:` prefixes) rather than stored separately, so it can
        never drift out of sync with the string it describes.

        `n` is the evidence id's own numeric suffix, exposed directly so the
        frontend never needs to parse `ev_N` itself.

        `url` is always None for internal (`mongo:`) sources — a Mongo
        collection has no public address. For `web:`-prefixed sources it is
        pulled out of the tool's own `data` payload when one is there
        (`wikipedia_summary` carries `page_url`; `web_search`/`web_extract`
        carry it per-result, under `results`/`pages`) — see `_web_url()`
        below. It is `None` when the payload has no URL to offer (e.g. a
        failed/empty web call), which is why this is a lookup with a
        fallback rather than an assumption that one always exists.
        """
        title = activity_label(self.tool) if self.tool else self.source
        if self.source.startswith("web:wikipedia/"):
            kind = "wikipedia"
        elif self.source.startswith("web:"):
            kind = "web"
        else:
            kind = "data"
        n = int(self.evidence_id.rsplit("_", 1)[-1]) if "_" in self.evidence_id else 0
        return {
            "id": self.evidence_id,
            "n": n,
            "kind": kind,
            "label": self.source,
            "title": title,
            "url": self._web_url() if kind in ("web", "wikipedia") else None,
            "as_of": self.as_of,
            "snippet": self._snippet(),
        }

    def _snippet(self) -> list[dict]:
        """A few `{"label", "value"}` pairs rendered from `data` (CP71).

        Every other key in `citation()` describes the evidence; none of them
        *is* the evidence, so a citation pill could only ever say where a fact
        came from, never what the fact was. This is the payload itself, cut
        down to something a popover can show.

        Three deliberate limits:

        **Shallow.** Top-level scalars become pairs. One top-level list of
        dicts (`results`, `pages` — the shape every collection-ish tool
        returns) contributes its *first* entry's scalars, prefixed, because
        that first row is what the answer is most likely drawing from and a
        second row doubles the cost for almost no added meaning. Anything
        deeper is summarised (`"12 items"`), never dumped: the popover is a
        glance at the fact, not a JSON viewer.

        **Capped.** `SNIPPET_MAX_PAIRS` × `SNIPPET_MAX_VALUE` — see those
        constants for why this is a transport constraint rather than a
        styling one.

        **Total.** This runs on the answer path, after the work is already
        done, so every branch is guarded and the outermost call swallows
        anything left: a citation with an empty snippet is a small cosmetic
        loss, while a raised exception here would discard a good answer.
        """
        try:
            return self._build_snippet(self.data)
        except Exception:
            return []

    @staticmethod
    def _build_snippet(data: Any) -> list[dict]:
        pairs: list[dict] = []

        def add(label: str, value: str) -> bool:
            """Append one pair; False once the cap is reached."""
            if len(pairs) >= SNIPPET_MAX_PAIRS:
                return False
            pairs.append({"label": label, "value": value})
            return len(pairs) < SNIPPET_MAX_PAIRS

        def expand(items: list, prefix: str | None) -> None:
            """The first dict in a list, as prefixed pairs."""
            first = next((i for i in items if isinstance(i, dict)), None)
            if first is None:
                return
            for key, value in first.items():
                if str(key).startswith("_"):
                    continue
                text = _scalar(value)
                if text is None:
                    continue
                label = _humanise_key(key)
                if prefix:
                    label = f"{prefix} · {label}"
                if not add(label, text):
                    return

        if data is None:
            return []

        if isinstance(data, dict):
            for key, value in data.items():
                if str(key).startswith("_"):
                    continue
                text = _scalar(value)
                if text is not None:
                    if not add(_humanise_key(key), text):
                        break
                    continue
                if isinstance(value, list) and any(
                    isinstance(item, dict) for item in value
                ):
                    if not add(_humanise_key(key), _summarise(value)):
                        break
                    expand(value, _humanise_key(key))
                    if len(pairs) >= SNIPPET_MAX_PAIRS:
                        break
                    continue
                if isinstance(value, (dict, list, tuple, set)):
                    if not add(_humanise_key(key), _summarise(value)):
                        break
            return pairs

        if isinstance(data, (list, tuple)):
            items = list(data)
            if not add("Items", _summarise(items)):
                return pairs
            expand(items, None)
            return pairs

        text = _scalar(data)
        return [{"label": "Value", "value": text}] if text is not None else []

    def _web_url(self) -> str | None:
        """The public URL behind a `web:`-sourced entry, or `None`.

        `data`'s shape is tool-specific (`agent/tools/web.py`): a top-level
        `url`/`page_url` when the bundle describes exactly one page
        (`wikipedia_summary`), or a `results`/`pages` list of per-item dicts
        when it describes several (`web_search`/`web_extract`) — in which
        case the first item's `url` is used, since that is the result the
        agent's answer is most likely actually drawing from. Never raises on
        an unexpected shape; a missing/odd `data` payload just means no URL
        to offer, not a broken citation.
        """
        data = self.data if isinstance(self.data, dict) else {}
        url = data.get("url") or data.get("page_url")
        if url:
            return str(url)
        for key in ("results", "pages"):
            items = data.get(key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and item.get("url"):
                        return str(item["url"])
        return None


class EvidenceLedger:
    """An append-only, in-order record of everything the tools retrieved.

    Append-only is load-bearing rather than tidiness: the verifier runs *after*
    the draft is written, so an entry that could be replaced or deleted between
    the citation and the check would let an unsupported claim pass by pointing
    at evidence that has since changed shape.
    """

    def __init__(self, entries: list[Evidence] | None = None):
        self._entries: list[Evidence] = list(entries or [])
        self._by_id: dict[str, Evidence] = {e.evidence_id: e for e in self._entries}
        if len(self._by_id) != len(self._entries):
            raise ValueError("ledger entries carry duplicate evidence_ids")
        # Derived from what is already here rather than kept as a separate
        # counter, so a ledger rehydrated from state continues its own sequence
        # instead of restarting at ev_1 and colliding with its own history.
        self._next = len(self._entries) + 1

    # --- writing -----------------------------------------------------------

    def append(
        self,
        *,
        source: str,
        data: Any,
        as_of: str | None = None,
        tool: str | None = None,
        args: dict | None = None,
    ) -> Evidence:
        """Record one retrieval and return its entry.

        `as_of` defaults to now, which is correct for a fact computed on the
        spot and wrong for one read out of a stale cache — so every tool that
        reads Mongo passes the document's own `synced_at` instead. There is no
        way to enforce that here; `agent/tools/base.py` is where it is enforced.
        """
        entry = Evidence(
            evidence_id=f"{ID_PREFIX}{self._next}",
            source=source,
            as_of=as_of or utcnow_iso(),
            data=data,
            tool=tool,
            args=dict(args or {}),
        )
        self._entries.append(entry)
        self._by_id[entry.evidence_id] = entry
        self._next += 1
        return entry

    # --- reading -----------------------------------------------------------

    def get(self, evidence_id: str) -> Evidence | None:
        """The entry for an id, or None. A miss is the verifier's failure signal."""
        return self._by_id.get(evidence_id)

    def __contains__(self, evidence_id: object) -> bool:
        return evidence_id in self._by_id

    def __len__(self) -> int:
        return len(self._entries)

    def __iter__(self) -> Iterator[Evidence]:
        return iter(self._entries)

    def entries(self) -> list[Evidence]:
        """Every entry in append order. A copy — the list must not be edited."""
        return list(self._entries)

    def ids(self) -> list[str]:
        return [entry.evidence_id for entry in self._entries]

    def citations(self) -> list[dict]:
        """Every entry as a source chip, for the `sources` SSE event."""
        return [entry.citation() for entry in self._entries]

    def oldest_as_of(self) -> str | None:
        """The stalest cutoff in the ledger.

        This is what an answer should state when it needs one number: an answer
        is only as current as its oldest input, and quoting the newest would
        overstate freshness on exactly the mixed-age bundles §2 warns about.
        """
        stamps = [entry.as_of for entry in self._entries if entry.as_of]
        return min(stamps) if stamps else None

    # --- serialisation -----------------------------------------------------

    def to_dict(self) -> dict:
        """A plain-JSON form for LangGraph state and for LangSmith run metadata."""
        return {"entries": [entry.to_dict() for entry in self._entries]}

    @classmethod
    def from_dict(cls, raw: dict | None) -> "EvidenceLedger":
        entries = [Evidence.from_dict(e) for e in ((raw or {}).get("entries") or [])]
        return cls(entries)
