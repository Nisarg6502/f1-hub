import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import capacity


class CapacityBreakerTests(unittest.TestCase):
    def setUp(self):
        capacity.clear()
        self.addCleanup(capacity.clear)

    def test_open_after_record_and_closed_after_cooldown(self):
        capacity.record_exhausted(now=1000)

        self.assertEqual(capacity.exhausted_until(now=1000), 1000 + capacity.COOLDOWN_S)
        self.assertEqual(capacity.exhausted_until(now=1000 + capacity.COOLDOWN_S - 1), 1000 + capacity.COOLDOWN_S)
        self.assertIsNone(capacity.exhausted_until(now=1000 + capacity.COOLDOWN_S))

    def test_starts_closed(self):
        self.assertIsNone(capacity.exhausted_until(now=1000))

    def test_clear_closes(self):
        capacity.record_exhausted(now=1000)

        capacity.clear()

        self.assertIsNone(capacity.exhausted_until(now=1000))

    def test_a_second_failure_extends_the_cooldown(self):
        capacity.record_exhausted(now=1000)
        capacity.record_exhausted(now=1500)

        self.assertEqual(capacity.exhausted_until(now=1500), 1500 + capacity.COOLDOWN_S)

    def test_snapshot_when_available(self):
        self.assertEqual(capacity.snapshot(now=1000), {"available": True, "retry_at": None})

    def test_snapshot_reports_retry_at_as_utc_iso(self):
        start = 1795089600  # 2026-11-19T12:00:00Z
        with patch.object(capacity, "COOLDOWN_S", 900):
            capacity.record_exhausted(now=start)

            snap = capacity.snapshot(now=start + 10)

        self.assertEqual(snap, {"available": False, "retry_at": "2026-11-19T12:15:00Z"})

    def test_snapshot_closes_by_itself_after_the_cooldown(self):
        capacity.record_exhausted(now=1000)

        snap = capacity.snapshot(now=1000 + capacity.COOLDOWN_S + 1)

        self.assertEqual(snap, {"available": True, "retry_at": None})


if __name__ == "__main__":
    unittest.main()
