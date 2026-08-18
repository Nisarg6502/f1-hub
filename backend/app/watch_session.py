"""Paired watch-party sessions — the only piece of watch mode that needs a server.

Watch mode (`/watch/[raceId]`) replays a finished race at the pace it was really
run. Variant 2 of the design note
(`docs/superpowers/specs/2026-08-08-watch-party-second-screen-design-note.md`)
adds the second-screen half: a phone and a laptop showing the *same* replay, in
step, either of them able to drive. This module is the shared state that makes
that possible, and nothing else in watch mode touches a database.

==========================================================================
Open question 3 — shared session id, or a local-network channel?
==========================================================================

**Answered: a shared session id in Mongo, polled.** The brief's prior was that a
local-network channel is unreliable; that is right, but not for the reason it is
usually given, so the argument is recorded here rather than left as a taste.

*A "local-network channel" between two browsers is WebRTC, and there is no other
option.* A web page cannot open a raw UDP socket, cannot answer mDNS, and cannot
listen on a port. So "local network" means an `RTCPeerConnection` — which needs
an **offer, an answer and ICE candidates exchanged out of band before it can
connect**. That exchange is a server. The design's premise, that a local channel
avoids backend work, is therefore false at the first step: it does not remove the
server, it adds a peer connection *on top of* one. (A QR code can carry an offer
one way; nothing carries the answer back.)

*And it fails in the cases the feature is for.* A phone that has dropped to
cellular, a guest network with AP client isolation, or a phone and a laptop on
different SSIDs in the same house are all ordinary at a watch party, and all of
them break host-candidate connectivity. Recovering needs STUN, and then TURN for
symmetric NAT — a relay we would have to run. So the honest comparison is
"Mongo document + polling" against "signalling server + STUN + TURN + peer
lifecycle + a fallback for when it does not connect".

*What is actually being synchronised is tiny and slow.* One lap index, one
boolean, one enum, one revision — under 200 bytes — changing when a human presses
a button, a few times a minute at most. It is not a media stream and it is not a
cursor. The frame-by-frame clock is *not* transported: both devices already have
the whole race locally and run the same deterministic clock over it, so what
crosses the wire is a command, not a position.

*Why not WebSockets, which Cloud Run does support.* Two reasons, and neither is
"they are hard". First, a socket is per-instance state: `f1-backend` deploys with
no `--max-instances` (`cloudbuild-backend.yaml`), so two devices in one party can
land on different instances and a socket-held session would simply not see the
other side. Making that work means a broker — i.e. Mongo — at which point the
socket is an optimisation on top of the thing that already works. Second, an open
socket pins a container for its whole life, and the state changes a few times a
minute; that is the worst possible ratio for a scale-to-zero service.

The cost of polling is stated rather than hidden: a follower learns about a
change up to one poll interval late (the client polls at ~1.5s), and an idle
paired session costs ~40 requests a minute against a document lookup by `_id`.
The mode being synchronised is a human aligning a replay with a television; a
second of latency on "play" is not a defect there, and drift correction — the
interaction this mode exists for — is explicitly a manual, deliberate act.

==========================================================================
The security model, which is the part that is easy to get wrong
==========================================================================

**The pairing code is an unauthenticated capability**: whoever presents it drives
a stranger's screen. The impact is low (the worst outcome is someone else's race
replay jumping to the wrong lap) but it is not zero, and "low impact" is not a
reason to leave a guessable endpoint unbounded.

Four things bound it, and they are deliberately layered so that no single one has
to carry the whole weight:

1. **Two secrets, with different jobs.** The `session_id` is 128 bits from
   `secrets.token_hex` and is the capability for reading and writing state. The
   `code` is short *because a human types it*, and it can do exactly one thing:
   be exchanged, once, for a `session_id`. Every other endpoint takes the
   session id, so **only `join` is a guessing oracle** — which is what makes
   rate-limiting one endpoint meaningful rather than theatre. Getting this wrong
   is the obvious failure: had the short code also been the polling key, a
   limiter on `join` would bound nothing, because `GET` would answer the same
   question for free.

2. **The code is single-use and burned on the first successful join.** This is
   the strongest of the four and it costs nothing. A code is guessable only while
   it is live, and it is live from the moment the desktop paints it until the
   phone scans it — seconds, in the normal case. Pairing a third device issues a
   *new* code rather than re-advertising a burned one.

3. **Entropy and a window.** Eight characters from a 30-symbol alphabet
   (digits 2-9 and A-Z less I/L/O/U, chosen so nothing is ambiguous when read
   off a screen and typed on a phone) is 30**8 = 6.56e11, about 39.3 bits. With
   the 10-minute pairing window and `JOIN_BURST_LIMIT` guesses a minute, an
   attacker gets ~1e2 attempts per live code against ~1e11 possibilities. Six
   characters (7.3e8) would also have survived the rate limit, and was rejected
   for the wrong-feeling reason that the margin should not depend on the limiter
   holding.

4. **The join endpoint is rate limited, per IP and per subnet.**

**On the rate limiter: the pattern is lifted from `agent/rate_limit.py`, the
implementation is not.** That module cannot be imported — it lives in the
`f1-agent` service and reads `agent/config.py` — but more importantly almost none
of it applies. It rations a shared, metered GPU budget, so it charges *cost
units*, estimates before a turn and settles after it, carries a global daily cap
and an abuse multiplier. Here there is nothing to meter: a join either finds a
document or does not, and every attempt costs the same Mongo lookup. Copying a
thousand lines to use a tenth of it would import the wrong mental model along
with the code. What *is* taken, because it is the piece that is usually wrong:

* `resolve_client_ip` reads a fixed number of hops **from the right** of
  `X-Forwarded-For`. Reading `request.client.host` on Cloud Run yields Google's
  front end, so every user in the world shares one bucket and the service bans
  everybody; reading the *first* entry reads a value the client wrote, so an
  attacker mints a fresh identity per request. `WATCH_TRUSTED_PROXY_HOPS=0` is
  correct for a Cloud Run service addressed directly on its `*.run.app` URL, and
  **must be raised the moment anything is put in front of the service** or the
  IP layer silently becomes spoofable.
* The IP and the /24 (or /64) are charged as *parallel* counters, so rotating
  within a subnet does not multiply the allowance.
* Fixed windows with an atomic `$inc` read back in the same round trip, rather
  than a token bucket, for the reason that module gives at length: the bucket
  needs an aggregation-pipeline update that cannot be honestly verified against
  an in-memory fake.

**This limiter fails CLOSED, where the agent's fails open, and the reversal is
deliberate.** The agent fails open because a Mongo blip must not take the
assistant down for everyone. Here the counter and the thing it protects live in
the *same database*: if the counter cannot be written, the join was going to fail
at the session lookup anyway. So failing closed costs nothing that was going to
work, and it removes the otherwise-real attack of making the counter fail in
order to guess freely.

==========================================================================
Expiry — three clocks, because they answer different questions
==========================================================================

Nothing sweeps this collection, so every document has to end on its own.

* `code_expires_at` — `PAIR_WINDOW_SECONDS` (10 min). How long a code stays
  guessable. Short because it is the security-relevant one.
* `expires_at` — `SESSION_TTL_SECONDS` (3 h), **sliding**: refreshed by any
  authenticated read or write. A watch party lasts as long as the race plus the
  arguing afterwards, and a session that died at a fixed 30 minutes would be a
  worse bug than any of the above.
* `SESSION_MAX_SECONDS` (6 h) — a hard ceiling from creation, so a tab left open
  forever cannot keep a document alive forever.

The TTL index does the deleting (`expireAfterSeconds=0` against `expires_at`,
which is why every write stamps an absolute instant rather than relying on
document age). **Every read also checks `expires_at` itself**, because Mongo's TTL
monitor runs about once a minute and an expired document is therefore readable
for up to that long. Trusting the index alone is the classic version of this
mistake; here it would mean a code kept working after it had visibly expired on
screen.

==========================================================================
What may be written
==========================================================================

`state` is a **closed, strictly typed shape**, not a free-form dict. This is an
unauthenticated write endpoint whose contents are read back and rendered in
someone else's browser; a passthrough dict would be a stored-content hole with
extra steps. Pydantic rejects unknown fields outright, `lap_index` is bounded,
`timing_mode` is an enum, and `device` is a short opaque label used only so a
client can recognise its own echo — it is never a credential and never rendered.

Last write wins, and `rev` is a server-side counter. There is deliberately **no
role**: the design note's requirement is that either side may be the remote, so
there is no "host" and no "controller" — there is one document, and either device
may write it. The `device` label on a state answers "did I cause this?", which is
all a client needs to avoid applying its own echo.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .db import get_db

router = APIRouter(prefix="/api")

SESSIONS = "watch_sessions"
LIMITS = "watch_join_limits"

# --------------------------------------------------------------------------
# codes
# --------------------------------------------------------------------------

CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
"""30 symbols: digits 2-9 and A-Z without I, L, O or U.

