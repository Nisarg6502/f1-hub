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
PROMPT_VERSION = 1

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
