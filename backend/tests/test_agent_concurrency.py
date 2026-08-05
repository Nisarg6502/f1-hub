"""Tests for the run gate that keeps us inside Ollama's 1-concurrent-model tier.

The gate is load-bearing rather than defensive: without it the second
simultaneous question is queued by Ollama and then rejected, surfacing as a 429
in the middle of an answer that has already started streaming.
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import concurrency


class RunSlotTests(unittest.TestCase):
    def setUp(self):
        concurrency.reset_for_tests()

    def test_only_one_run_holds_the_slot_at_a_time(self):
        """Two overlapping runs must serialize, not interleave."""
        order: list[str] = []

        async def worker(name: str, hold: float):
            async with concurrency.run_slot(timeout=5):
                order.append(f"{name}:enter")
                await asyncio.sleep(hold)
                order.append(f"{name}:exit")

        async def main():
            await asyncio.gather(worker("a", 0.05), worker("b", 0.01))

        asyncio.run(main())

        # The precise interleaving that must NOT happen is a:enter, b:enter.
        self.assertEqual(len(order), 4)
        self.assertEqual(order[1], order[0].replace(":enter", ":exit"),
                         msg=f"runs overlapped: {order}")

    def test_uncontended_caller_never_reports_as_queued(self):
        """Regression: the only user on an idle service must not see a queue.

        The first implementation put every acquisition through
        `asyncio.wait_for`, which wraps the acquire in a task that needs a full
        event-loop iteration to settle. During that window the caller was
        counted as `waiting` while `running` was still 0, so `snapshot()` lied
        and a lone user was told "Waiting for a free slot…".
        """
        async def main():
            async with concurrency.run_slot(timeout=1) as admission:
                return admission, concurrency.snapshot()

        admission, snapshot = asyncio.run(main())
        self.assertEqual(admission.waited, 0.0)
        self.assertFalse(admission.was_queued)
        self.assertEqual(admission.ahead, 0)
        self.assertEqual(snapshot, {"running": 1, "waiting": 0, "limit": 1})

    def test_queued_caller_reports_that_it_waited(self):
        seen: list[concurrency.Admission] = []

        async def worker(hold: float):
            async with concurrency.run_slot(timeout=5) as admission:
                seen.append(admission)
                await asyncio.sleep(hold)

        async def main():
            first = asyncio.create_task(worker(0.08))
            await asyncio.sleep(0.02)  # let `first` take the slot
            await asyncio.gather(first, worker(0.0))

        asyncio.run(main())
        self.assertEqual(len(seen), 2)
        self.assertFalse(seen[0].was_queued)
        self.assertTrue(seen[1].was_queued, msg=f"second admission: {seen[1]}")
        # First in line behind the running request, so nobody is ahead of it.
        self.assertEqual(seen[1].ahead, 0)

    def test_queue_timeout_raises_at_capacity(self):
        async def hog():
            async with concurrency.run_slot(timeout=5):
                await asyncio.sleep(0.3)

        async def main():
            task = asyncio.create_task(hog())
            await asyncio.sleep(0.01)
            with self.assertRaises(concurrency.AtCapacity) as caught:
                async with concurrency.run_slot(timeout=0.05):
                    pass
            await task
            return caught.exception

        error = asyncio.run(main())
        self.assertEqual(error.queued_ahead, 0)
        self.assertGreater(error.waited, 0)

    def test_third_caller_sees_one_ahead_of_it(self):
        """`ahead` counts genuine queuers, so the UI can say how deep the line is."""
        async def main():
            async def hog():
                async with concurrency.run_slot(timeout=5):
                    await asyncio.sleep(0.15)

            async def queued():
                async with concurrency.run_slot(timeout=5) as admission:
                    return admission

            running = asyncio.create_task(hog())
            await asyncio.sleep(0.02)
            first = asyncio.create_task(queued())
            await asyncio.sleep(0.02)
            second = asyncio.create_task(queued())
            results = await asyncio.gather(first, second)
            await running
            return results

        first, second = asyncio.run(main())
        self.assertEqual(first.ahead, 0)
        self.assertEqual(second.ahead, 1)

    def test_slot_is_released_when_the_body_raises(self):
        """A crashing run must not wedge the gate for every later request.

        This is the failure that would take the whole assistant down until the
        instance restarted, so it is worth its own test rather than trusting
        the `finally`.
        """
        async def main():
            with self.assertRaises(RuntimeError):
                async with concurrency.run_slot(timeout=1):
                    raise RuntimeError("boom")
            # Must be acquirable again immediately.
            async with concurrency.run_slot(timeout=0.2):
                pass
            return concurrency.snapshot()

        snapshot = asyncio.run(main())
        self.assertEqual(snapshot["running"], 0)
        self.assertEqual(snapshot["waiting"], 0)

    def test_slot_is_released_on_cancellation(self):
        """A closed browser tab must free the slot for the next caller."""
        async def main():
            async def victim():
                async with concurrency.run_slot(timeout=1):
                    await asyncio.sleep(10)

            task = asyncio.create_task(victim())
            await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            async with concurrency.run_slot(timeout=0.2):
                pass
            return concurrency.snapshot()

        snapshot = asyncio.run(main())
        self.assertEqual(snapshot["running"], 0)

    def test_snapshot_reports_the_configured_limit(self):
        self.assertEqual(concurrency.snapshot()["limit"],
                         concurrency.config.MAX_CONCURRENT_RUNS)

    def test_semaphore_binds_to_the_current_loop(self):
        """Two sequential `asyncio.run` calls must both work.

        A module-level `asyncio.Semaphore()` binds to whichever loop existed at
        import time and raises "bound to a different event loop" on the second
        run — a bug that reads as a concurrency fault and is really an
        import-order one.
        """
        async def once():
            async with concurrency.run_slot(timeout=1):
                return True

        self.assertTrue(asyncio.run(once()))
        self.assertTrue(asyncio.run(once()))


if __name__ == "__main__":
    unittest.main()