Every removal is a *reading* failure, not a typing one — this string is painted
on a television-sized screen and re-typed on a phone across the room. `0`/`O`,
`1`/`I`/`l` and `5`/`S` are the usual confusions; `U` goes because `V`/`U` blur
in the condensed headline face this app sets codes in, and because dropping one
more symbol costs 0.4 bits out of 39.
"""

CODE_LENGTH = 8

PAIR_WINDOW_SECONDS = 600
SESSION_TTL_SECONDS = 3 * 3600
SESSION_MAX_SECONDS = 6 * 3600

MAX_DEVICES = 8
"""A party, not a broadcast. Nothing enforces which device is which, so this only
bounds how many joins one session absorbs before it stops accepting more — a
cheap ceiling on a session someone leaves paired all afternoon."""


def new_code() -> str:
    """A pairing code. `secrets.choice` per character, so the distribution is
    uniform — `token_urlsafe` would be shorter to write and would emit an
    alphabet with `l`, `O`, `-` and `_` in it, which is unusable for something a
    person reads aloud."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalise_code(raw: str | None) -> str:
    """Upper-case, strip everything that is not in the alphabet.

    A code is displayed grouped (`ABCD 2345`) and people paste it back with the
    space, a hyphen, or in lower case. Stripping rather than rejecting means the
    obvious inputs work; anything that does not reduce to `CODE_LENGTH` symbols
    is refused by the caller, so this is forgiving about *format* only, never
    about content.
    """
    text = (raw or "").upper()
    return "".join(character for character in text if character in CODE_ALPHABET)


