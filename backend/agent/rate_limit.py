"""Abuse prevention for `f1-agent` — the layer that rations a shared, free
inference quota against an unauthenticated public endpoint.

Before this module there was **nothing**. `concurrency.py` is a *serialization*
gate for Ollama's one-concurrent-model tier, not an abuse control: it makes one
caller wait for another, it does not stop that caller from coming back a
thousand times. `--max-instances=1` bounds requests per *second*, not per day.
CORS is a browser rule and `curl` does not read it. So one shell loop could hold
the run slot indefinitely and burn the whole free-tier allowance —
`CHAT-AGENT-PLAN.md` §4.2's "a burst of demo traffic can lock the assistant out
for hours", except deliberate and unbounded.

Five layers, all of which must pass. Each one covers a hole the one above it
leaves open, and they are listed in the order of how much they actually protect:

**Layer 1 — the global daily budget cap.** A single counter of cost consumed
today; past it, `/api/chat` refuses everyone. §4.2 deferred exactly this
("budget caps... a real product-policy decision") and it is the only layer that
is a genuine backstop: per-caller limits bound what *one* caller does and say
nothing about ten thousand of them, which is precisely the shape of a botnet or
of an unexpectedly popular link. **This layer never fails open** — see the
failure-mode section below.

**Layer 2 — per-caller counters on a composite identity, charged in cost
units.** Identity is resolved in priority order (session token → IP → subnet);
*every applicable* counter is checked and charged, not just the most specific
one, so rotating within a /24 does not multiply the allowance.

**Layer 3 — client IP resolution.** See `resolve_client_ip` — it is the most
commonly botched piece of a rate limiter and it is wrong in both directions:
naive `request.client.host` rate-limits every Cloud Run user as one caller,
naive "first `X-Forwarded-For` entry" is a header the client writes itself.

**Layer 4 — abuse signals feed back into cost.** A caller repeatedly tripping
CP67's guardrails (`agent/guardrails/`) pays a multiplier on every subsequent
request. No new detection: the guards already run, model-free, before any quota
is spent, and their verdicts were previously used once and discarded.

**Layer 5 — a kill switch and a stated failure mode.**
`AGENT_RATE_LIMIT_ENABLED=false` disables all of it without a redeploy.

--------------------------------------------------------------------------
Why cost units and not request counts
--------------------------------------------------------------------------

Counting requests is the classic mistake for an LLM endpoint, because the
per-request cost varies by more than an order of magnitude. §4.2 states the
spread in this system's own terms: "a tier-1 lookup costs **one** model call, a
tier-2 analysis **two**, and only tier-3 research reaches four or five" — and a
cache hit (CP66) costs a Mongo read and no model call at all. A limit of "20
requests/hour" therefore permits somewhere between ~2 and ~100 units of real
spend depending on what the caller asks, which means it is not a limit on
anything that matters.

So the currency here is a **cost unit**, defined as *roughly one tier-1 answer,
or 60 seconds of metered GPU time* — §4.2 again: "usage meters GPU time, not
tokens". `TIER_COST` maps the router's own tier onto that scale using the plan's
call counts directly, and `measured_cost` takes the larger of the tier estimate
and the turn's actual model seconds, so a turn that runs long pays for what it
really used rather than for its label. The repo already has runs on both sides
of that line recorded in `router.py`'s docstring (a flat-graph answer at 50.9s;
a comparative one still going at 287s), which is why the estimate alone is not
trusted.

Charging happens in two phases, because the endpoint must decide *before* the
stream commits and the true cost is only known after it finishes:

1. `check_and_charge` charges the **estimate** from `router.classify` up front.
2. `settle` applies the delta once the turn ends — refunding almost all of it
   for a cache hit or a guardrail refusal, adding to it for a turn that ran
   past its tier's budget.

The alternative — charge only on completion — was rejected because it charges
nothing for a request that is still running, so N concurrent callers all see an
empty counter and the limit does nothing under exactly the load it exists for.

--------------------------------------------------------------------------
Fixed windows, not a refilling token bucket — and why
--------------------------------------------------------------------------

A refilling token bucket is the better algorithm and it is *not* what this does.
Storing a bucket in Mongo needs a read-modify-write of `tokens` against elapsed
time, which is either two round trips with a compare-and-set retry loop, or one
round trip using an aggregation-pipeline update (`$$NOW`, `$let`, conditional
`$subtract`). The pipeline version is the one worth having and it could not be
exercised against a real MongoDB in this checkpoint — only against the in-memory
fake in `tests/test_agent_rate_limit.py`, and a fake that implements my
assumptions cannot falsify them. Shipping an unverifiable atomic-update pipeline
as the load-bearing abuse control is the CP44 mistake (a documented behaviour
treated as a proven one).

What is here instead is a **fixed-window counter, keyed by identity and window
index**, charged with a single `$inc` and read back in the same operation via
`find_one_and_update`. `$inc` is atomic on its own, there is no lost-update
window, window rollover is free (a new window is a new `_id`), and the whole
thing is expressible against any Mongo without relying on server-version
features. Two windows are charged per identity — a **burst** window (60s) and a
**sustained** window (3600s) — which is the same "N per minute AND M per hour"
pair that ordinary edge rate limiters express, and it is what stops a single
minute from consuming the hour's whole allowance.

The honest cost of this choice: a fixed window permits up to 2× its limit across
a window seam (all of window N's allowance at its end, all of N+1's at its
start). That is bounded, it applies to the burst window where the absolute
numbers are small, and the daily cap sits underneath it regardless. If this ever
matters, the upgrade is the pipeline bucket above, verified against a real
Mongo first.

All counters for one request are issued concurrently with `asyncio.gather`, so
the added latency is one round trip, against an endpoint whose fast path is
otherwise a multi-second model call.

--------------------------------------------------------------------------
Fail-open / fail-closed, decided per layer
--------------------------------------------------------------------------

**Per-caller counters fail OPEN.** A Mongo blip must not take the assistant
down for everyone; the failure it would prevent (one caller over their share
for a few minutes) is strictly smaller than the failure it would cause. This
matches how every other Mongo-touching module here behaves —
`answer_cache.py` ("degrade to no cache, never raise"), `checkpointer.py`
(degrade to no thread memory), `ledger.py`.

**The global cap fails CLOSED, onto an in-process counter.** It is the layer
whose entire purpose is that spend cannot run away, and a layer that stops
applying exactly when the datastore is unhealthy is not a backstop. Every charge
is mirrored into `_process_spend` (a per-UTC-day float in module state) *whether
or not* Mongo answered, and the cap is enforced against `max(mongo, process)`.
So an outage degrades the cap from service-wide to per-process — which, while
`--max-instances=1` holds (see `cloudbuild-agent.yaml`; the same coupling
`concurrency.py` documents), is the same thing. It cannot uncap spend.

A cold start does reset `_process_spend`, so the process fallback forgives spend
across a restart. With Mongo healthy that is invisible (Mongo is authoritative
and higher). With Mongo down *and* a restart, an attacker gains one fresh
process budget per restart — bounded, and better than the alternative of
refusing all service on any Mongo hiccup.

**Abuse strikes live in process memory only** (`_strikes`). They are a
short-window signal (`config.ABUSE_WINDOW_SECONDS`), they must be readable on
the hot path with zero round trips, and a cold start forgiving them is
acceptable: a caller who tripped a guard an hour ago and has been quiet since is
not the caller this is aimed at.

--------------------------------------------------------------------------
Wire protocol: a real HTTP 429, not an SSE `error` event
--------------------------------------------------------------------------

`sse.py` says every failure is an SSE `error` event and never a status code.
Read its reasoning rather than its rule: "by the time anything goes wrong the
response has already been committed with 200, so a status code cannot carry the
failure." That is a statement about *when* those failures happen, and it is the
one thing that is different here — a rate-limit refusal is decided in the
endpoint, before `StreamingResponse` is constructed and before a single byte is
committed. The constraint that forces an in-band error simply does not apply.

So `/api/chat` returns **429 with a `Retry-After` header** and a JSON body
`{"code", "message", "retry_after"}`. This is the standard answer and the only
one that is legible to anything between the browser and the service: a CDN, a
proxy, a monitoring probe, or a `fetch` retry helper all understand 429 and none
of them parse `text/event-stream` looking for an event named `error`. Dressing a
refusal as a 200 would also mean an abusive client's requests all look
successful in Cloud Run's own metrics, which is precisely where you would look
first to find out you were being hammered.

`sse.ERROR_CODES` is deliberately left alone. Its codes describe things that
went wrong *inside a committed stream*; `rate_limited` and `budget_exhausted`
never occur there, and widening a closed set with codes that cannot appear in it
would make the contract less true, not more complete. The frontend gets them
from the HTTP layer instead (`agent-api.ts`'s `TransportErrorCode`).

The two refusals are separate codes because they are separate situations with
different things the reader can do: `rate_limited` means *you* are going too
fast and waiting works; `budget_exhausted` means the day's shared allowance is
gone and waiting for the caller's own window will not help.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from . import config, router

COLLECTION = "agent_rate_limits"
"""One document per (identity, window). Small, self-expiring, throwaway."""

SESSION_COOKIE = "f1_agent_sid"

BURST_SECONDS = 60
SUSTAINED_SECONDS = 3600


# --------------------------------------------------------------------------
# cost model
# --------------------------------------------------------------------------

TIER_COST: dict[int, float] = {1: 1.0, 2: 2.0, 3: 5.0}
"""Cost units per tier, taken straight from `CHAT-AGENT-PLAN.md` §4.2's own
call counts: "a tier-1 lookup costs one model call, a tier-2 analysis two, and
only tier-3 research reaches four or five". One unit is therefore ~one model
call ~one minute of metered GPU time, which is what makes `measured_cost` able
to compare a tier label against a stopwatch on the same scale.

