"""Runtime configuration for the `f1-agent` service.

Every knob is env-driven so the same image runs locally and on Cloud Run, and
so the CP59 spike's answer (which model actually holds up under tool calling)
can be changed without a code edit. Defaults are chosen so the service starts
and streams *something* even with no secrets at all — a skeleton that only
works when fully configured cannot prove the deployment path, which is the
entire point of this checkpoint.
"""

from __future__ import annotations

import os

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional in the container
    pass


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name) or default)
    except ValueError:
        return default


# --- Inference -------------------------------------------------------------

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL") or "https://ollama.com"

# The workhorse. CHAT-AGENT-PLAN.md §4.2 named `qwen3.5:35b`, which does not
# exist on Ollama Cloud — the catalogue was probed live on 2026-08-05 and the
# only Qwen offered is `qwen3.5:397b`, a level-4 model the plan's own budget
# logic excludes.
#
# `nemotron-3-nano:30b` is the CP59 spike's measured winner among the models
# that do exist: 6/6 on the one-shot battery and 3/3 on the multi-hop dispatch
# loop. Notably NOT `gemma4:31b`, which also scored 6/6 one-shot and then
# failed the multi-hop loop 2 times in 3 by re-dispatching to a subagent it had
# already heard back from. Full scores in `agent/spikes/README.md`.
DEFAULT_MODEL = os.getenv("AGENT_MODEL") or "nemotron-3-nano:30b"

# Near-greedy. This system narrates retrieved evidence; sampling variance is
# exactly what produced CP38's invented teammate relationship.
TEMPERATURE = float(os.getenv("AGENT_TEMPERATURE") or "0.2")


def api_key() -> str | None:
    """Read the Ollama key at call time, not import time.

    Cloud Run injects secrets as env vars before the process starts, so import
    time would work there — but tests patch this and local dev edits `.env`
    between runs, and a module-level constant silently ignores both.
    """
    return os.getenv("OLLAMA_API_KEY") or None


# --- Deep agent (CP61) ------------------------------------------------------

# Upper bound on LangGraph super-steps per turn (roughly two per tool call: a
# model step and a tools step). §4.2's whole point is that call count is the
# cost on a GPU-time budget, so this is a hard ceiling rather than a
# nice-to-have — a model that loops instead of answering must be stopped, not
# merely discouraged in a prompt. `agent/graph.py` degrades this to a plain
# answer rather than an SSE error when it fires.
AGENT_MAX_STEPS = _int("AGENT_MAX_STEPS", 12)


def mongodb_uri() -> str | None:
    """The connection string for thread memory, read at call time.

    Same env var `app/db.py` reads (`MONGODB_URI`, falling back to the
    lowercase `mongodburi` some local `.env` files use). A missing value is
    not an error here — `agent/checkpointer.py` degrades to no thread memory
    rather than refusing to start, matching this repo's fail-soft posture.
    """
    return os.getenv("MONGODB_URI") or os.getenv("mongodburi") or None


# Same database the rest of the app reads (`app/db.py`'s `DB_NAME`), so the
# checkpointer's `checkpoints`/`checkpoint_writes` collections live beside the
# app's own data rather than standing up a second database for one feature.
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"


# --- Concurrency and budget ------------------------------------------------

# Ollama Cloud's free tier allows exactly ONE concurrent model. Requests past
# that are queued to a fixed depth and then rejected, so the service serializes
# runs itself rather than discovering the limit as a 429 mid-answer.
#
# This is only a real guard while the service is pinned to a single Cloud Run
# instance (`--max-instances=1`, see cloudbuild-agent.yaml). Two instances would
# each hold their own semaphore of 1 and both hit the same shared quota, which
# is the failure this constant cannot prevent on its own.
MAX_CONCURRENT_RUNS = _int("AGENT_MAX_CONCURRENT_RUNS", 1)