def new_session_id() -> str:
    """128 bits. This is the real capability — see the module docstring."""
    return secrets.token_hex(16)


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------


def enabled() -> bool:
    """Kill switch, read per call rather than at import.

    `agent/rate_limit.py`'s layer 5 exists because a control whose off switch
    needs a redeploy is worse than the thing it controls. Same reasoning, and
    reading it per call is what lets the tests flip it.
    """
    return (os.getenv("WATCH_SESSION_ENABLED") or "true").strip().lower() not in {
        "false",
        "0",
        "no",
    }


def trusted_proxy_hops() -> int:
    """How many proxies sit between this process and the internet.

    A property of the *deployment*, not of the code. `0` is right for the
    `gcloud run deploy` in `cloudbuild-backend.yaml`: no `--ingress` restriction,
    no load balancer of ours, so the Google front end is the only hop and the
    last `X-Forwarded-For` entry is the client. Putting an external HTTPS load
    balancer in front makes it 1.
    """
    try:
        return max(0, int(os.getenv("WATCH_TRUSTED_PROXY_HOPS") or "0"))
    except ValueError:
        return 0


# --------------------------------------------------------------------------
# client identity
# --------------------------------------------------------------------------


def _normalise_ip(raw: str | None) -> str | None:
    """Canonical IP string, or None. Handles the `[::1]:443` and `1.2.3.4:5678`
    forms proxies emit, and canonicalises IPv6 so `2001:DB8::1` and
    `2001:db8:0::1` are one bucket rather than two."""
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


def resolve_client_ip(
    forwarded_for: str | None, peer: str | None, *, hops: int | None = None
) -> str | None:
    """The caller's address, read `hops` entries from the RIGHT of the header.

    See the module docstring for why this is the piece most often got wrong, and
    why it is wrong in two opposite directions. Anything that does not parse as
    an IP is discarded rather than used as an opaque key — a caller who can
    choose their own bucket key has no limit at all — and a header too short for
    the configured hop count is ignored entirely rather than falling further
    left, since the entries further left are exactly the ones the hop count
    exists to skip.
    """
    hop_count = trusted_proxy_hops() if hops is None else max(0, hops)
    entries = [part.strip() for part in (forwarded_for or "").split(",")]
    entries = [entry for entry in entries if entry]
    if entries:
        index = len(entries) - 1 - hop_count
        if 0 <= index < len(entries):
            candidate = _normalise_ip(entries[index])
            if candidate:
                return candidate
    return _normalise_ip(peer)


