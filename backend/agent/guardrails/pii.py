"""CP67's PII input guard.

`f1-agent` is a public, unauthenticated endpoint on a shared free-tier quota.
It has no legitimate reason to ever process a credit card number, a national
ID, or a phone number — this app answers questions about Formula 1, not about
its callers. Refusing before the concurrency gate is entered means a PII-
carrying message never reaches a model, a log line, or a LangSmith trace.

Deliberately conservative: false positives here cost a user a rephrase,
false negatives leak PII into a trace. Patterns are shaped narrowly enough
to leave ordinary F1 numbers (lap times, race/car numbers, points, years)
untouched — see the regression tests for the exact cases that motivated
each exclusion.
"""

from __future__ import annotations

import re

# 13-19 digits in groups of 4 (with optional spaces/dashes), the shape of
# every major card network. A bare 16-digit run with no separators is also
# caught by `\d{13,19}` alone via the alternation below.
_CREDIT_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")

# US SSN shape specifically: NNN-NN-NNNN. Deliberately requires the dashes —
# lap times and race numbers never take this exact 3-2-4 grouping.
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")

# A 10-digit phone number, optionally dashed/dotted/spaced, optionally with
# a leading +1. Excludes anything containing a colon so a lap time
# ("1:23.456") or a race clock never matches — no legitimate US/CA phone
# number contains a colon.
_PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")


def pii_guard(text: str | None) -> bool:
    """`True` if `text` is safe to process; `False` if it looks like PII.

    A miss is not a security promise — this is a cheap tripwire against
    accidental paste of real personal data, not a DLP system.
    """
    if not text:
        return True
    if _SSN_RE.search(text):
        return False
    if _PHONE_RE.search(text):
        return False
    if _CREDIT_CARD_RE.search(text):
        return False
    return True
