"""Unit tests for `agent/prewarm_cache.py` — Task A's answer-cache pre-warmer.

No real Mongo, no real Ollama: `graph.astream_answer` is monkeypatched to a
scripted async generator (same idea `test_agent_fast_path.py` uses for
`model.stream_chat`), and Mongo is the same plain dict-backed fake collection
`test_agent_answer_cache.py` already uses — this module writes through
`answer_cache.set_cached`/`get_cached` directly, so reusing that exact fake
means a passing test here is really exercising the same cache contract.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import answer_cache, config, model as model_seam, prewarm_cache


# --------------------------------------------------------------------------
# fakes — identical shape to `test_agent_answer_cache.py`'s
# --------------------------------------------------------------------------


class _FakeCollection:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        return self.docs.get(query["_id"])

    async def update_one(self, query, update, upsert=False):
        self.docs[query["_id"]] = dict(update["$set"])


class _FakeDB:
    def __init__(self):
        self.collection = _FakeCollection()

    def __getitem__(self, name):
        assert name == answer_cache.CACHE_COLLECTION
        return self.collection


def run(coro):
    return asyncio.run(coro)


class ScriptedAgent:
    """A drop-in for `graph.astream_answer` yielding a scripted event list."""

    def __init__(self, events=None, raises: Exception | None = None):
        self.events = list(events or [])
        self.raises = raises
        self.calls = 0

    async def __call__(self, message, *, thread_id, ledger, checkpointer):
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        for event in self.events:
            yield event


def _patch_agent(events=None, raises=None):
    from agent import graph

    scripted = ScriptedAgent(events=events, raises=raises)
    original = graph.astream_answer
    graph.astream_answer = scripted
    return scripted, original


def _restore_agent(original):
    from agent import graph

    graph.astream_answer = original


# --------------------------------------------------------------------------
# the question list itself
# --------------------------------------------------------------------------


class QuestionListTests(unittest.TestCase):
    def test_no_duplicate_questions(self):
        self.assertEqual(
            len(prewarm_cache.SUGGESTED_QUESTIONS),
            len(set(prewarm_cache.SUGGESTED_QUESTIONS)),
        )

    def test_default_suggestions_overlap_is_deduplicated(self):
        # DEFAULT_SUGGESTIONS repeats two ROUTE_SUGGESTIONS strings verbatim;
        # the combined list must not double-count them.
        expected_unique = len(
            set(prewarm_cache.ROUTE_SUGGESTIONS) | set(prewarm_cache.DEFAULT_SUGGESTIONS)
        )
        self.assertEqual(len(prewarm_cache.SUGGESTED_QUESTIONS), expected_unique)

    def test_who_won_the_last_race_is_present(self):
        self.assertIn("Who won the last race?", prewarm_cache.SUGGESTED_QUESTIONS)

    def test_volatile_questions_are_a_subset_of_suggested_questions(self):
        for question in prewarm_cache.VOLATILE_QUESTIONS:
            self.assertIn(question, prewarm_cache.SUGGESTED_QUESTIONS)


# --------------------------------------------------------------------------
# _run_and_cache
# --------------------------------------------------------------------------


class RunAndCacheTests(unittest.TestCase):
    def test_a_passing_answer_is_written_to_the_cache(self):
        scripted, original = _patch_agent(events=[
            ("tier", 1, "no tier-2/3 pattern matched"),
            ("verification", True, 0),
            ("token", "Verstappen won."),
        ])
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "cached")
        self.assertEqual(result["tier"], 1)
        cached = run(answer_cache.get_cached("Who won the last race?", config.PROMPT_VERSION, db=db))
        self.assertIsNotNone(cached)
        self.assertEqual(cached["text"], "Verstappen won.")

    def test_a_failed_verification_is_not_cached(self):
        scripted, original = _patch_agent(events=[
            ("tier", 1, "no tier-2/3 pattern matched"),
            ("verification", False, 2),
            ("token", "Verstappen won with 25 points."),
        ])
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "not_cacheable")
        cached = run(answer_cache.get_cached("Who won the last race?", config.PROMPT_VERSION, db=db))
        self.assertIsNone(cached)

    def test_a_step_budget_degrade_is_not_cached(self):
        scripted, original = _patch_agent(events=[
            ("tier", 1, "no tier-2/3 pattern matched"),
            ("degraded", "budget_exhausted"),
            ("token", "I wasn't able to reach a confident answer..."),
        ])
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "not_cacheable")
        self.assertIsNone(
            run(answer_cache.get_cached("Who won the last race?", config.PROMPT_VERSION, db=db))
        )

    def test_model_at_capacity_is_caught_and_reported_not_raised(self):
        _, original = _patch_agent(raises=model_seam.ModelAtCapacity("quota exhausted"))
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "model_error")

    def test_no_api_key_is_caught_and_reported_not_raised(self):
        _, original = _patch_agent(raises=model_seam.ModelUnavailable("no key"))
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "no_model_configured")

    def test_an_unexpected_exception_does_not_propagate(self):
        _, original = _patch_agent(raises=RuntimeError("boom"))
        try:
            db = _FakeDB()
            result = run(prewarm_cache._run_and_cache("Who won the last race?", db=db))
        finally:
            _restore_agent(original)

        self.assertEqual(result["status"], "error")


# --------------------------------------------------------------------------
# prewarm_question — the skip-if-cached default
# --------------------------------------------------------------------------


class PrewarmQuestionTests(unittest.TestCase):
    def test_skips_a_question_already_cached_by_default(self):
        db = _FakeDB()
        run(answer_cache.set_cached(
            "Who won the last race?", config.PROMPT_VERSION,
            tier=1, text="already warm", sources=[], db=db,
        ))

        calls = []

        async def _spy(question, *, db=None):
            calls.append(question)
            return {"question": question, "status": "cached"}

        original = prewarm_cache._run_and_cache
        prewarm_cache._run_and_cache = _spy
        try:
            result = run(prewarm_cache.prewarm_question("Who won the last race?", db=db))
        finally:
            prewarm_cache._run_and_cache = original

        self.assertEqual(result["status"], "skipped_already_cached")
        self.assertEqual(calls, [])  # the expensive path never ran

    def test_force_re_runs_even_when_already_cached(self):
        db = _FakeDB()
        run(answer_cache.set_cached(
            "Who won the last race?", config.PROMPT_VERSION,
            tier=1, text="already warm", sources=[], db=db,
        ))

        calls = []

        async def _spy(question, *, db=None):
            calls.append(question)
            return {"question": question, "status": "cached"}

        original = prewarm_cache._run_and_cache
        prewarm_cache._run_and_cache = _spy
        try:
            result = run(prewarm_cache.prewarm_question(
                "Who won the last race?", force=True, db=db
            ))
        finally:
            prewarm_cache._run_and_cache = original

        self.assertEqual(result["status"], "cached")
        self.assertEqual(calls, ["Who won the last race?"])

    def test_a_genuine_miss_runs_the_real_path(self):
        db = _FakeDB()
        calls = []

        async def _spy(question, *, db=None):
            calls.append(question)
            return {"question": question, "status": "cached"}

        original = prewarm_cache._run_and_cache
        prewarm_cache._run_and_cache = _spy
        try:
            result = run(prewarm_cache.prewarm_question("A brand new question?", db=db))
        finally:
            prewarm_cache._run_and_cache = original

        self.assertEqual(result["status"], "cached")
        self.assertEqual(calls, ["A brand new question?"])


# --------------------------------------------------------------------------
# prewarm_all — sequential, one status per question
# --------------------------------------------------------------------------


class PrewarmAllTests(unittest.TestCase):
    def test_runs_every_question_in_order_and_never_overlaps(self):
        db = _FakeDB()
        in_flight = 0
        max_in_flight = 0

        async def _spy(question, *, force=False, db=None):
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0)
            in_flight -= 1
            return {"question": question, "status": "cached"}

        original = prewarm_cache.prewarm_question
        prewarm_cache.prewarm_question = _spy
        try:
            results = run(prewarm_cache.prewarm_all(["a?", "b?", "c?"], db=db))
        finally:
            prewarm_cache.prewarm_question = original

        self.assertEqual([r["question"] for r in results], ["a?", "b?", "c?"])
        self.assertEqual(max_in_flight, 1)  # strictly sequential


# --------------------------------------------------------------------------
# CLI question selection
# --------------------------------------------------------------------------


class SelectQuestionsTests(unittest.TestCase):
    def test_only_filters_by_substring_case_insensitively(self):
        args = argparse.Namespace(only="drivers' championship", refresh_volatile=False)
        selected = prewarm_cache._select_questions(args)
        self.assertEqual(selected, ("Who's leading the drivers' championship?",))

    def test_refresh_volatile_ignores_only(self):
        args = argparse.Namespace(only="anything", refresh_volatile=True)
        self.assertEqual(prewarm_cache._select_questions(args), prewarm_cache.VOLATILE_QUESTIONS)

    def test_no_flags_selects_everything(self):
        args = argparse.Namespace(only=None, refresh_volatile=False)
        self.assertEqual(prewarm_cache._select_questions(args), prewarm_cache.SUGGESTED_QUESTIONS)


if __name__ == "__main__":
    unittest.main()
