"""CP63's rules-first tier router — `CHAT-AGENT-PLAN.md` §4.2 and §6.

"The guard/router becomes rules-first, not a model call" is a decision the
plan already made, for the same reason every other cost cut in this codebase
is made: on a GPU-time-metered free tier, a model call spent classifying a
question is a model call not spent answering it. This module is pure Python,
pattern-matched against the taxonomy in §2, and unit-testable with no network
and no model.

**The tier this router assigns controls which graph `astream_answer` builds,
not which tools an already-built agent is told to prefer.** That distinction
matters: CP61's baseline already showed a flat 18-tool orchestrator wandering
to a "plausible neighbour" tool (`get_standings` instead of the
purpose-built `get_head_to_head`) even when the right tool existed
(`backend/agent/spikes/README.md` §5, run #4). Handing the *same* model an
even larger flat toolset plus four subagents would make that problem worse,
not better. So the router's real job is narrowing the surface the orchestrator
sees, and tier is the mechanism:

- **Tier 1** — CP61's exact proven behaviour: the flat set of internal data
  tools, no subagents, no `task()` dispatch, cheapest and lowest-risk. Kept as
  the *default* for anything the rules do not clearly recognise as needing
  more, deliberately — see `classify`'s docstring.
- **Tier 2** — comparative, causal, strategy and deep-history questions.
  **Classified, but routed exactly like tier 1 — see `Route.use_subagents`
  and `classify`'s docstring for why.** The original design routed tier 2 to
  the multi-agent graph on the theory that `stats-scout`'s and `historian`'s
  isolated contexts would help; a live measurement instead showed
  `stats-scout` making ten redundant tool calls and still not converging
  after 287 seconds on a question CP61's flat baseline answered correctly in
  50.9s. The label survives as telemetry (useful for CP65's golden set) even
  though it no longer changes which graph gets built.
- **Tier 3** — anything the taxonomy says needs the live web (§2 classes 8-9):
  news, rumours, future regulations, predictions. The one tier that actually
  builds the multi-agent graph, because it is the one tier with a genuine
  capability gap: `web-researcher` (CP62's quarantine-wrapped tools, wired to
  a live conversation for the first time in CP63 — see `subagents.py`) is
  otherwise unreachable, and there is no CP61 baseline for it to lose to.

A question can match more than one tier's patterns (e.g. "compare Verstappen
and Norris' chances of winning the next race" is both comparative and
predictive). Tier 3 wins ties over tier 2, and tier 2 wins over tier 1, for
classification purposes — mis-labelling a genuinely tier-3 question as tier 2
would route it to the flat graph with no web tool to recover with, so ties
break toward the tier that can actually still answer correctly, not the
cheaper label.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --------------------------------------------------------------------------
# tier 3 — live web required (taxonomy classes 8, 10 predictive)
# --------------------------------------------------------------------------

_TIER3_PATTERNS = (
    re.compile(r"\b(latest|breaking|recent)\s+news\b"),
    re.compile(r"\bnews\b"),
    re.compile(r"\brumou?r(s)?\b"),
    re.compile(r"\b(upcoming|new|future)\s+regulation"),
    re.compile(r"\bregulation(s)?\b"),
    re.compile(r"\b202[7-9]\b"),  # a season this app's own calendar does not cover
    re.compile(r"\bwho('?s| is| will)\b.*\bwin(ning)?\b.*\b(sunday|this weekend|next race)\b"),
    re.compile(r"\bwill\s+\w+\s+(win|beat|dominate|finish)\b"),
    re.compile(r"\bpredict(ion)?s?\b"),
    re.compile(r"\bsigning(s)?\b|\btransfer(s)?\b|\bcontract\s+(extension|news)\b"),
)

# --------------------------------------------------------------------------
# tier 2 — comparative / causal / strategy / deep-history (taxonomy 3-6, 11)
# --------------------------------------------------------------------------

_TIER2_PATTERNS = (
    re.compile(r"\bcompar(e|ing|ison)\b"),
    re.compile(r"\bversus\b|\bvs\.?\b"),
    re.compile(r"\bwhy (did|does|is|was)\b"),
    re.compile(r"\bhow did\b.*\b(lose|win|gain|lost|won|gained)\b"),
    re.compile(r"\b(undercut|overcut|two.?stop|one.?stop|pit strategy)\b"),
    re.compile(r"\bbetter than\b|\bgreatest (of all time|ever)\b|\bgoat\b"),
    re.compile(r"\b(most|all-?time|history|historical|ever)\b.*\b(wins?|poles?|podiums?|titles?)\b"),
    re.compile(r"\bin f1 history\b|\bsince \d{4}\b"),
)

# CP64: the two framing contracts the verifier enforces (§7) need to know
# *from the question*, not the draft, whether they apply at all — a question
# that never asked for a prediction should never pay for the check. Narrower
# than the tier-3/tier-2 pattern sets above on purpose: `_TIER3_PATTERNS`
# also matches plain news/rumour questions that are not predictions, and
# `_TIER2_PATTERNS` also matches ordinary comparisons that are not asking for
# a subjective verdict.
_PREDICTIVE_QUESTION_RE = re.compile(
    r"\bwho('?s| is| will)\b.*\bwin(ning)?\b|\bwill\s+\w+\s+(win|beat|dominate|finish)\b|"
    r"\bpredict(ion)?s?\b"
)
_SUBJECTIVE_QUESTION_RE = re.compile(r"\bbetter than\b|\bgreatest (of all time|ever)\b|\bgoat\b")

# --------------------------------------------------------------------------
# result type
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Route:
    """A tier plus the reason it was assigned, for the `done` event and tests."""

    tier: int
    reason: str
    predictive: bool = False
    subjective: bool = False

    @property
    def use_subagents(self) -> bool:
        """Only tier 3 builds CP63's multi-agent graph — tier 1 and 2 both
        use CP61's flat graph. See `classify`'s docstring: this was supposed
        to be `tier >= 2` and was downgraded after a live measurement showed
        why.
        """
        return self.tier >= 3


def classify(question: str) -> Route:
    """Assign a tier from pattern rules alone — no model call, no network.

    **Tier 2 is classified but does NOT route to the multi-agent graph.**
    That is a downgrade from this checkpoint's original design, made after a
    live measurement, and it is worth recording exactly why rather than
    quietly changing `use_subagents`'s definition: routed live against
    "Compare Verstappen and Norris this season" (a tier-2 comparative
    question, the same class CP61's own baseline answered correctly in
    50.9s — `agent/spikes/README.md` §5, run #4), the `stats-scout`
    subagent made **seven** redundant `get_session_result` calls plus three
    redundant `get_driver_season_summary` calls trying to assemble a season
    comparison round-by-round, and still had not converged after 287
    seconds. CP63's own done-criterion is explicit: "multi-agent
    **measurably** beats CP61's baseline... if it does not, we say so and
    keep the baseline." It does not, for this class, so tier 2 keeps its own
    label (useful telemetry for CP65's golden set) but is routed like tier 1.
    Tier 3 is unaffected — it is a genuine net-new capability (web access)
    CP61's flat graph has no equivalent of, so there is no baseline for it to
    lose to.

    Defaults to **tier 1**, not tier 2, when nothing matches. This is a
    deliberate asymmetry from the tier-3-wins-ties rule above: an *unmatched*
    question is not the same situation as a *tied* question. A tie means two
    real signals fired and the richer one should win; no match means no
    signal fired at all, and tier 1's toolset is a strict superset of what
    every taxonomy class 1-7 question needs (`CHAT-AGENT-PLAN.md` §2) — CP61
    already proved this exact toolset answers those classes correctly. Routing
    an unmatched question up to tier 2 by default would spend an extra model
    call and a subagent dispatch on questions the flat graph already answers,
    which is precisely the cost this router exists to avoid (§4.2).
    """
    text = (question or "").strip()
    if not text:
        return Route(tier=1, reason="empty question")

    lowered = text.lower()
    predictive = bool(_PREDICTIVE_QUESTION_RE.search(lowered))
    subjective = bool(_SUBJECTIVE_QUESTION_RE.search(lowered))

    if any(p.search(lowered) for p in _TIER3_PATTERNS):
        return Route(
            tier=3,
            reason="matched a live-web/news/prediction pattern",
            predictive=predictive,
            subjective=subjective,
        )

    if any(p.search(lowered) for p in _TIER2_PATTERNS):
        return Route(
            tier=2,
            reason="matched a comparative/causal/strategy/history pattern",
            predictive=predictive,
            subjective=subjective,
        )

    return Route(
        tier=1,
        reason="no tier-2/3 pattern matched; using the flat CP61 toolset",
        predictive=predictive,
        subjective=subjective,
    )