# How long a queued caller waits before we give up and tell them we are busy,
# rather than holding a connection open indefinitely.
QUEUE_TIMEOUT_SECONDS = float(os.getenv("AGENT_QUEUE_TIMEOUT_SECONDS") or "45")

# Upper bound on one model call. Cloud Run's request timeout must be larger
# (see cloudbuild-agent.yaml's --timeout) or the platform kills the stream
# first and the client sees a truncated answer with no error event.
REQUEST_TIMEOUT_SECONDS = float(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS") or "180")


# --- Abuse prevention (agent/rate_limit.py) --------------------------------

# The kill switch. Everything in `rate_limit.py` is bypassed when this is off,
# which is the point: an abuse control that cannot be turned off without a
# rebuild is one you cannot turn off during the incident where it is the thing
# misfiring. Defaults ON — a public, unauthenticated endpoint spending a shared
# quota must be limited by default, and a limiter that only protects the
# deployments someone remembered to configure protects nothing.
RATE_LIMIT_ENABLED = _flag("AGENT_RATE_LIMIT_ENABLED", True)

# Layer 1: cost units of inference this service will spend in one UTC day, over
# all callers. One unit is ~one tier-1 answer / ~60s of metered GPU time (see
# `rate_limit.TIER_COST`), so 240 is ~4 hours of model time a day: roughly 240
# tier-1 answers, or 48 tier-3 research turns.
#
# Chosen against the two numbers that actually bound it, since the free tier
# publishes no figure this can be derived from (§4.2 gives call counts and
# "session limits reset every 5 hours", not a quota size):
#   - organic demand on a portfolio site is single-digit to low-double-digit
#     questions a day, so this is more than an order of magnitude of headroom
#     for every real visitor;
#   - a scripted loop, serialized by `concurrency.py` to one run at a time at
#     roughly a minute a run, reaches 240 in about four hours — so the cap
#     converts "one afternoon burns the week" into "one afternoon burns one
#     day", and the day resets on its own.
# Tune it down, not up, the first time real traffic is measured.
DAILY_COST_BUDGET = float(os.getenv("AGENT_DAILY_COST_BUDGET") or "240")

# Layer 2: per-identity allowances, in cost units per window. Two windows per
# identity — a 60s burst limit and a 3600s sustained limit — because either one
# alone is wrong: a pure hourly limit lets the whole hour be spent in ten
# seconds, and a pure per-minute limit permits 60× that allowance across a day.
#
# The three scopes widen deliberately, and the ordering IS the answer to "why
# not just limit by IP":
#   - `session` is the tight, per-person allowance. 12 units/hour is ~12 tier-1
#     questions, comfortably past any real conversation (the panel's own
#     suggested-question strip is 4 chips) and nowhere near a loop.
#   - `ip` is deliberately looser, because an IP is NOT a person: behind CGNAT
#     it can be an entire mobile carrier, and limiting it to one person's share
#     would ban a whole network for the behaviour of one phone on it.
#   - `net` (/24 or /64) is looser still and exists only to stop address
#     rotation inside a cheap proxy range from multiplying the allowance.
CALLER_LIMITS: dict[str, dict[str, float]] = {
    "session": {
        "burst": float(os.getenv("AGENT_LIMIT_SESSION_BURST") or "4"),
        "sustained": float(os.getenv("AGENT_LIMIT_SESSION_HOUR") or "12"),
    },
    "ip": {
        "burst": float(os.getenv("AGENT_LIMIT_IP_BURST") or "8"),
        "sustained": float(os.getenv("AGENT_LIMIT_IP_HOUR") or "40"),
    },
    "net": {
        "burst": float(os.getenv("AGENT_LIMIT_SUBNET_BURST") or "20"),
        "sustained": float(os.getenv("AGENT_LIMIT_SUBNET_HOUR") or "120"),
    },
}

# Layer 3: how many proxies sit between this process and the internet, counted
# from the right of `X-Forwarded-For`. **0 is correct for a Cloud Run service
# addressed directly on its `*.run.app` URL, which is what
# `cloudbuild-agent.yaml` deploys.** Raise it to 1 the day anything is put in
# front (a Google external HTTPS load balancer appends its own address after
# the client's); leaving it at 0 then makes the IP layer read client-authored
# text. `rate_limit.resolve_client_ip`'s docstring is the full argument.
TRUSTED_PROXY_HOPS = _int("AGENT_TRUSTED_PROXY_HOPS", 0)

# Layer 4: how long a guardrail trip keeps costing the caller, and how far the
# multiplier can climb. One hour matches the sustained window, so a strike is
# felt for exactly as long as the allowance it is inflating.
ABUSE_WINDOW_SECONDS = float(os.getenv("AGENT_ABUSE_WINDOW_SECONDS") or "3600")
ABUSE_MULTIPLIER_CAP = float(os.getenv("AGENT_ABUSE_MULTIPLIER_CAP") or "8")


def session_secret() -> str | None:
    """HMAC key for the session cookie, read at call time.

    Same reasoning as `api_key()` — Cloud Run injects secrets before start, but
    tests patch this and local `.env` edits happen between runs. Absent is not
    an error: `rate_limit` falls back to a per-process random key, which costs
    session continuity across a restart and nothing else.
    """
    return os.getenv("AGENT_SESSION_SECRET") or None


# How long a session cookie identifies the same bucket. Long enough that a
# returning visitor keeps their own allowance rather than inheriting whatever
# their CGNAT neighbours have spent; short enough that a leaked cookie is not
# a permanent identity.
SESSION_TTL_SECONDS = _int("AGENT_SESSION_TTL_SECONDS", 7 * 24 * 3600)


# --- Observability ---------------------------------------------------------

# LangSmith reads these from the environment directly; the service only needs
# to make sure they are present and to expose whether tracing is actually on
# so `/health` can report it instead of us guessing from a dashboard.
LANGSMITH_TRACING = _flag("LANGSMITH_TRACING", False)
LANGSMITH_PROJECT = os.getenv("LANGSMITH_PROJECT") or "f1-agent"


def langsmith_configured() -> bool:
    return bool(LANGSMITH_TRACING and os.getenv("LANGSMITH_API_KEY"))


# --- Service ---------------------------------------------------------------

# Bumped whenever the prompt or answer contract changes; part of the answer
# cache key from CP61 onward so a prompt edit cannot serve stale answers.
# Bumped to 2 for CP61: `_answer` stopped being a bare chat completion and
# became the deep agent's system prompt + tool contract.
#
# Bumped to 3 for Batch 20 (CP73/CP75). Both halves of the contract this
# version gates changed: `SYSTEM_PROMPT` gained the one-call comparison rule,
# and the *tool* contract changed twice over — `get_head_to_head` and
# `get_driver_season_summary` now take driver names instead of Jolpica ids,
# and `today` was removed from the model-visible signature of
# `get_season_state`.
#
# The bump was not noticed from the diff; it was forced by a post-deploy check.
# The first live call after shipping CP73 replayed the *pre-fix* failure for
# the exact question CP73 was written to fix, straight out of the cache, which
# made a working fix look like a broken one. A checkpoint that changes what the
# model is told, or what its tools accept, has changed the answer contract even
# when no prompt string is edited — bump this.
PROMPT_VERSION = 3

# Defaults to local dev origins, NOT "*". Starlette echoes the caller's origin
# rather than emitting a literal `*`, so a wildcard default on a public,
# unauthenticated service rationing a shared inference quota is fully
# permissive to any site that wants to spend it. Production passes a single
# origin explicitly — but a safe default must not depend on that substitution
# being present, because the one time it is missing is the time it matters.
_DEFAULT_ORIGINS = "http://localhost:3113,http://127.0.0.1:3113"

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in (os.getenv("AGENT_ALLOWED_ORIGINS") or _DEFAULT_ORIGINS).split(",")
    if origin.strip()
]
