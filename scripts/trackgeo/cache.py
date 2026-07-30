"""On-disk HTTP cache, rate limiter and daily quota governor.

This module exists before any DEM code on purpose. OpenTopoData's public API
allows 1000 calls/day at 1 call/sec, and an accidental loop costs a full day of
build capability. Everything here is defensive:

- Every response is written to disk *immediately after it parses*, before the
  next call goes out, so a crash or Ctrl-C loses at most one batch.
- The daily counter is persisted on every spend, not at the end of the run.
- Exhausting the budget is a resumable exit, not an exception that discards the
  work already cached.

The cache key for a DEM batch is a hash of the coordinates actually sent, so a
re-run reproduces it bit-for-bit and costs nothing. See sources.dem_batch_key
and the note in scripts/README.md about why the DEM query set is deliberately
independent of every smoothing parameter.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

# Repo root is two levels up from scripts/trackgeo/cache.py
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE_ROOT = REPO_ROOT / ".cache" / "trackgeo"

USER_AGENT = "f1-hub-track-geometry-build/1 (+https://github.com/Nisarg6502)"

# OpenTopoData public API limits: 1 call/sec, 1000 calls/day, 100 locations/call.
OPENTOPO_SLEEP_S = 1.15  # margin over the 1/sec limit
DAILY_CALL_BUDGET = 900  # of 1000, leaving headroom for retries
HTTP_TIMEOUT_S = 60
HTTP_RETRIES = 3


class QuotaExhausted(RuntimeError):
    """Raised when the daily DEM call budget is spent."""


def _utc_today() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")


def cache_dir(*parts: str) -> pathlib.Path:
    path = CACHE_ROOT.joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


# --------------------------------------------------------------------------
# Rate limiting
# --------------------------------------------------------------------------

_last_call_at = 0.0


def throttle(min_interval_s: float = OPENTOPO_SLEEP_S) -> None:
    """Block until at least min_interval_s has passed since the last request.

    A fixed inter-call sleep, not exponential backoff: 1 call/sec is a hard
    published rate, so pacing every call is correct rather than reacting to 429s
    after the fact.
    """
    global _last_call_at
    wait = min_interval_s - (time.monotonic() - _last_call_at)
    if wait > 0:
        time.sleep(wait)
    _last_call_at = time.monotonic()


# --------------------------------------------------------------------------
# Daily quota
# --------------------------------------------------------------------------


@dataclass
class Budget:
    """Persistent daily call counter for the OpenTopoData public API.

    Skipped entirely when pointed at a self-hosted instance, since the limit is
    a property of the public host rather than of the protocol.
    """

    date: str
    calls: int
    limit: int
    unlimited: bool
    path: pathlib.Path

    @classmethod
    def load(cls, base_url: str, limit: int = DAILY_CALL_BUDGET) -> "Budget":
        unlimited = "api.opentopodata.org" not in base_url
        path = cache_dir() / "quota.json"
        today = _utc_today()
        calls = 0
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if raw.get("date") == today:
                    calls = int(raw.get("calls", 0))
            except (ValueError, OSError):
                pass  # a corrupt counter should not block a build
        return cls(date=today, calls=calls, limit=limit, unlimited=unlimited, path=path)

    @property
    def remaining(self) -> int:
        if self.unlimited:
            return 1 << 30
        return max(0, self.limit - self.calls)

    def check(self, n: int = 1) -> None:
        if not self.unlimited and self.calls + n > self.limit:
            raise QuotaExhausted(
                f"daily OpenTopoData budget spent ({self.calls}/{self.limit}). "
                "Cached batches are already on disk — re-run tomorrow to resume, "
                "or set OPENTOPODATA_BASE_URL to a local instance "
                "(docker run -p 5000:5000 opentopodata) to remove the limit."
            )

    def spend(self, n: int = 1) -> None:
        self.check(n)
        self.calls += n
        self._persist()

    def _persist(self) -> None:
        if self.unlimited:
            return
        try:
            self.path.write_text(
                json.dumps({"date": self.date, "calls": self.calls}),
                encoding="utf-8",
            )
        except OSError:
            pass


# --------------------------------------------------------------------------
# HTTP with disk cache
# --------------------------------------------------------------------------


def _http_get(url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(HTTP_RETRIES):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            last_error = error
            # 429/5xx are worth retrying; 4xx otherwise is a real error.
            if error.code != 429 and error.code < 500:
                raise
            time.sleep(2.0 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"GET failed after {HTTP_RETRIES} attempts: {url}") from last_error


def cached_json(
    url: str,
    *,
    subdir: str,
    key: str,
    budget: Budget | None = None,
    throttled: bool = False,
    force: bool = False,
) -> tuple[dict, bool]:
    """Fetch JSON, caching the parsed body on disk under subdir/key.json.

    Returns (payload, was_cached). Spends one unit of budget only on a real
    network call, and writes the response to disk before returning so an
    interrupted run keeps everything it already paid for.
    """
    path = cache_dir(subdir) / f"{key}.json"
    if path.exists() and not force:
        try:
            return json.loads(path.read_text(encoding="utf-8")), True
        except ValueError:
            path.unlink(missing_ok=True)  # corrupt entry: re-fetch

    if budget is not None:
        budget.check(1)
    if throttled:
        throttle()

    body = _http_get(url)
    payload = json.loads(body.decode("utf-8"))

    # Persist before accounting so a crash between the two costs nothing.
    path.write_text(json.dumps(payload), encoding="utf-8")
    if budget is not None:
        budget.spend(1)
    return payload, False


def cached_text(url: str, *, subdir: str, key: str, force: bool = False) -> tuple[str, bool]:
    """Fetch a text body (CSV, README), caching it on disk verbatim."""
    path = cache_dir(subdir) / key
    if path.exists() and not force:
        return path.read_text(encoding="utf-8"), True
    text = _http_get(url).decode("utf-8")
    path.write_text(text, encoding="utf-8")
    return text, False


def opentopo_base_url() -> str:
    return os.getenv("OPENTOPODATA_BASE_URL", "https://api.opentopodata.org").rstrip("/")
