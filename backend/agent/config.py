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


# How long a conversation thread's checkpoints survive.
#
# Thread memory is only useful for the life of a conversation, and the frontend
# starts a new thread every time the panel opens -- so without an expiry, every
# abandoned conversation is stored forever on a free tier that has 512MB in
# total. Seven days is far longer than any single conversation and short enough
# that the collection reaches a steady size instead of growing without bound.
CHECKPOINT_TTL_SECONDS = _int("AGENT_CHECKPOINT_TTL_SECONDS", 7 * 24 * 3600)


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
#
# Bumped to 4 for the chat-visuals slice. Both halves again: `SYSTEM_PROMPT`
# and `ORCHESTRATOR_SYSTEM_PROMPT` gained `_VISUAL_RULE`, and the tool contract
# gained `render_visual` — a tool the model can call that no cached answer was
# ever written with the option of calling. The stored rows also gained a
# `visuals` field, and a pre-bump row replaying with no picture for a question
# that now warrants one is precisely the "a working feature looks broken in
# production" failure the paragraph above was written after.
#
# Bumped to 5 for the same reason again, one paragraph later. `_VISUAL_RULE`'s
# threshold flipped from "most answers should have no chart" to "offer one
# whenever the bundle has more than one comparable value" — no tool changed
# and no signature changed, so nothing here would have forced the bump on its
# own. It is exactly the version-4 lesson: a version-4 cache row already holds
# a correct, cited answer with no chart for a standings-shaped question,
# because that was the right call under the OLD rule. Under the new rule the
# same question warrants one. Same evidence, different verdict, and a cache
# keyed only on the question text cannot tell those two rows apart without
# this bump — this was in fact how the old rule's behaviour was first noticed
# in production, replaying an unrelated pre-visuals question straight out of
# cache while diagnosing something else entirely.
#
# Bumped to 6 within the hour, after a clean live test of version 5 (fresh
# thread, no cache hit) asked "the points gap between the top 6 drivers",
# watched the model call `get_standings` and receive all six, and then answer
# with only the leader-vs-6th number and NO `render_visual` call. Version 5's
# wording was not wrong, it was outranked: the SYSTEM_PROMPT's older
# instruction — "when a tool has already returned the facts the question
# asked for, STOP and write the answer... it spends the step budget" — reads,
# to a 30B model under real step-budget pressure, as covering every further
# tool call including this one. Version 6 does not change the threshold
# again; it resolves that fight explicitly, in both directions: the STOP rule
# now says plainly that it means fact tools and names `render_visual` as the
# exception, and `_VISUAL_RULE` now opens by saying the call is part of
# finishing the answer rather than a further investigation, and to decide
# using the bundle's full shape rather than whichever number the prose ended
# up quoting. Same mechanism as versions 4 and 5: a version-5 cache row is a
# correct, chart-less answer that was wrong for a different reason than any
# prior version, and would keep replaying as "working as intended" without
# this bump.
#
# Bumped to 7 after a live "points: Antonelli vs Hamilton" answer called
# `render_visual` with hand-built SVG that invented `apex.rect(...)` and
# `apex.svg(...).attr(...)`, neither of which exist on the runtime — the
# frame threw, degraded to the table fallback (correctly — no facts lost),
# but the chart the reader asked for never rendered. Root cause:
# `_VISUAL_RULE` below documented only the low-level primitives
# (`apex.el`/`apex.svg`, `apex.axis`, ...) and never mentioned
# `apex.bars`/`apex.hbars` — the one-call mark builders `visual-runtime.ts`
# was explicitly designed to make "the common chart five lines rather than
# eighty of scale wiring" — so the model had to hand-assemble the chart from
# primitives every time, which is exactly where it hallucinated a D3-style
# `.attr()` API. `code` is a pure function of the prompt the model that wrote
# it saw; a cached version-6 answer for a comparison question may hold the
# same failed-chart pattern and must not replay it as settled.
#
# Bumped to 8 minutes later, same live conversation: the very next ask of an
# equivalent question drew one correct `apex.bars` chart (proof version 7
# worked) and one that rendered the literal text "[OBJECT OBJECT]" with axes
# but no bars. Two NEW runtime gaps, not a further prompt gap this time:
# `apex.caption`/the `text` attrs key did a bare `String(value)` instead of
# rejecting a non-string, and `apex.bars`/`hbars`/`dots` drew empty-but-
# labelled axes instead of the no-data state when every row's value accessor
# came back non-numeric (a wrong field name guessed for x/y). Both fixed in
# `frontend/src/lib/visual-runtime.ts`; `_VISUAL_RULE` below updated to match
# (it previously said `apex.el`/`apex.svg` are not chainable and `apex.rect`
# does not exist -- both became false the moment the runtime fix landed, so
# leaving the prompt as version 7 would have described a genuinely wrong API
# surface, worse than describing an incomplete one). See
# `CHAT-VISUALS-CONTRACT.md`'s "Incident, 2026-08-24 (part 2)" for the full
# writeup, including why this is runtime defence-in-depth rather than a
# third prompt-only patch: a prompt can reduce a model inventing plausible
# but wrong API surface, it cannot eliminate the risk entirely.
#
# Bumped to 9, same conversation again: the very next ask (this time for a
# clean comparison chart, no crash) drew a scatter/line chart that used each
# driver's array INDEX (0, 1) as a fake continuous x-axis labelled "Driver".
# Root cause was two-fold and genuinely new: (1) `_VISUAL_RULE` had no rule
# against inventing a continuous axis for named entities, so the model
# reached for `apex.lines`/`apex.dots` instead of `apex.bars` even with the
# comparison-shape guidance version 7 already added; (2) `get_head_to_head`
# -- the only comparison tool that existed -- carries season TOTALS only, by
# deliberate design (its own docstring: "the per-round arrays are trimmed
# off... a 24-row list per driver pair is a table"), so a model asked for
# anything progression-shaped had no real series to plot and improvised one.
# Fixed both: `_VISUAL_RULE` now explicitly forbids counting entities as an
# axis, and a new tool `get_points_progression` (agent/tools/drivers.py)
# gives the model an actual round-by-round series when a question calls for
# one, so "plot points by round" is now answerable instead of only fake-able.
# A cached version-8 answer to a progression-shaped question was written
# under a model that had neither guardrail, so it must not replay as settled.
#
# Bumped to 10 after a QA pass on a driver-comparison question intermittently
# (not every run — sampling variance, same question came back clean the next
# time) produced a correct `apex.bars` chart from `render_visual` AND, in the
# same answer's prose, a Markdown image referencing a URL for it —
# `/render_visual?evidence_id=...&title=...&caption=...` — that has never
# existed; the tool has no HTTP endpoint, it returns drawing instructions the
# frontend executes locally (`CHAT-VISUALS-CONTRACT.md` §4/§5). Rendered by
# `react-markdown`, that is a real `<img src>` the reader's browser fetches
# and 404s against this site's own origin, sitting right above the real
# chart with a near-duplicate caption. `_VISUAL_RULE` already said "never
# mention the tool [or] the chart... in your answer text" but did not name
# this specific shape of violating it; the rule now says explicitly that no
# URL for the chart exists and that Markdown image syntax must never appear
# in the answer at all. Paired with a frontend fix (`pitwall-assistant-panel
# .tsx` now renders nothing for any Markdown image, defense-in-depth for
# exactly the case a prompt fix alone cannot fully close — same reasoning as
# versions 7/8's runtime hardening). A cached version-9 answer to a
# comparison-shaped question may hold this same stray-image pattern and must
# not replay as settled.
PROMPT_VERSION = 10

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
