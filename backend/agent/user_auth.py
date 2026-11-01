"""Who is signed in — the bearer token behind saved chat history.

Until this module the agent had exactly one notion of identity, and it was
deliberately anonymous: `rate_limit.py`'s HMAC session cookie, minted on the
first chat request, which buys a returning visitor their own rate-limit bucket
and nothing else. Saved history needs a second, stronger one — a stable user
id that the *account system* vouches for — and the two must not be confused.
The cookie says "the same browser as last time"; this says "the person who
signed in as user X". Only the second may ever unlock a stored conversation.

--------------------------------------------------------------------------
The contract (implemented on the frontend by the accounts work)
--------------------------------------------------------------------------

`GET /api/agent-token` on the frontend returns `{token, expiresAt}` for a
signed-in user and 401 otherwise. The browser then sends
`Authorization: Bearer <token>` on its agent calls. The token is a JWT:

    alg  HS256, keyed with AGENT_USER_TOKEN_SECRET (shared by both services)
    sub  the user id
    aud  "f1-agent"
    iss  "apex-frontend"
    iat, exp   ten minutes apart

A short-lived token minted server-side by the frontend, rather than the
frontend's own session cookie forwarded here, because the frontend and the
agent are separate `*.run.app` origins and `run.app` is on the Public Suffix
List — the agent can never see the frontend's cookies, and making it able to
would mean sharing the account system's session secret with a service whose
only need is "which user is this". A ten-minute HS256 token scoped by `aud`
leaks far less if it leaks at all.

--------------------------------------------------------------------------
What each outcome means
--------------------------------------------------------------------------

`authenticate` distinguishes three states because the endpoints need all
three:

* **guest** — no `Authorization` header at all. Today's behaviour, unchanged:
  chat works, nothing is stored, and the rate limiter identifies the caller
  exactly as it always has.
* **user** — a token that verifies. Chat turns are saved under `sub`.
* **invalid** — a header was sent and it did not verify (expired, forged,
  wrong audience or issuer, malformed, or the secret is not configured).

For `/api/chat` an invalid token degrades to guest rather than refusing. An
expired token is the *normal* way a long-open tab fails (the frontend refreshes
60s before expiry, but a laptop lid closed for an hour beats any refresh
timer), and refusing to answer a question because a history feature's
credential lapsed would make the optional surface break the core one. The turn
is answered; it is simply not saved. The history endpoints have no guest mode
to degrade to, so there an invalid token is a 401 — which is also the signal
the frontend's token cache uses to refresh and retry once.

**The token never feeds the rate limiter.** `rate_limit.identify` is untouched
and still keys on the session cookie, IP and subnet. Signing in is not a way to
get a bigger allowance — the tiers are a product decision this module has no
business changing — and a stolen token is therefore worth nothing against the
quota either.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import jwt

from . import config

TOKEN_AUDIENCE = "f1-agent"
TOKEN_ISSUER = "apex-frontend"
TOKEN_ALGORITHM = "HS256"

LEEWAY_SECONDS = 30
"""Clock skew tolerated on `exp`, `iat` and `nbf`.

The frontend and the agent run on different Cloud Run instances with
NTP-synchronised clocks, so real skew is milliseconds; 30s is generous for that
and still small against a ten-minute token. It is not there to excuse a stale
token — the frontend refreshes a full minute before expiry — but to stop a
token minted on one instance from looking "issued in the future" on another.
"""

MAX_LIFETIME_SECONDS = 60 * 60
"""A token claiming to live longer than an hour is refused outright.

