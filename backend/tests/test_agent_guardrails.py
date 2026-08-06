"""Unit tests for CP67's input guardrails — `agent/guardrails/`.

Every guard here is pure and model-free (CP38/CP41/CP64's rule extended to
input, not just output): these tests run with no network and no Ollama key.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.guardrails.pii import pii_guard


class PiiGuardTests(unittest.TestCase):
    def test_ordinary_f1_question_passes(self):
        self.assertTrue(pii_guard("Who won the last race?"))

    def test_credit_card_shaped_number_is_blocked(self):
        self.assertFalse(pii_guard("My card is 4111 1111 1111 1111, can you use it?"))

    def test_ssn_shaped_number_is_blocked(self):
        self.assertFalse(pii_guard("My SSN is 123-45-6789"))

    def test_phone_number_is_blocked(self):
        self.assertFalse(pii_guard("Call me at 555-123-4567 about the race"))

    def test_lap_time_is_not_mistaken_for_a_phone_number(self):
        # A lap time like "1:23.456" or a race number like "44" must never
        # false-positive — F1 questions are full of numbers.
        self.assertTrue(pii_guard("Hamilton's fastest lap was 1:23.456"))

    def test_empty_text_passes(self):
        self.assertTrue(pii_guard(""))

    def test_none_text_passes(self):
        self.assertTrue(pii_guard(None))  # type: ignore[arg-type]