Not derived from a measurement of this service's real GPU-second consumption —
that number is not available to the process (Ollama meters it upstream), which
is exactly why the plan's call counts are used as the proxy and why elapsed
model time is allowed to override them.
"""

CACHED_COST = 0.1
"""A CP66 cache hit: one Mongo read, no model call. Not zero — a cache-hit
flood is still bandwidth and Mongo load, and a free path is a path worth
hammering."""

REFUSED_COST = 0.05
"""A guardrail refusal costs a few microseconds of pure-Python matching
(`guardrails/__init__.py`). The deterrent for this path is the strike
multiplier, not the charge."""

FEEDBACK_COST = 0.05
"""A thumbs up/down. Nowhere near a model call, but not free either — it is an
unauthenticated write, and the per-caller counters are the only thing standing
between it and a flood."""

SECONDS_PER_COST_UNIT = 60.0


def estimate_cost(question: str) -> float:
    """The up-front charge, from the same rules-first router the graph uses.

    `router.classify` is pure Python with no network and no model call, so this
    costs nothing to compute and — because it is literally the same function
    `graph.astream_answer` routes on — the estimate agrees with the tier the
    turn actually runs at, rather than being a second guess at it.
    """
    return TIER_COST.get(router.classify(question).tier, TIER_COST[1])


def measured_cost(
    *,
    tier: int | None,
    cached: bool = False,
    refused: bool = False,
    model_ms: int | None = None,
) -> float:
    """What the finished turn actually cost, for `settle`.

    `model_ms` must exclude time spent queued on `concurrency.run_slot` — that
    is another caller's model time, and charging it here would bill whoever
    happened to arrive second for the size of the question in front of them.
    """
    if refused:
        return REFUSED_COST
    if cached:
        return CACHED_COST
    base = TIER_COST.get(tier or 1, TIER_COST[1])
    if not model_ms or model_ms <= 0:
        return base
    return max(base, (model_ms / 1000.0) / SECONDS_PER_COST_UNIT)


# --------------------------------------------------------------------------
# Layer 3 — client IP resolution
# --------------------------------------------------------------------------


def resolve_client_ip(
    forwarded_for: str | None,
    peer: str | None,
    *,
    hops: int | None = None,
) -> str | None:
    """The caller's real address, read a fixed number of hops from the RIGHT.

    **This is the piece that is usually wrong, and it is wrong in two opposite
    ways, both of which are worse than having no limiter at all.**

    *Reading `request.client.host`* on Cloud Run gives the address of Google's
    front end, not the user's. Every request in the world then shares one
    identity, the IP bucket saturates within minutes of any traffic at all, and
    the service refuses everybody. A limiter that reliably bans all users is a
    self-inflicted outage.

    *Reading the first `X-Forwarded-For` entry* reads a value the client wrote.
    `X-Forwarded-For` is built left-to-right by appending, so the leftmost entry
    is whatever the original sender put there — a client sending
    `X-Forwarded-For: 1.2.3.4` gets `1.2.3.4` treated as its identity, and can
    therefore mint a fresh identity per request by incrementing a number. That
    is not a partial defence; it is an off switch with extra steps.

    The correct read is from the **right**, skipping exactly the number of
    proxies that sit between this process and the internet, because those are
    the only entries an attacker cannot author: each infrastructure hop appends
    the address it actually observed, which lands to the right of everything the
    client supplied. `hops=0` — the default, and the correct value for this
    deployment — means "the last entry is the client", which is the read for a
    Cloud Run service addressed directly on its `*.run.app` URL, with the Google
    front end as the only proxy and no load balancer of our own in front of it
    (`cloudbuild-agent.yaml` deploys exactly that: `gcloud run deploy` with
    `--allow-unauthenticated`, no `--ingress` restriction, no backend service).

    `AGENT_TRUSTED_PROXY_HOPS` exists because that number is a property of the
    *deployment*, not of the code, and it changes the moment anything is put in
    front of the service: a Google external HTTPS load balancer appends its own
    address after the client's (`hops=1`), Cloudflare in front of that would be
    another. Getting it wrong in the safe direction (too many hops) reads a
    proxy address and over-groups callers; getting it wrong in the unsafe
    direction (too few) reads client-controlled text. **If this service ever
    moves behind a load balancer and this value is not raised, the IP layer
    silently becomes spoofable** — hence this paragraph rather than a one-line
    comment.

    Anything that does not parse as an IP address is discarded rather than used
    as an opaque bucket key: a caller who can choose their own bucket key has no
    limit at all, and the resolved value is only ever trustworthy when it came
    from a hop we believe in. When no usable entry survives, the peer address is
    the fallback — correct for local development, where there is no proxy and
    therefore no header, and harmless in production, where the header is always
    present.
    """
    hop_count = config.TRUSTED_PROXY_HOPS if hops is None else hops
    entries = [part.strip() for part in (forwarded_for or "").split(",")]
    entries = [entry for entry in entries if entry]

    if entries:
        index = len(entries) - 1 - max(0, hop_count)
        if 0 <= index < len(entries):
            candidate = _normalise_ip(entries[index])
            if candidate:
                return candidate
        # A header too short for the configured hop count means the request did
        # not arrive through the proxy chain this service is configured for.
        # Falling further left would read exactly the client-authored entries
        # the hop count exists to skip, so nothing in the header is used.

    return _normalise_ip(peer)


def _normalise_ip(raw: str | None) -> str | None:
    """Parse `raw` into a canonical IP string, or None.

    Handles the `[::1]:443` and `1.2.3.4:5678` forms proxies sometimes emit.
    IPv6 is canonicalised (`2001:DB8::1` and `2001:db8:0::1` are one caller,
    and must not be two bucket keys).
    """
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("["):
        text = text[1 : text.find("]")] if "]" in text else text[1:]
    elif text.count(":") == 1 and "." in text:
        text = text.rsplit(":", 1)[0]
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return None


def subnet_of(ip: str | None) -> str | None:
    """The coarser bucket a rotating caller cannot escape by changing address.

    IPv4 /24 and IPv6 /64 are the conventional "one customer" allocations: a
    residential IPv6 assignment is routinely a /64 or larger, so limiting a
    single v6 address is limiting one of 18 quintillion free identities, and
    cheap proxy pools are typically dense within a /24. This is charged as a
    *parallel* counter with its own, larger allowance rather than replacing the
    per-address one — a /24 legitimately contains many unrelated people behind
    one carrier, and the point is to bound the aggregate, not to punish them
    individually.
    """
    if not ip:
        return None
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return None
    prefix = 24 if parsed.version == 4 else 64
    return str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))


def _is_loopback(ip: str | None) -> bool:
    try:
        return bool(ip) and ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


# --------------------------------------------------------------------------
# Layer 2.1 — signed session tokens
# --------------------------------------------------------------------------

_EPHEMERAL_SECRET = secrets.token_hex(32)
"""Used when `AGENT_SESSION_SECRET` is unset.

