"""CP67's input guardrails — the single entry point `main.py` calls.

Three independent, model-free checks, run in order, cheapest and most
common first: is this in scope, is it a prompt-injection attempt, does it
contain personal data. All three exist for the same reason (CP38/CP41/CP64):
do not trust a model to police itself, check it in code — extended here to
the input side, where nothing in this codebase checked anything before.

Run *before* `main.py` enters the concurrency gate or creates an evidence
ledger, so a refusal costs no quota and produces no trace — a guard that
still spends an agent run on a question it was going to refuse anyway would
defeat half the point of having one on a service capped at one concurrent
model.
"""

from __future__ import annotations

from dataclasses import dataclass

from .injection import injection_guard
from .pii import pii_guard
from .scope import scope_guard

__all__ = ["GuardVerdict", "check_input"]


@dataclass(frozen=True)
class GuardVerdict:
    allowed: bool
    code: str | None = None
    reason: str | None = None


_ALLOWED = GuardVerdict(allowed=True)


def check_input(text: str) -> GuardVerdict:
    if not scope_guard(text):
        return GuardVerdict(
            allowed=False,
            code="scope",
            reason="This assistant answers questions about Formula 1 only.",
        )
    if not injection_guard(text):
        return GuardVerdict(
            allowed=False,
            code="injection",
            # "That message could not be processed" described a fault, not a
            # decision, and the panel pairs a refusal with a Retry button — so
            # it read as a transient error and invited the user to press Retry
            # until they gave up. Name what happened instead: this is a refusal
            # and retrying the same text will refuse again. Deliberately says
            # nothing about WHICH pattern matched; that is a detector hint.
            reason="I can't act on that request. Ask me about Formula 1 "
            "instead — a race, a driver, a season, or its history.",
        )
    if not pii_guard(text):
        return GuardVerdict(
            allowed=False,
            code="pii",
            reason="Please don't share personal information like card numbers, "
            "SSNs, or phone numbers here — this assistant only needs your "
            "F1 question.",
        )
    return _ALLOWED
