"""CP67's scope input guard — is this question even about Formula 1?

Rules-first, like `router.py` and for the same reason (§4.2: a model call
spent classifying is a model call not spent answering, on a GPU-time-metered
free tier). This is NOT a classifier and does not try to be one: it is a
narrow, high-confidence denylist of clearly off-topic requests, with a
generous default that lets anything ambiguous through. A false positive here
(refusing a real F1 question) is a worse failure than a false negative
(occasionally answering, or politely declining inside the graph, a question
this guard could have caught) — the system prompt already declines
off-topic questions without calling a tool (`graph.SYSTEM_PROMPT`: "If a
question is not about Formula 1 at all, decline briefly and do not call any
tool"), so this guard exists purely to save the round trip, not to be the
only line of defence.
"""

from __future__ import annotations

import re

# Broad and generous on purpose — anything that plausibly signals F1 context
# is enough to pass. Not an exhaustive driver/team/circuit roster (that would
# need a DB read, which this guard deliberately avoids to stay a pure
# function); ordinary F1 vocabulary already covers the overwhelming majority
# of real questions this app receives.
_F1_SIGNAL_RE = re.compile(
    r"\b(f1|formula\s*1|grand\s*prix|gp|race|racing|driver|team|constructor|"
    r"championship|standings|podium|pole|qualif(y|ying)|lap|pit\s*stop|"
    r"circuit|track|season|round|title|points?|dnf|paddock|sprint|"
    r"he|she|they|it)\b",
    re.IGNORECASE,
)

# A short, high-confidence list of request *shapes* this app has no business
# answering — general assistant tasks, not F1 topics some other guard might
# also mishandle. Kept short deliberately: each entry is something the
# system prompt already declines, so this only needs to catch the cases
# worth saving a round trip for.
_OFF_TOPIC_RE = re.compile(
    r"\b(weather|forecast)\b|"
    r"\b(solve|calculate)\b.*\b(equation|integral|derivative|calculus|algebra)\b|"
    r"\bwrite\s+(me\s+)?(a\s+)?(python|javascript|code|script|program|function)\b|"
    r"\brecipe\b|\bstock\s*price\b|\bmovie\s*recommendation\b",
    re.IGNORECASE,
)


def scope_guard(text: str) -> bool:
    """`True` if `text` is in-scope (or ambiguous — generous default);
    `False` only for a high-confidence off-topic match.
    """
    if not text:
        return True
    lowered = text.lower()
    if _F1_SIGNAL_RE.search(lowered):
        return True
    return not _OFF_TOPIC_RE.search(lowered)
