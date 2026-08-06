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

        `url` is always None for internal tools — a Mongo collection has no
        public address. It is kept in the shape anyway so CP62's web tools,
        which do have one, need no second citation format.
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
            "url": None,
            "as_of": self.as_of,
        }


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