def subnet_of(ip: str | None) -> str | None:
    """The coarser bucket a rotating caller cannot leave by changing address.

    /24 for IPv4 and /64 for IPv6: a residential IPv6 allocation is routinely a
    /64, so limiting one v6 address limits one of 18 quintillion free identities.
    Charged in parallel with the address rather than instead of it, with a larger
    allowance, because a /24 legitimately holds many unrelated people behind one
    carrier.
    """
    if not ip:
        return None
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return None
    prefix = 24 if parsed.version == 4 else 64
    return str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))


def identify(request: Any) -> list[tuple[str, str]]:
    """`(scope, counter-key)` for every counter that applies to this caller.

    Duck-typed against `.headers` / `.client` rather than `fastapi.Request` so
    the tests can drive it with a plain stub, following `rate_limit.identify`.
    Loopback is *not* exempt here: unlike the agent's limiter this one guards a
    capability rather than a budget, and the test that matters most is the one
    that proves a guesser is stopped — which has to run from 127.0.0.1.
    """
    headers = getattr(request, "headers", {}) or {}
    client = getattr(request, "client", None)
    ip = resolve_client_ip(
        headers.get("x-forwarded-for"),
        getattr(client, "host", None) if client else None,
    )
    keys: list[tuple[str, str]] = []
    if ip:
        keys.append(("ip", f"i:{ip}"))
    subnet = subnet_of(ip)
    if subnet:
        keys.append(("net", f"n:{subnet}"))
    return keys


# --------------------------------------------------------------------------
# the join limiter
# --------------------------------------------------------------------------

JOIN_LIMITS: dict[str, dict[str, int]] = {
    "ip": {"burst": 10, "sustained": 60},
    "net": {"burst": 40, "sustained": 240},
}
"""Attempts allowed per window, per identity scope.

Sized against the honest usage, not against the attacker: a person pairing a
phone types the code once, mistypes it at most a few times, and is done. Ten a
minute leaves room for fumbling and still reduces a 6.56e11 keyspace to a
non-event. The subnet allowance is four times the address one so a household or
an office behind one NAT does not lock itself out over a shared /24.
"""

BURST_SECONDS = 60
SUSTAINED_SECONDS = 3600

DB_TIMEOUT_SECONDS = 1.5
"""Ceiling on any one counter operation. Motor's default server-selection
timeout is 30 seconds, and a limiter that adds half a minute to a request before
refusing it is worse than no limiter."""