The degrade is deliberate and small: tokens stop surviving a process restart, so
every caller falls back to their IP identity after a cold start. That is the
same protection the service would have without session tokens at all, which
makes an unset secret a *reduction* in precision rather than a hole. Generated
per process rather than left as a constant so an unset secret can never mean a
publicly-known signing key.

**In production the secret IS set** — `AGENT_SESSION_SECRET` is a Secret Manager
secret wired through `cloudbuild-agent.yaml`'s `--set-secrets`, so this fallback
is a local-development and test path. It shipped unset for one deploy, which is
worth knowing about rather than quietly fixing: nothing failed, no test caught
it, and `/health` looked identical, because the fallback is *designed* to be
invisible. The only symptom was that layer 2's best property — a per-person
allowance that is not shared with everyone behind the same CGNAT address — was
silently degraded to per-IP after every cold start. A degrade that cannot be
observed from outside needs its configuration asserted, not inspected.

Note that access is granted **per secret** in this project, not project-wide, so
adding a new one means a `secretmanager.secretAccessor` binding on it for the
runtime service account as well as the `--set-secrets` entry. Missing the
binding fails the deploy rather than degrading quietly, which is the better of
the two failure modes and the reason it is called out here.
"""


def _secret() -> bytes:
    return (config.session_secret() or _EPHEMERAL_SECRET).encode("utf-8")


def issue_session_token(*, now: float | None = None) -> str:
    """Mint `<sid>.<issued_at>.<hmac>` for a caller that presented no token.

    The signature is what makes this worth having: an unsigned random id in a
    cookie is just a client-chosen bucket key, and a caller who picks their own
    key is unlimited. HMAC means only this service can produce a token the
    limiter will honour, so a caller wanting a second identity has to *ask* for
    one — and asking costs a full `/api/chat` round trip that is itself charged
    against their IP and subnet counters (see `attach_session_cookie`). Churning
    identities becomes strictly more expensive than not churning them, which is
    the property being bought.
    """
    issued = int(time.time() if now is None else now)
    sid = secrets.token_urlsafe(16)
    body = f"{sid}.{issued}"
    return f"{body}.{_sign(body)}"


def _sign(body: str) -> str:
    return hmac.new(_secret(), body.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def verify_session_token(raw: str | None, *, now: float | None = None) -> str | None:
    """The session id inside `raw`, or None if it is forged, malformed or old.

    `hmac.compare_digest` rather than `==` — the comparison is against
    attacker-supplied input, and the habit is worth keeping even where a timing
    oracle on a rate-limit bucket key would be a strange thing to exploit.

    Expiry is enforced on the *issue time inside the signature*, so a token
    cannot be kept alive forever by re-sending it; a caller who has held one
    since before `SESSION_TTL_SECONDS` is re-identified as a new session.
    """
    parts = (raw or "").split(".")
    if len(parts) != 3:
        return None
    sid, issued_raw, signature = parts
    if not sid or not signature:
        return None
    if not hmac.compare_digest(_sign(f"{sid}.{issued_raw}"), signature):
        return None
    try:
        issued = int(issued_raw)
    except ValueError:
        return None
    age = (time.time() if now is None else now) - issued
    if age < -300 or age > config.SESSION_TTL_SECONDS:
        # A token stamped in the future is either a clock problem or a forgery
        # against a leaked secret; five minutes of tolerance covers the former.
        return None
    return sid


# --------------------------------------------------------------------------
# identity
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Identity:
    """Who is being limited, resolved once per request.

    All three fields are populated where available and all three are charged —
    the priority order in the design is about *which allowance is tightest*, not
    about picking one. A caller with a session token still pays into their IP
    and subnet counters; what the token buys them is a per-person allowance that
    is not shared with everyone else behind the same CGNAT address, which is the
    entire reason plain IP limiting is not good enough here.
    """

    session: str | None = None
    ip: str | None = None
    subnet: str | None = None
    minted_session: str | None = None
    """A token minted for this request because the caller had none. Attached to
    the response as a cookie by `attach_session_cookie`; not charged as an
    identity on this request, since the caller could not have used it yet."""

    @property
    def exempt(self) -> bool:
        """Loopback callers skip the per-caller layer.

        This is local development and the test suite — a service talking to
        itself, where "one identity making a thousand requests" is the intended
        workflow rather than the threat. Restricted to loopback specifically,
        **not** to RFC1918 space: Cloud Run's own front end presents a
        non-loopback address, so widening this to "private" would risk exempting
        production traffic the moment `resolve_client_ip` fell back to the peer.
        The global cap still applies to loopback, so a runaway local script is
        still bounded.
        """
        return self.session is None and _is_loopback(self.ip)

    def keys(self) -> list[tuple[str, str]]:
        """`(scope, counter-key-prefix)` for every counter that applies."""
        out: list[tuple[str, str]] = []
        if self.session:
            out.append(("session", f"s:{self.session}"))
        if self.ip:
            out.append(("ip", f"i:{self.ip}"))
        if self.subnet:
            out.append(("net", f"n:{self.subnet}"))
        return out

    def strike_key(self) -> str | None:
        """The narrowest identity available, for the abuse counter.

        Narrowest rather than every-key on purpose: a strike recorded against a
        /24 would tax everyone sharing a carrier for one person's behaviour,
        which is the same collateral damage that makes plain IP blocking
        unacceptable in the first place.
        """
        return self.session or self.ip or self.subnet


def identify(request: Any) -> Identity:
    """Resolve `Identity` from a Starlette request.

    Deliberately duck-typed (`.headers`, `.cookies`, `.client`) rather than
    typed against `fastapi.Request`, so the unit tests can drive it with a plain
    stub and so nothing here depends on the ASGI framework staying put.
    """
    headers = getattr(request, "headers", {}) or {}
    cookies = getattr(request, "cookies", {}) or {}
    client = getattr(request, "client", None)

    ip = resolve_client_ip(
        headers.get("x-forwarded-for"),
        getattr(client, "host", None) if client else None,
    )
    session = verify_session_token(cookies.get(SESSION_COOKIE))
    minted = None if session else issue_session_token()
    return Identity(
        session=session,
        ip=ip,
        subnet=subnet_of(ip),
        minted_session=minted,
    )


def attach_session_cookie(response: Any, identity: Identity, request: Any) -> None:
    """Set the session cookie on a response, when one was minted.

    **Minted on `/api/chat` rather than from a dedicated `/api/session`
    endpoint**, which was the other option and is worth recording. A separate
    issuing endpoint has to be rate-limited itself or it becomes a free identity
    factory; minting here means acquiring a token costs an entire chat request,
    already charged against the caller's IP and subnet counters, so the cost of
    churning identities is bounded by the very layer the churn is trying to
    escape. It also removes a round trip and any client-side orchestration — the
    browser simply presents the cookie next time.

    `Secure` is set only on HTTPS, because a `Secure` cookie is silently dropped
    over plain HTTP and local development would then never hold a session at
    all — a limiter whose best identity layer is untestable locally is a limiter
    whose best layer is untested. `SameSite=None` is required in production
    because the frontend and the agent are separate Cloud Run services and this
    is therefore a cross-site request; the pairing with `Secure` is mandatory
    per the cookie spec, which is why the two are chosen together.

    **The scheme comes from `X-Forwarded-Proto`, not from `request.url.scheme`,
    and reading the wrong one shipped a broken cookie to production.** Cloud Run
    terminates TLS at its front end and speaks plain HTTP to the container, so
    `request.url.scheme` is `"http"` on every real request unless uvicorn is
    started with `--proxy-headers` (`Dockerfile.agent` does not). The deployed
    service therefore issued `SameSite=Lax` with no `Secure`, and because
    `*.run.app` is on the Public Suffix List the frontend and the agent are
    *different sites* — so a `Lax` cookie is never sent on the cross-site
    `fetch` the frontend makes. The cookie was set once and then never returned,
    which silently reduced every browser user to their IP identity: exactly the
    CGNAT-sharing problem the session layer exists to solve, with a cookie
    visible in devtools implying it was solved.

    Trusting a client-supplied header is the same question `resolve_client_ip`
    answers, and the answer is different here because the *consequences* are
    reversed. There, believing the client picks their bucket, so the header must
    be read from a hop they cannot author. Here the header only decides two
    cookie attributes: a forged `https` yields `Secure; SameSite=None`, which a
    browser on plain HTTP then refuses to store — the forger loses their own
    session and gains nothing, since the cookie is a rate-limit bucket key that
    only makes limits *tighter*. Getting it wrong in the other direction is what
    actually cost something, so this reads the header and falls back to the URL
    scheme when it is absent (local development, and the tests).

    The cookie carries no personal data and grants no authority — it identifies
    a bucket, nothing else. It is `HttpOnly` regardless, so a script on the page
    (ours or injected) cannot read or replay it.
    """
    if not identity.minted_session:
        return
    headers = getattr(request, "headers", {}) or {}
    url = getattr(request, "url", None)
    forwarded_proto = (headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    scheme = forwarded_proto or getattr(url, "scheme", "http")
    secure = scheme == "https"
    response.set_cookie(
        SESSION_COOKIE,
        identity.minted_session,
        max_age=config.SESSION_TTL_SECONDS,
        httponly=True,
        secure=secure,
        samesite="none" if secure else "lax",
        path="/",
    )


# --------------------------------------------------------------------------
# Layer 4 — abuse strikes (in-process; see module docstring)
# --------------------------------------------------------------------------

_strikes: dict[str, tuple[int, float]] = {}


def record_abuse(identity: Identity, *, code: str | None = None) -> int:
    """Note that this caller just tripped a guardrail. Returns the new count.

    Called from the refusal path in `main._stream`, so the signal is CP67's
    existing verdict rather than any new detection: `guardrails.check_input` has
    already decided, model-free and before any quota is spent, that the message
    is out of scope / an injection attempt / carrying PII. One of those is a
    mistake anybody can make (the scope guard is deliberately generous and will
    have false positives). Ten in an hour is not a mistake, and the multiplier
    is shaped for that: linear in the strike count, so an honest user who trips
    it once pays 2× on their next question — barely noticeable against a 12-unit
    allowance — while a script probing the guards prices itself out.
    """
    key = identity.strike_key()
    if not key:
        return 0
    count, _ = _decayed(key)
    count += 1
    _strikes[key] = (count, time.time())
    if code:
        print(f"rate_limit strike {count} for guard '{code}'")
    return count


def _decayed(key: str) -> tuple[int, float]:
    """Strikes for `key`, zeroed if the window has passed since the last one.

    Decay is measured from the most recent strike, not from the first, so a
    caller tripping guards steadily never ages out — and stopping for one clean
    window forgives the record entirely.
    """
    count, at = _strikes.get(key, (0, 0.0))
    if count and (time.time() - at) > config.ABUSE_WINDOW_SECONDS:
        _strikes.pop(key, None)
        return 0, 0.0
    return count, at


def abuse_multiplier(identity: Identity) -> float:
    key = identity.strike_key()
    if not key:
        return 1.0
    count, _ = _decayed(key)
    if count <= 0:
        return 1.0
    return min(1.0 + count, config.ABUSE_MULTIPLIER_CAP)


# --------------------------------------------------------------------------
# the decision
# --------------------------------------------------------------------------


@dataclass
class Decision:
    """The outcome of one admission check, and the receipt `settle` needs."""

    allowed: bool
    code: str = ""
    message: str = ""
    retry_after: int = 0
    charged: float = 0.0
    charged_keys: tuple[str, ...] = ()
    day_key: str = ""
    scope: str = ""
    multiplier: float = 1.0
    enabled: bool = True

    def http_body(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retry_after": self.retry_after,
        }


_ALLOWED_DISABLED = Decision(allowed=True, enabled=False)


RATE_LIMITED_COPY = (
    "You're asking faster than this free-tier assistant can afford — it runs on "
    "a shared inference quota with no paid plan behind it. Your questions aren't "
    "the problem; the budget is. Try again in {wait}."
)

BUDGET_COPY = (
    "The assistant has spent its whole inference budget for today. This is a "
    "shared daily cap on a free tier, not anything to do with your question — "
    "it resets at midnight UTC. Cached answers still work in the meantime."
)


def _human_wait(seconds: int) -> str:
    if seconds < 60:
        return f"{max(1, seconds)} seconds"
    minutes = round(seconds / 60)
    return "a minute" if minutes <= 1 else f"{minutes} minutes"


# --------------------------------------------------------------------------
# Layer 1 — the global daily cap
# --------------------------------------------------------------------------

_process_spend: dict[str, float] = {}
"""Per-UTC-day spend as seen by *this process*. The global cap's fail-closed
half — see the module docstring. Kept as a dict rather than a single float so a
long-lived process rolls over at midnight instead of holding yesterday's total
forever; only today's key is ever read."""