The contract says ten minutes. A mis-configured or compromised minter issuing
day-long tokens would otherwise be accepted for the whole day, and short expiry
is most of what makes a bearer token tolerable. An hour leaves room for the
contract to loosen without a redeploy here, and no room for "forever".
"""

MAX_SUBJECT_CHARS = 128
"""Ceiling on `sub`. It becomes a Mongo key prefix on every stored chat, and a
verified signature only proves who *minted* the token, not that the minter
bounded what it put in it."""

AuthState = Literal["guest", "user", "invalid"]


@dataclass(frozen=True)
class Auth:
    """The outcome of `authenticate` for one request."""

    state: AuthState
    user_id: str | None = None
    reason: str | None = None
    """Why an `invalid` token failed — for the log line, never for the client.
    Telling a caller *which* check their forged token failed is free help."""

    @property
    def signed_in(self) -> bool:
        return self.state == "user" and bool(self.user_id)


GUEST = Auth(state="guest")


def verify_token(raw: str | None) -> Auth:
    """Verify one bearer token string. Total: never raises.

    The algorithm list is pinned to HS256 alone. Accepting whatever `alg` the
    token's own header names is the classic JWT hole (`alg: none`, or an RS256
    public key replayed as an HMAC secret); PyJWT refuses both when given an
    explicit list, and an explicit list of one is the only safe one for a
    shared-secret scheme.

    `require` makes the absence of a claim a failure rather than a pass. Without
    it PyJWT checks `exp` only *if present*, so a token minted with no expiry
    would verify forever.
    """
    if not raw:
        return GUEST
    secret = config.user_token_secret()
    if not secret:
        # Not configured: there is no key a token could verify against, so a
        # caller sending one is treated like any other unverifiable token.
        return Auth(state="invalid", reason="secret_unset")

    options: dict[str, Any] = {"require": ["exp", "iat", "sub", "aud", "iss"]}
    try:
        claims = jwt.decode(
            raw,
            secret,
            algorithms=[TOKEN_ALGORITHM],
            audience=TOKEN_AUDIENCE,
            issuer=TOKEN_ISSUER,
            leeway=LEEWAY_SECONDS,
            options=options,
        )
    except jwt.ExpiredSignatureError:
        return Auth(state="invalid", reason="expired")
    except jwt.InvalidAudienceError:
        return Auth(state="invalid", reason="audience")
    except jwt.InvalidIssuerError:
        return Auth(state="invalid", reason="issuer")
    except jwt.InvalidSignatureError:
        return Auth(state="invalid", reason="signature")
    except jwt.ImmatureSignatureError:
        return Auth(state="invalid", reason="not_yet_valid")
    except jwt.PyJWTError as error:
        return Auth(state="invalid", reason=type(error).__name__)
    except Exception as error:  # noqa: BLE001 - total by contract
        return Auth(state="invalid", reason=type(error).__name__)

    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject.strip():
        return Auth(state="invalid", reason="subject")
    if len(subject) > MAX_SUBJECT_CHARS:
        return Auth(state="invalid", reason="subject_length")
    try:
        lifetime = float(claims["exp"]) - float(claims["iat"])
    except (TypeError, ValueError):
        return Auth(state="invalid", reason="lifetime")
    if lifetime > MAX_LIFETIME_SECONDS:
        return Auth(state="invalid", reason="lifetime")

    return Auth(state="user", user_id=subject)


def bearer_from(request: Any) -> str | None:
    """The raw token from an `Authorization: Bearer …` header, or None.

    Duck-typed on `.headers` for the same reason `rate_limit.identify` is: the
    tests drive it with a stub. The scheme match is case-insensitive per RFC
    7235; anything other than `Bearer` is treated as no token, not as an
    invalid one — a caller sending Basic auth to this service is not trying to
    sign in.
    """
    headers = getattr(request, "headers", {}) or {}
    value = headers.get("authorization") or headers.get("Authorization")
    if not value:
        return None
    scheme, _, token = value.strip().partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def authenticate(request: Any) -> Auth:
    """Resolve the caller's `Auth` from a request. Total: never raises."""
    raw = bearer_from(request)
    if raw is None:
        return GUEST
    result = verify_token(raw)
    if result.state == "invalid":
        # The reason, never the token: it is a bearer credential, and a log
        # line is a place credentials go to be found.
        print(f"agent user token rejected: {result.reason}")
    return result
