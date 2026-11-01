"""Tests for `agent/user_auth.py` — the bearer token behind saved chat history.

Tokens are minted here with PyJWT and the same claims the frontend's
`GET /api/agent-token` route mints, so a drift in the contract (`aud`, `iss`,
algorithm) fails here rather than in a browser. Every failure mode the module
names gets its own case, because each is a different way a token can be wrong
and a verifier that silently accepts any one of them is a history leak.
"""

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import jwt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import user_auth

SECRET = "test-user-token-secret-0123456789abcdef"


def mint(
    sub: str = "user-1",
    *,
    secret: str = SECRET,
    aud: str | None = "f1-agent",
    iss: str | None = "apex-frontend",
    iat: float | None = None,
    exp: float | None = None,
    algorithm: str = "HS256",
    drop: tuple[str, ...] = (),
) -> str:
    now = time.time()
    claims = {
        "sub": sub,
        "aud": aud,
        "iss": iss,
        "iat": int(now if iat is None else iat),
        "exp": int(now + 600 if exp is None else exp),
    }
    for key in drop:
        claims.pop(key, None)
    return jwt.encode(claims, secret, algorithm=algorithm)


class VerifyTokenTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(user_auth.config, "user_token_secret", lambda: SECRET)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_valid_token_yields_its_subject(self):
        result = user_auth.verify_token(mint("abc"))
        self.assertTrue(result.signed_in)
        self.assertEqual(result.user_id, "abc")

    def test_a_missing_token_is_a_guest_not_an_error(self):
        self.assertEqual(user_auth.verify_token(None).state, "guest")
        self.assertEqual(user_auth.verify_token("").state, "guest")

    def test_an_expired_token_is_invalid(self):
        result = user_auth.verify_token(mint(iat=time.time() - 1200, exp=time.time() - 600))
        self.assertEqual((result.state, result.reason), ("invalid", "expired"))

    def test_small_clock_skew_is_tolerated(self):
        # Expired five seconds ago — inside the 30s leeway.
        result = user_auth.verify_token(mint(iat=time.time() - 600, exp=time.time() - 5))
        self.assertTrue(result.signed_in)

    def test_the_wrong_audience_is_invalid(self):
        result = user_auth.verify_token(mint(aud="some-other-service"))
        self.assertEqual((result.state, result.reason), ("invalid", "audience"))

    def test_the_wrong_issuer_is_invalid(self):
        result = user_auth.verify_token(mint(iss="someone-else"))
        self.assertEqual((result.state, result.reason), ("invalid", "issuer"))

    def test_a_token_signed_with_another_secret_is_invalid(self):
        result = user_auth.verify_token(mint(secret="not-the-shared-secret-at-all-000000"))
        self.assertEqual((result.state, result.reason), ("invalid", "signature"))

    def test_alg_none_is_refused(self):
        unsigned = jwt.encode(
            {"sub": "x", "aud": "f1-agent", "iss": "apex-frontend",
             "iat": int(time.time()), "exp": int(time.time()) + 600},
            None,
            algorithm="none",
        )
        self.assertEqual(user_auth.verify_token(unsigned).state, "invalid")

    def test_a_token_without_an_expiry_is_refused(self):
        self.assertEqual(user_auth.verify_token(mint(drop=("exp",))).state, "invalid")

    def test_a_token_without_an_audience_is_refused(self):
        self.assertEqual(user_auth.verify_token(mint(drop=("aud",))).state, "invalid")

    def test_a_token_living_longer_than_an_hour_is_refused(self):
        result = user_auth.verify_token(mint(exp=time.time() + 6 * 3600))
        self.assertEqual((result.state, result.reason), ("invalid", "lifetime"))

    def test_garbage_is_invalid_not_an_exception(self):
        self.assertEqual(user_auth.verify_token("not.a.jwt").state, "invalid")

    def test_an_unset_secret_makes_every_token_invalid(self):
        with patch.object(user_auth.config, "user_token_secret", lambda: None):
            self.assertEqual(user_auth.verify_token(mint()).state, "invalid")


class BearerParsingTests(unittest.TestCase):
    def test_the_bearer_scheme_is_case_insensitive(self):
        request = SimpleNamespace(headers={"authorization": "bearer abc.def.ghi"})
        self.assertEqual(user_auth.bearer_from(request), "abc.def.ghi")

    def test_another_scheme_is_no_token_at_all(self):
        request = SimpleNamespace(headers={"authorization": "Basic dXNlcjpwYXNz"})
        self.assertIsNone(user_auth.bearer_from(request))

    def test_no_header_authenticates_as_guest(self):
        self.assertEqual(user_auth.authenticate(SimpleNamespace(headers={})).state, "guest")


if __name__ == "__main__":
    unittest.main()