def _day_key(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


def _seconds_to_midnight(now: datetime | None = None) -> int:
    moment = now or datetime.now(timezone.utc)
    tomorrow = (moment + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return max(1, int((tomorrow - moment).total_seconds()))


def budget_snapshot() -> dict:
    """What `/health` reports. Process-local, and labelled as such."""
    day = _day_key()
    return {
        "enabled": config.RATE_LIMIT_ENABLED,
        "day": day,
        "process_spend": round(_process_spend.get(day, 0.0), 2),
        "daily_budget": config.DAILY_COST_BUDGET,
    }


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------


DB_TIMEOUT_SECONDS = 1.5
"""Hard ceiling on any single counter operation.

A rate limiter sits in front of every request, so its own latency is paid by
every request — including the ones it is going to allow. Motor's default
server-selection timeout is 30 seconds, which means an unreachable Mongo would
otherwise turn "the limiter fails open" into "the limiter adds half a minute to
every request and then fails open", which is worse than having no limiter. 1.5s
is far above a healthy Atlas round trip and far below anything a reader would
sit through.
"""

BREAKER_COOLDOWN_SECONDS = 30.0
"""How long a failed counter operation stops us trying again.

Without this, a *down* Mongo costs `DB_TIMEOUT_SECONDS` on every request
forever: the timeout bounds one operation, not the pattern. The breaker turns a
sustained outage into one timeout every 30 seconds, and the per-caller layer
spends that outage failed open exactly as intended — while the global cap keeps
counting in `_process_spend`, which is the half that must not stop.
"""

_breaker_open_until = 0.0


def _database(db: Any = None) -> Any:
    """The Mongo handle, or None when there is no URI or the breaker is open.

    Gated on `config.mongodb_uri()` for the same reason `main._stream` gates the
    answer-cache lookup: without a URI, `get_db()` still hands back a Motor
    client pointed at localhost, and the first operation *hangs* through its
    server-selection timeout rather than failing fast. Every local dev run and
    every test that never sets `MONGODB_URI` takes this path, and must take it
    without touching the network.
    """
    if db is not None:
        return db
    if not config.mongodb_uri():
        return None
    if time.time() < _breaker_open_until:
        return None
    try:
        from app.db import get_db

        return get_db()
    except Exception as error:  # noqa: BLE001 - fail open, see module docstring
        print(f"rate_limit: no database ({type(error).__name__}: {error})")
        return None


def _trip_breaker(reason: str) -> None:
    global _breaker_open_until
    if time.time() >= _breaker_open_until:
        print(f"rate_limit: counters degraded for {BREAKER_COOLDOWN_SECONDS:.0f}s ({reason})")
    _breaker_open_until = time.time() + BREAKER_COOLDOWN_SECONDS


_index_ready = False


async def _ensure_index(database: Any) -> None:
    """Create the TTL index once per process, best-effort.

    Without it this collection grows one document per identity per window
    forever. `expireAfterSeconds=0` means "expire at the time in the field",
    which is why every write stamps `expires_at` rather than relying on document
    age. Failure is ignored: an un-indexed collection still rate-limits
    correctly, it just needs sweeping, and refusing service over a missing index
    would be the fail-closed choice on the layer that is supposed to fail open.
    """
    global _index_ready
    if _index_ready:
        return
    _index_ready = True
    try:
        await asyncio.wait_for(
            database[COLLECTION].create_index("expires_at", expireAfterSeconds=0),
            timeout=DB_TIMEOUT_SECONDS,
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"rate_limit: TTL index not created ({type(error).__name__}: {error})")
        _trip_breaker("index")


async def _bump(database: Any, key: str, amount: float, ttl: int) -> float | None:
    """Add `amount` to counter `key` and return the new total, or None.

    One atomic `$inc` read back in the same round trip — the whole reason this
    module uses fixed windows rather than a refilling bucket (module docstring).
    """
    try:
        from pymongo import ReturnDocument

        doc = await asyncio.wait_for(
            database[COLLECTION].find_one_and_update(
                {"_id": key},
                {
                    "$inc": {"n": amount},
                    "$set": {
                        "expires_at": datetime.now(timezone.utc)
                        + timedelta(seconds=ttl)
                    },
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            ),
            timeout=DB_TIMEOUT_SECONDS,
        )
        return float((doc or {}).get("n") or 0.0)
    except asyncio.CancelledError:
        # A cancelled *request* (the client closed the tab) is not a broken
        # database, and tripping the breaker on it would degrade the limiter
        # every time somebody hit stop.
        raise
    except Exception as error:  # noqa: BLE001 - fail open, see module docstring
        print(f"rate_limit counter failed for {key}: {type(error).__name__}: {error}")
        _trip_breaker(type(error).__name__)
        return None


def _window_keys(scope_key: str, now: float) -> list[tuple[str, str, int, float]]:
    """`(window-name, doc id, ttl, window-end)` for the burst and sustained
    windows of one identity. The window index is in the `_id`, so rollover
    allocates a fresh document and needs no reset logic anywhere."""
    out = []
    for name, span in (("burst", BURST_SECONDS), ("sustained", SUSTAINED_SECONDS)):
        index = int(now // span)
        out.append((name, f"{scope_key}:{name}:{index}", span * 2, (index + 1) * span))
    return out


def _limit_for(scope: str, window: str) -> float:
    return config.CALLER_LIMITS[scope][window]


# --------------------------------------------------------------------------
# the entry points
# --------------------------------------------------------------------------


async def check_and_charge(
    identity: Identity,
    *,
    cost: float,
    charge_global: bool = True,
    db: Any = None,
    now: float | None = None,
) -> Decision:
    """Admit or refuse one request, charging `cost` (× any abuse multiplier).

    Order matters and is not arbitrary. Per-caller counters are evaluated first
    because a refusal there is *cheap and specific* — the caller learns it is
    their own pace, and no shared budget was touched. The global cap is charged
    only for requests that got past that, so one abusive caller cannot drive the
    day's counter up with requests that were never going to be served.

    A denial leaves the per-caller charge in place. That is deliberate: a client
    retrying against a closed window would otherwise get its charge refunded
    each time and could probe the boundary for free. It does *not* leave the
    global charge in place — the daily budget measures spend that actually
    happened, and a refused request spends nothing.
    """
    if not config.RATE_LIMIT_ENABLED:
        return _ALLOWED_DISABLED

    moment = time.time() if now is None else now
    multiplier = abuse_multiplier(identity)
    charge = round(cost * multiplier, 4)
    database = _database(db)
    if database is not None:
        await _ensure_index(database)

    charged_keys: list[str] = []

    # --- Layer 2 + 4: per-caller counters -------------------------------
    if not identity.exempt and database is not None:
        plan: list[tuple[str, str, int, float, float]] = []
        for scope, scope_key in identity.keys():
            for window, doc_id, ttl, ends_at in _window_keys(scope_key, moment):
                plan.append((scope, window, doc_id, ttl, ends_at))

        results = await asyncio.gather(
            *(_bump(database, doc_id, charge, ttl) for _, _, doc_id, ttl, _ in plan)
        )

        denial: Decision | None = None
        for (scope, window, doc_id, _ttl, ends_at), total in zip(plan, results):
            if total is None:
                # Fail open on this counter only — a single failed write must
                # not disable the counters that did answer.
                continue
            charged_keys.append(doc_id)
            if total > _limit_for(scope, window) and denial is None:
                wait = max(1, int(ends_at - moment))
                denial = Decision(
                    allowed=False,
                    code="rate_limited",
                    message=RATE_LIMITED_COPY.format(wait=_human_wait(wait)),
                    retry_after=wait,
                    charged=charge,
                    charged_keys=tuple(charged_keys),
                    scope=f"{scope}:{window}",
                    multiplier=multiplier,
                )
        if denial is not None:
            denial.charged_keys = tuple(charged_keys)
            print(f"rate_limit refused: {denial.scope} (x{multiplier:g})")
            return denial

    # --- Layer 1: the global daily cap ----------------------------------
    day = _day_key()
    if charge_global:
        process_total = _process_spend.get(day, 0.0) + charge
        _process_spend[day] = process_total
        mongo_total = (
            await _bump(database, f"global:{day}", charge, _seconds_to_midnight() + 3600)
            if database is not None
            else None
        )
        # `max` is the fail-closed half: with Mongo healthy its total is the
        # authority (it sees every process); with Mongo down or lying low the
        # process total still holds a ceiling.
        total = max(process_total, mongo_total or 0.0)
        if total > config.DAILY_COST_BUDGET:
            _process_spend[day] = max(0.0, process_total - charge)
            if database is not None:
                await _bump(database, f"global:{day}", -charge, _seconds_to_midnight() + 3600)
            print(f"rate_limit refused: daily budget ({total:.1f} > {config.DAILY_COST_BUDGET})")
            return Decision(
                allowed=False,
                code="budget_exhausted",
                message=BUDGET_COPY,
                retry_after=_seconds_to_midnight(),
                charged=0.0,
                charged_keys=tuple(charged_keys),
                scope="global:day",
                multiplier=multiplier,
            )

    return Decision(
        allowed=True,
        charged=charge,
        charged_keys=tuple(charged_keys),
        day_key=day if charge_global else "",
        multiplier=multiplier,
    )


async def settle(
    decision: Decision | None,
    *,
    actual_cost: float,
    db: Any = None,
) -> None:
    """Reconcile the up-front estimate against what the turn really cost.

    The delta is applied to **the same documents the charge landed on**, by id,
    rather than to whatever window happens to be current now. A turn can run for
    minutes and cross a window boundary; refunding into the new window would
    hand the caller back an allowance they never spent there, and would leave
    the window they did spend in overstated forever. Charging and refunding the
    same key is correct by construction even when that key has since rolled out
    of use.

    Never raises. This runs after `done` is on the wire, in the same position
    and for the same reason as the answer-cache write in `main._stream`: the
    reader already has their answer, and a bookkeeping failure must not touch
    it.
    """
    if decision is None or not decision.allowed or not decision.enabled:
        return
    delta = round(actual_cost * decision.multiplier - decision.charged, 4)
    if abs(delta) < 0.01:
        return

    if decision.day_key:
        current = _process_spend.get(decision.day_key, 0.0)
        _process_spend[decision.day_key] = max(0.0, current + delta)

    database = _database(db)
    if database is None:
        return
    targets: Iterable[str] = decision.charged_keys
    ttl = SUSTAINED_SECONDS * 2
    await asyncio.gather(
        *(_bump(database, key, delta, ttl) for key in targets),
        *(
            [_bump(database, f"global:{decision.day_key}", delta, _seconds_to_midnight() + 3600)]
            if decision.day_key
            else []
        ),
    )


def reset_for_tests() -> None:
    """Drop all process-local state: strikes, the day's spend, the index flag.

    The same need `concurrency.reset_for_tests` documents — module state that
    survives between tests turns an independent suite into an ordered one.
    """
    _strikes.clear()
    _process_spend.clear()
    global _index_ready, _breaker_open_until
    _index_ready = False
    _breaker_open_until = 0.0
