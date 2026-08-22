"""Regression tests for the request-surface hardening.

Each of these encodes a specific thing that was open and is now closed. They
are deliberately about CONFIGURATION rather than behaviour under load: the
failures they guard against are silent, and a wildcard that creeps back into a
CORS list produces no error anywhere until someone reads the response headers.
"""

import importlib
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The API modules import motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

import pydantic

from agent.main import ChatRequest, FeedbackRequest


class DataApiCorsTests(unittest.TestCase):
    """The data API must not echo arbitrary origins, with or without credentials.

    It shipped as `allow_origins=["*"]` WITH `allow_credentials=True`. Starlette
    does not emit a literal `*` in that combination — it echoes the caller's
    Origin and sets `Access-Control-Allow-Credentials: true` — so every route,
    including six unauthenticated POSTs, was readable cross-origin by any site.
    """

    def _main(self):
        from app import main

        return importlib.reload(main)

    def test_the_origin_list_is_never_a_wildcard(self):
        self.assertNotIn("*", self._main().ALLOWED_ORIGINS)

    def test_the_default_is_localhost_not_the_open_internet(self):
        # A safe default must not depend on a deploy substitution being
        # present, because the one time it is missing is the time it matters.
        origins = self._main().ALLOWED_ORIGINS
        self.assertTrue(origins)
        for origin in origins:
            self.assertTrue(
                origin.startswith("http://localhost")
                or origin.startswith("http://127.0.0.1"),
                f"unexpected default origin: {origin}",
            )

    def test_the_cors_middleware_is_configured_from_that_list(self):
        main = self._main()
        cors = [
            m
            for m in main.app.user_middleware
            if "CORSMiddleware" in str(m.cls)
        ]
        self.assertEqual(len(cors), 1, "expected exactly one CORS middleware")
        options = cors[0].kwargs
        self.assertEqual(options["allow_origins"], main.ALLOWED_ORIGINS)
        # Nothing on this service reads a cookie or an Authorization header;
        # only the agent does. Credentials here bought nothing and cost the
        # wildcard-echo behaviour above.
        self.assertFalse(options["allow_credentials"])
        self.assertNotIn("*", options["allow_methods"])
        self.assertNotIn("*", options["allow_headers"])


class RequestSizeLimitTests(unittest.TestCase):
    """Bodies are bounded by Pydantic, before any handler code runs.

    Unbounded, these fields were parsed at whatever size Cloud Run accepts
    (32 MiB) and then handed to a cost estimator, on an unauthenticated
    endpoint, on a service pinned to a single instance.
    """

    def test_an_absurd_message_is_rejected_by_validation(self):
        with self.assertRaises(pydantic.ValidationError):
            ChatRequest(message="x" * 8001)

    def test_the_product_limit_is_left_to_the_handler(self):
        # 4000 is the limit a person is TOLD about, and it is enforced further
        # down as a streamed `bad_request` carrying a readable sentence.
        # Enforcing it here instead would replace that with a bare 422, so the
        # ceiling is deliberately higher than the product limit.
        self.assertEqual(ChatRequest(message="x" * 5000).message, "x" * 5000)

    def test_an_ordinary_message_still_validates(self):
        self.assertEqual(ChatRequest(message="Who won at Monza?").message, "Who won at Monza?")

    def test_thread_id_is_bounded(self):
        with self.assertRaises(pydantic.ValidationError):
            ChatRequest(message="hi", thread_id="t" * 65)

    def test_a_real_uuid_thread_id_fits(self):
        # 36 characters; the bound must not be tighter than the ids actually used.
        uuid_like = "4f1a2b3c-5d6e-7f80-9a1b-2c3d4e5f6071"
        self.assertEqual(ChatRequest(message="hi", thread_id=uuid_like).thread_id, uuid_like)

    def test_feedback_comment_is_bounded(self):
        # Unauthenticated free text written straight to a 512MB free-tier
        # cluster.
        with self.assertRaises(pydantic.ValidationError):
            FeedbackRequest(run_id="r", score=1, comment="c" * 2001)

    def test_an_ordinary_comment_still_validates(self):
        request = FeedbackRequest(run_id="r", score=-1, comment="Wrong lap time.")
        self.assertEqual(request.comment, "Wrong lap time.")

    def test_run_id_is_bounded(self):
        with self.assertRaises(pydantic.ValidationError):
            FeedbackRequest(run_id="r" * 129, score=1)


class BuildFailureCooldownTests(unittest.TestCase):
    """A failed geometry build cannot be retried in a tight loop.

    The global lock bounds CONCURRENT builds and the already-built check bounds
    SUCCESSFUL ones. Neither bounded failures: a failed build releases the lock
    and returns the circuit to the unbuilt pool, so a script could restart it as
    fast as the job could fail, spending Cloud Run Job minutes and OpenTopoData
    quota on every pass.
    """

    def setUp(self):
        from app import track_geometry

        self.tg = track_geometry

    def _doc(self, status, ago_seconds):
        from datetime import timedelta

        return {
            "status": status,
            "updated_at": self.tg._now() - timedelta(seconds=ago_seconds),
        }

    def test_a_fresh_failure_is_refused(self):
        remaining = self.tg._failure_cooldown_remaining(self._doc("failed", 10))
        self.assertIsNotNone(remaining)
        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, self.tg.BUILD_FAILURE_COOLDOWN_SECONDS)

    def test_an_old_failure_may_be_retried(self):
        self.assertIsNone(
            self.tg._failure_cooldown_remaining(
                self._doc("failed", self.tg.BUILD_FAILURE_COOLDOWN_SECONDS + 1)
            )
        )

    def test_a_successful_build_is_not_subject_to_the_cooldown(self):
        self.assertIsNone(self.tg._failure_cooldown_remaining(self._doc("done", 1)))

    def test_a_queued_build_is_not_subject_to_the_cooldown(self):
        # Concurrency is the lock's job, not this one's.
        self.assertIsNone(self.tg._failure_cooldown_remaining(self._doc("queued", 1)))

    def test_no_prior_build_is_not_a_cooldown(self):
        self.assertIsNone(self.tg._failure_cooldown_remaining(None))

    def test_an_iso_string_timestamp_is_understood(self):
        # The pipeline writes timestamps; a document round-tripped through JSON
        # carries a string rather than a datetime.
        doc = {"status": "failed", "updated_at": self.tg._now().isoformat()}
        self.assertIsNotNone(self.tg._failure_cooldown_remaining(doc))

    def test_an_unreadable_timestamp_does_not_block_forever(self):
        # Wrongly allowing one retry costs one job run; wrongly blocking is a
        # circuit nobody can ever build.
        for bad in [None, "not-a-date", 12345]:
            with self.subTest(updated_at=bad):
                self.assertIsNone(
                    self.tg._failure_cooldown_remaining(
                        {"status": "failed", "updated_at": bad}
                    )
                )

    def test_a_failure_timestamped_in_the_future_does_not_block_forever(self):
        # Clock skew between the job and the API must not read as a permanent
        # refusal.
        self.assertIsNone(self.tg._failure_cooldown_remaining(self._doc("failed", -600)))


if __name__ == "__main__":
    unittest.main()
