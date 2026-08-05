"""Unit tests for `agent/answer_cache.py` — CP66's cache. No real Mongo: a
fake collection stands in, same pattern this repo already uses for `app`
module tests (a plain dict-backed fake rather than a Motor mock)."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import answer_cache


class _FakeCollection:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.find_calls = 0
        self.update_calls = 0

    async def find_one(self, query, projection=None):
        self.find_calls += 1
        return self.docs.get(query["_id"])

    async def update_one(self, query, update, upsert=False):
        self.update_calls += 1
        doc = dict(update["$set"])
        self.docs[query["_id"]] = doc


class _FakeDB:
    def __init__(self):
        self.collection = _FakeCollection()

    def __getitem__(self, name):
        assert name == answer_cache.CACHE_COLLECTION
        return self.collection


class _RaisingCollection:
    async def find_one(self, *a, **k):
        raise RuntimeError("connection lost")

    async def update_one(self, *a, **k):
        raise RuntimeError("connection lost")


class _RaisingDB:
    def __getitem__(self, name):
        return _RaisingCollection()


class NormaliseQuestionTests(unittest.TestCase):
    def test_lowercases_and_strips_punctuation(self):
        self.assertEqual(
            answer_cache.normalise_question("Who won the 2026 Hungarian GP?"),
            "who won the 2026 hungarian gp",
        )

    def test_folds_accents(self):
        self.assertEqual(
            answer_cache.normalise_question("Räikkönen"),
            answer_cache.normalise_question("Raikkonen"),
        )

    def test_collapses_whitespace(self):
        self.assertEqual(
            answer_cache.normalise_question("who   won   Monaco"),
            "who won monaco",
        )

    def test_none_input_does_not_raise(self):
        self.assertEqual(answer_cache.normalise_question(None), "")


class CacheKeyTests(unittest.TestCase):
    def test_same_question_same_version_same_key(self):
        a = answer_cache.cache_key("Who won Monaco?", 2)
        b = answer_cache.cache_key("who won monaco", 2)
        self.assertEqual(a, b)

    def test_different_prompt_version_different_key(self):
        a = answer_cache.cache_key("Who won Monaco?", 2)
        b = answer_cache.cache_key("Who won Monaco?", 3)
        self.assertNotEqual(a, b)

    def test_different_question_different_key(self):
        a = answer_cache.cache_key("Who won Monaco?", 2)
        b = answer_cache.cache_key("Who won Silverstone?", 2)
        self.assertNotEqual(a, b)


class ShouldCacheTests(unittest.TestCase):
    def test_model_mode_no_verification_is_cacheable(self):
        # Tier 1 — CP64 skips verification there by design.
        self.assertTrue(answer_cache.should_cache(mode="model", verification=None))

    def test_model_mode_passed_verification_is_cacheable(self):
        self.assertTrue(answer_cache.should_cache(mode="model", verification="passed"))

    def test_model_mode_failed_verification_is_not_cacheable(self):
        self.assertFalse(
            answer_cache.should_cache(mode="model", verification="verification_failed")
        )

    def test_echo_mode_is_never_cacheable(self):
        self.assertFalse(answer_cache.should_cache(mode="echo", verification=None))


class GetSetCachedTests(unittest.TestCase):
    def test_round_trip(self):
        async def run():
            db = _FakeDB()
            await answer_cache.set_cached(
                "Who won Monaco?",
                2,
                tier=1,
                text="Senna, with 6 wins.",
                sources=[{"id": "ev_1"}],
                db=db,
            )
            cached = await answer_cache.get_cached("who won monaco", 2, db=db)
            self.assertIsNotNone(cached)
            self.assertEqual(cached["text"], "Senna, with 6 wins.")
            self.assertEqual(cached["tier"], 1)
            self.assertEqual(cached["sources"], [{"id": "ev_1"}])

        asyncio.run(run())

    def test_miss_returns_none(self):
        async def run():
            db = _FakeDB()
            cached = await answer_cache.get_cached("nobody asked this", 2, db=db)
            self.assertIsNone(cached)

        asyncio.run(run())

    def test_different_prompt_version_is_a_miss(self):
        async def run():
            db = _FakeDB()
            await answer_cache.set_cached(
                "Who won Monaco?", 2, tier=1, text="x", sources=[], db=db
            )
            cached = await answer_cache.get_cached("Who won Monaco?", 3, db=db)
            self.assertIsNone(cached)

        asyncio.run(run())

    def test_read_failure_degrades_to_none_not_an_exception(self):
        async def run():
            cached = await answer_cache.get_cached("anything", 2, db=_RaisingDB())
            self.assertIsNone(cached)

        asyncio.run(run())

    def test_write_failure_does_not_raise(self):
        async def run():
            # Must complete without raising.
            await answer_cache.set_cached(
                "anything", 2, tier=1, text="x", sources=[], db=_RaisingDB()
            )

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