def _window_keys(scope_key: str, now: float) -> list[tuple[str, str, int, float]]:
    """`(window, doc id, ttl, window end)` for one identity.

    The window index is part of the `_id`, so rollover allocates a fresh document
    and there is no reset logic anywhere.
    """
    out = []
    for name, span in (("burst", BURST_SECONDS), ("sustained", SUSTAINED_SECONDS)):
        index = int(now // span)
        out.append((name, f"{scope_key}:{name}:{index}", span * 2, (index + 1) * span))
    return out


async def _bump(collection: Any, key: str, ttl: int) -> int | None:
    """Add one to counter `key` and return the new total, or None on failure."""
    try:
        from pymongo import ReturnDocument

        doc = await asyncio.wait_for(
            collection.find_one_and_update(
                {"_id": key},
                {
                    "$inc": {"n": 1},
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
        return int((doc or {}).get("n") or 0)
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - fails closed, see module docstring
        print(f"watch_session: join counter failed for {key}: {type(error).__name__}: {error}")
        return None


async def check_join_rate(
    collection: Any, keys: list[tuple[str, str]], *, now: float
) -> int:
    """`0` to allow, otherwise the number of seconds to wait.

    Every applicable counter is charged before any is judged, so a caller cannot
    dodge the subnet counter by tripping the address one first. A refused attempt
    keeps its charge: refunding it would let a client probe the boundary for
    free, which on a guessing endpoint is the entire attack.
    """
    if not keys:
        # No usable address at all. Nothing to limit *by*, so this must not be
        # allowed through silently — an unidentifiable caller is exactly the
        # shape of one that has arranged to be unidentifiable.
        return BURST_SECONDS

    plan: list[tuple[str, str, str, int, float]] = []
    for scope, scope_key in keys:
        for window, doc_id, ttl, ends_at in _window_keys(scope_key, now):
            plan.append((scope, window, doc_id, ttl, ends_at))

    totals = await asyncio.gather(
        *(_bump(collection, doc_id, ttl) for _, _, doc_id, ttl, _ in plan)
    )

    wait = 0
    for (scope, window, _doc_id, _ttl, ends_at), total in zip(plan, totals):
        if total is None:
            # Fails CLOSED. See the module docstring: the session lookup this
            # protects lives in the same database, so a counter that cannot be
            # written is not a working request being refused.
            return max(1, int(ends_at - now))
        if total > JOIN_LIMITS[scope][window]:
            wait = max(wait, max(1, int(ends_at - now)))
    return wait


# --------------------------------------------------------------------------
# the shared state
# --------------------------------------------------------------------------


class WatchState(BaseModel):
    """What the two devices agree on. Closed by construction — see the module
    docstring on why a passthrough dict is not acceptable here."""

    model_config = {"extra": "forbid"}

    lap_index: int = Field(ge=0, le=2000)
    """Zero-based index into the replay's laps, matching `RealTimeLapClock`.
    Bounded well above any real race (Le Mans is not F1) purely so a stored value
    can never be absurd."""

    lap_elapsed_ms: int = Field(default=0, ge=0, le=1_200_000)
    """How far into `lap_index` the writer was, in milliseconds.

    **The lap index alone is not enough to put two screens in step**, and the
    reason is a deliberate property of the clock rather than an oversight in it:
    `RealTimeLapClock.jumpTo` discards sub-lap progress, because "40% into lap
    30" is meaningless as a *human* instruction — the viewer's intent is "show me
    lap 30". A follower applying a remote state is not a human typing a lap
    number, though. It is trying to land where the other screen already is, and
    landing at the lap boundary instead puts it up to a full lap — 80 to 95
    seconds of green running, far more under a safety car — behind the thing it
    is supposed to be mirroring. Two devices a lap apart are not a second screen;
    they are two races.

    Paired with `updated_at` in the wire shape, this is what makes the follower's
    arithmetic possible: it takes the stored offset, adds however long the server
    says has passed since the write *if the state was playing*, and rolls the
    surplus forward through its own copy of the lap durations. Both ends of that
    subtraction are server clocks, so it costs nothing to a phone whose clock is
    wrong.

    The ceiling is 20 minutes: comfortably past any real lap including a red-flag
    delta, and still a bound rather than an open integer.
    """

    playing: bool = False
    timing_mode: Literal["interval", "gap"] = "interval"

    device: str = Field(default="", max_length=32, pattern=r"^[A-Za-z0-9]*$")
    """Opaque label for whichever device wrote this, so a client can ignore its
    own echo. Not a credential, never rendered, and pattern-restricted because
    it is stored from an unauthenticated request."""


class CreateBody(BaseModel):
    model_config = {"extra": "forbid"}
    race_id: str = Field(min_length=1, max_length=16, pattern=r"^[0-9]{4}-[0-9]{1,2}$")
    """`"2026-1"` — the same identifier `/watch/[raceId]` uses
    (`frontend/src/lib/watch-races.ts`). Pattern-bound rather than free text
    because it is echoed to the joining device and used to build a URL there."""
    state: WatchState | None = None


class JoinBody(BaseModel):
    model_config = {"extra": "forbid"}
    code: str = Field(min_length=1, max_length=32)


class StateBody(BaseModel):
    model_config = {"extra": "forbid"}
    session_id: str = Field(min_length=8, max_length=64)
    state: WatchState


class SessionIdBody(BaseModel):
    model_config = {"extra": "forbid"}
    session_id: str = Field(min_length=8, max_length=64)


def _now() -> datetime:
    """Now, truncated to the precision Mongo can actually store.

    BSON dates are milliseconds; the microseconds Python carries are silently
    dropped on the way in. That matters here only because `write_state` reports
    the instant it stamped while a later poll reports the instant Mongo kept, so
    without this the two responses describing *the same write* disagree — by up
    to 999 microseconds, which is nothing to a lap clock and exactly the kind of
    unexplained discrepancy that costs an hour when something else is wrong.
    Truncating at the source makes what is returned and what is stored the same
    value everywhere in this module.
    """
    moment = datetime.now(timezone.utc)
    return moment.replace(microsecond=(moment.microsecond // 1000) * 1000)


def _as_utc(value: Any) -> datetime | None:
    """Mongo hands back naive datetimes (BSON dates carry no zone). Comparing one
    against an aware `now()` raises, which would turn every expiry check into a
    500 — so this is not defensive tidying, it is the difference between the
    module working and not."""
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def is_expired(doc: dict | None, now: datetime) -> bool:
    """Whether a document is dead regardless of what the TTL index has got to.

    See the module docstring: Mongo's TTL monitor runs about once a minute, so
    "the index will have deleted it" is true eventually and false exactly when it
    matters.
    """
    if not doc:
        return True
    expires = _as_utc(doc.get("expires_at"))
    return expires is None or expires <= now


def code_is_live(doc: dict, now: datetime) -> bool:
    """A code works only while it is present *and* inside its own window. Burning
    sets it to `None`, which is why the presence check comes first."""
    if not doc.get("code"):
        return False
    expires = _as_utc(doc.get("code_expires_at"))
    return expires is not None and expires > now


def sliding_expiry(created_at: datetime | None, now: datetime) -> datetime:
    """The next `expires_at`: three hours out, but never past six hours from
    creation. The ceiling is what stops a tab left open overnight from keeping a
    document alive indefinitely."""
    rolling = now + timedelta(seconds=SESSION_TTL_SECONDS)
    if created_at is None:
        return rolling
    return min(rolling, created_at + timedelta(seconds=SESSION_MAX_SECONDS))


def public_view(doc: dict, *, now: datetime, include_code: bool) -> dict:
    """The wire shape.

    `include_code` is false for a *joining* device on purpose. The joiner has no
    use for the code, and echoing a still-live code back to whoever presented it
    would hand a successful guesser a second copy of the capability they are
    about to burn.
    """
    view = {
        "session_id": doc["_id"],
        "race_id": doc.get("race_id"),
        "rev": int(doc.get("rev") or 0),
        "state": doc.get("state") or {},
        "devices": int(doc.get("devices") or 1),
        "expires_at": _iso(doc.get("expires_at")),
        "server_now_ms": int(now.timestamp() * 1000),
        # When the *state* was last written, which is not when the document was
        # last touched — a poll refreshes the sliding TTL and a join bumps the
        # device count, and neither moves this. It is half of the pair that lets
        # a follower work out where the other screen has got to since: with
        # `server_now_ms`, both sides of `now - updated_at` are the server's own
        # clock, so a phone with a badly-set clock still lands in the right
        # place. See `WatchState.lap_elapsed_ms`.
        "updated_at": _iso(doc.get("updated_at")),
    }
    if include_code:
        view["code"] = doc.get("code") if code_is_live(doc, now) else None
        view["code_expires_at"] = (
            _iso(doc.get("code_expires_at")) if view["code"] else None
        )
    return view


def _iso(value: Any) -> str | None:
    moment = _as_utc(value)
    return moment.isoformat().replace("+00:00", "Z") if moment else None


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

_indexes_ready = False


async def ensure_indexes(database: Any) -> None:
    """Once per process, best effort.

    The unique partial index on `code` is the one that carries a correctness
    requirement rather than a performance one: two live sessions sharing a code
    would make `join` ambiguous — it would silently hand one party's screen to
    the other. `partialFilterExpression` restricts uniqueness to documents where
    `code` is a string, so the many burned sessions holding `null` do not collide
    with each other.
    """
    global _indexes_ready
    if _indexes_ready:
        return
    _indexes_ready = True
    try:
        await asyncio.wait_for(
            database[SESSIONS].create_index("expires_at", expireAfterSeconds=0),
            timeout=DB_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            database[SESSIONS].create_index(
                "code",
                unique=True,
                partialFilterExpression={"code": {"$type": "string"}},
            ),
            timeout=DB_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            database[LIMITS].create_index("expires_at", expireAfterSeconds=0),
            timeout=DB_TIMEOUT_SECONDS,
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"watch_session: indexes not created ({type(error).__name__}: {error})")
        _indexes_ready = False


def reset_for_tests() -> None:
    """Drop process-local state. Module state surviving between tests turns an
    independent suite into an ordered one — the need `concurrency.reset_for_tests`
    documents."""
    global _indexes_ready
    _indexes_ready = False


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------

DISABLED = {"error": "watch_sessions_disabled"}


def _db(database: Any = None) -> Any:
    return get_db() if database is None else database


@router.post("/watch_session")
async def create_session(body: CreateBody, response: Response, request: Request):
    """Open a session and mint its first pairing code.

    Creation is not rate limited and that is a considered omission rather than an
    oversight: it produces one small self-expiring document, it hands the caller
    nothing they did not already have, and the endpoint that grants access to
    *someone else's* session is `join`. A flood here is a storage nuisance
    bounded by the TTL, and pricing it would mean charging the honest case (a
    person opening watch mode) for an attack with no payoff.
    """
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    await ensure_indexes(database)

    now = _now()
    doc = {
        "race_id": body.race_id,
        "rev": 1,
        "state": (body.state or WatchState(lap_index=0)).model_dump(),
        "devices": 1,
        "created_at": now,
        "updated_at": now,
        "expires_at": sliding_expiry(now, now),
    }

    # Retried rather than assumed unique. A collision is vanishingly unlikely at
    # 6.56e11 codes, but the unique index means it surfaces as an exception
    # rather than as two parties sharing a screen — so the only thing to get
    # right is not turning that exception into a 500.
    for _attempt in range(5):
        candidate = dict(doc)
        candidate["_id"] = new_session_id()
        candidate["code"] = new_code()
        candidate["code_expires_at"] = now + timedelta(seconds=PAIR_WINDOW_SECONDS)
        try:
            await database[SESSIONS].insert_one(candidate)
        except Exception as error:  # noqa: BLE001
            if "duplicate" in str(error).lower() or type(error).__name__ == "DuplicateKeyError":
                continue
            print(f"watch_session: create failed ({type(error).__name__}: {error})")
            response.status_code = 503
            return {"error": "unavailable"}
        return public_view(candidate, now=now, include_code=True)

    response.status_code = 503
    return {"error": "unavailable"}


@router.post("/watch_session/join")
async def join_session(body: JoinBody, response: Response, request: Request):
    """Exchange a pairing code for a session id, once.

    The only guessing oracle in this module, and therefore the only endpoint with
    a limiter in front of it. **The limiter runs before the lookup**, so a
    refused attempt does not even reveal whether the code existed, and the
    refusal for a wrong code is byte-identical to the refusal for a code that
    was already burned — a joiner who mistypes and a guesser who misses read the
    same thing.
    """
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    await ensure_indexes(database)

    now = _now()
    wait = await check_join_rate(
        database[LIMITS], identify(request), now=now.timestamp()
    )
    if wait:
        response.status_code = 429
        response.headers["Retry-After"] = str(wait)
        return {
            "error": "rate_limited",
            "retry_after": wait,
            "message": (
                "Too many pairing attempts from this network. "
                "Ask the other screen for a fresh code and try again shortly."
            ),
        }

    code = normalise_code(body.code)
    if len(code) != CODE_LENGTH:
        response.status_code = 404
        return {"error": "unknown_code"}

    # Burned in the same operation that reads it. Two phones scanning the same
    # QR within a few milliseconds is an ordinary race, and a read-then-write
    # would let both of them consume one single-use code.
    doc = await database[SESSIONS].find_one_and_update(
        {
            "code": code,
            "code_expires_at": {"$gt": now},
            "expires_at": {"$gt": now},
            "devices": {"$lt": MAX_DEVICES},
        },
        {
            "$set": {
                "code": None,
                "code_expires_at": None,
                "expires_at": sliding_expiry(None, now),
            },
            # `updated_at` is deliberately NOT touched here. It means "when the
            # state was last written", and a join changes the device count, not
            # the state. Stamping it would tell the joining device that the
            # position it just received is current as of now — so it would add
            # nothing for the time that has actually passed since the other
            # screen last published, and land exactly that far behind. The one
            # device most in need of the correction would be the one that never
            # got it.
            "$inc": {"devices": 1},
        },
    )
    if not doc or is_expired(doc, now):
        response.status_code = 404
        return {"error": "unknown_code"}

    # `find_one_and_update` returns the document as it was *before* the update,
    # so the device count is corrected here rather than re-reading it.
    doc = {**doc, "devices": int(doc.get("devices") or 1) + 1}
    return public_view(doc, now=now, include_code=False)


@router.get("/watch_session")
async def read_session(session_id: str, response: Response, request: Request):
    """Poll. Refreshes the sliding TTL, so a session stays alive exactly as long
    as something is watching it."""
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    now = _now()
    doc = await database[SESSIONS].find_one_and_update(
        {"_id": session_id, "expires_at": {"$gt": now}},
        {"$set": {"expires_at": sliding_expiry(None, now)}},
    )
    if not doc or is_expired(doc, now):
        response.status_code = 404
        return {"error": "unknown_session"}
    # The pre-update document is returned, so `expires_at` here is the old one.
    # Overwritten rather than re-read: a poll every 1.5s does not need two round
    # trips to report a value this process just computed.
    doc = {**doc, "expires_at": sliding_expiry(_as_utc(doc.get("created_at")), now)}
    return public_view(doc, now=now, include_code=True)


@router.post("/watch_session/state")
async def write_state(body: StateBody, response: Response, request: Request):
    """Publish new state. Last write wins; `rev` is the server's counter.

    There is no compare-and-set and no client-supplied revision. Two people
    pressing buttons on two devices within the same second is not a conflict to
    resolve — it is two humans, and the later intent is the right one. A CAS
    would turn that into a rejected write that the loser has to retry, which on a
    play/pause button reads as the button not working.
    """
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    now = _now()
    doc = await database[SESSIONS].find_one_and_update(
        {"_id": body.session_id, "expires_at": {"$gt": now}},
        {
            "$set": {
                "state": body.state.model_dump(),
                "updated_at": now,
                "expires_at": sliding_expiry(None, now),
            },
            "$inc": {"rev": 1},
        },
    )
    if not doc or is_expired(doc, now):
        response.status_code = 404
        return {"error": "unknown_session"}
    doc = {
        **doc,
        "rev": int(doc.get("rev") or 0) + 1,
        "state": body.state.model_dump(),
        "updated_at": now,
        "expires_at": sliding_expiry(_as_utc(doc.get("created_at")), now),
    }
    return public_view(doc, now=now, include_code=False)


@router.post("/watch_session/code")
async def reissue_code(body: SessionIdBody, response: Response, request: Request):
    """Mint a fresh pairing code for an existing session.

    Always a *new* code, never a re-advertisement of the burned one. Pairing a
    third device, or recovering from a phone that reloaded and lost its session
    id, has to be possible; doing it by un-burning the old code would throw away
    the single-use property that does most of the security work here.
    """
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    await ensure_indexes(database)

    now = _now()
    for _attempt in range(5):
        code = new_code()
        try:
            doc = await database[SESSIONS].find_one_and_update(
                {"_id": body.session_id, "expires_at": {"$gt": now}},
                {
                    "$set": {
                        "code": code,
                        "code_expires_at": now + timedelta(seconds=PAIR_WINDOW_SECONDS),
                        "expires_at": sliding_expiry(None, now),
                    }
                },
            )
        except Exception as error:  # noqa: BLE001
            if "duplicate" in str(error).lower() or type(error).__name__ == "DuplicateKeyError":
                continue
            print(f"watch_session: reissue failed ({type(error).__name__}: {error})")
            response.status_code = 503
            return {"error": "unavailable"}
        if not doc or is_expired(doc, now):
            response.status_code = 404
            return {"error": "unknown_session"}
        doc = {
            **doc,
            "code": code,
            "code_expires_at": now + timedelta(seconds=PAIR_WINDOW_SECONDS),
            "expires_at": sliding_expiry(_as_utc(doc.get("created_at")), now),
        }
        return public_view(doc, now=now, include_code=True)

    response.status_code = 503
    return {"error": "unavailable"}


@router.post("/watch_session/end")
async def end_session(body: SessionIdBody, response: Response, request: Request):
    """Unpair, immediately.

    The TTL would get there eventually; this is here because "stop controlling my
    screen" is a thing a person wants to be *sure* of, and telling them to wait
    three hours is not an answer. Deleting is safe precisely because the document
    holds nothing but a lap number.
    """
    if not enabled():
        response.status_code = 503
        return DISABLED

    database = _db(getattr(request.app.state, "watch_db", None))
    await database[SESSIONS].delete_one({"_id": body.session_id})
    return {"ended": True}
