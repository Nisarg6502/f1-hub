"""On-disk HTTP cache, rate limiter and daily quota governor.

This module exists before any DEM code on purpose. OpenTopoData's public API
allows 1000 calls/day at 1 call/sec, and an accidental loop costs a full day of
build capability. Everything here is defensive:

- Every response is written to disk *immediately after it parses*, before the
  next call goes out, so a crash or Ctrl-C loses at most one batch.
- The daily counter is persisted on every spend, not at the end of the run.
- Exhausting the budget is a resumable exit, not an exception that discards the
  work already cached.

**The counter has to outlive the machine that spent it.** It originally lived in
`.cache/trackgeo/quota.json`, which is correct for a laptop and actively wrong
for a Cloud Run Job: a job's local disk is created fresh for every execution, so
every run would read an empty file, believe it had all 900 calls available, and
sail past the real published 1000/day limit — silently, since nothing on our
side would ever observe the overspend. `MongoQuotaStore` moves the counter to
the one place all executions share. The file store stays the default for CLI use
with no Mongo configured, and `QuotaExhausted` still exits cleanly with every
batch already fetched sitting on disk, whichever store is in play.

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
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

# Repo root is two levels up from scripts/trackgeo/cache.py
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# Overridable because the container's working copy is not a git checkout and its
# disk is ephemeral anyway — see Dockerfile.trackgeo, which points this at /tmp.
CACHE_ROOT = pathlib.Path(
    os.getenv("TRACKGEO_CACHE_DIR") or (REPO_ROOT / ".cache" / "trackgeo")
)

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


class QuotaStore:
    """Where the day's call count is kept.

    Two methods rather than a load/save pair, because `add` has to be atomic in
    the Mongo case: two executions racing on read-modify-write would each see the
    same starting count and together overspend by up to a full run's worth of
    calls.
    """

    def read(self, date: str) -> int:
        raise NotImplementedError

    def add(self, date: str, n: int) -> int:
        """Increment and return the new total for `date`."""
        raise NotImplementedError

    def describe(self) -> str:
        raise NotImplementedError


class FileQuotaStore(QuotaStore):
    """`.cache/trackgeo/quota.json` — the original, correct for a single machine."""

    def __init__(self, path: pathlib.Path | None = None) -> None:
        self.path = path if path is not None else cache_dir() / "quota.json"

    def read(self, date: str) -> int:
        if not self.path.exists():
            return 0
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return 0  # a corrupt counter should not block a build
        if raw.get("date") != date:
            return 0
        try:
            return int(raw.get("calls", 0))
        except (TypeError, ValueError):
            return 0

    def add(self, date: str, n: int) -> int:
        total = self.read(date) + n
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"date": date, "calls": total}), encoding="utf-8")
        except OSError:
            pass
        return total

    def describe(self) -> str:
        return str(self.path)


class MongoQuotaStore(QuotaStore):
    """One document per UTC day, shared by every machine that builds.

    This is the store that makes the budget mean anything in the cloud. The
    increment is a single `$inc`, so concurrent executions serialise on the
    server instead of clobbering each other's read-modify-write.
    """

    def __init__(self, collection: Any) -> None:
        self.collection = collection

    @staticmethod
    def _id(date: str) -> str:
        return f"opentopodata:{date}"

    def read(self, date: str) -> int:
        try:
            doc = self.collection.find_one({"_id": self._id(date)})
        except Exception as error:  # noqa: BLE001 - a driver error is not a build error
            print(f"trackgeo: quota read failed ({error}), assuming 0", file=sys.stderr)
            return 0
        return int((doc or {}).get("calls", 0))

    def add(self, date: str, n: int) -> int:
        try:
            doc = self.collection.find_one_and_update(
                {"_id": self._id(date)},
                {
                    "$inc": {"calls": n},
                    "$set": {
                        "date": date,
                        "updated_at": _dt.datetime.now(_dt.timezone.utc),
                    },
                },
                upsert=True,
                # pymongo.ReturnDocument.AFTER is literally True; spelling it out
                # avoids importing pymongo just to name a boolean, and keeps this
                # class usable against any find_one_and_update-shaped object.
                return_document=True,
            )
            return int((doc or {}).get("calls", n))
        except Exception as error:  # noqa: BLE001
            # Report the spend as if it landed. Over-counting a call we may not
            # have recorded is the safe direction to fail in.
            print(f"trackgeo: quota increment failed ({error})", file=sys.stderr)
            return self.read(date) + n

    def describe(self) -> str:
        return f"mongo:{getattr(self.collection, 'name', 'track_geometry_quota')}"


def default_quota_store() -> QuotaStore:
    """Mongo when it is configured and reachable, otherwise the local file.

    The fallback is what keeps the offline CLI working with no infrastructure at
    all; the Mongo path is what keeps a Cloud Run Job honest about a limit it
    would otherwise reset on every execution.
    """
    try:
        from .storage import QUOTA_COLLECTION, mongo_database  # noqa: PLC0415

        database = mongo_database()
        if database is not None:
            return MongoQuotaStore(database[QUOTA_COLLECTION])
    except Exception as error:  # noqa: BLE001
        print(f"trackgeo: Mongo quota unavailable ({error})", file=sys.stderr)
    return FileQuotaStore()


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
    store: QuotaStore | None = None
    # Called with the running total after every spend. The build script uses it
    # to advance the elevation-sampling progress bar, since one spend is exactly
    # one OpenTopoData call and sources.fetch_dem exposes no other hook.
    on_spend: Callable[[int], None] | None = field(default=None, repr=False)

    @classmethod
    def load(
        cls,
        base_url: str,
        limit: int = DAILY_CALL_BUDGET,
        store: QuotaStore | None = None,
    ) -> "Budget":
        unlimited = "api.opentopodata.org" not in base_url
        today = _utc_today()
        if unlimited:
            # No shared counter needed, and no reason to touch Mongo or disk.
            return cls(date=today, calls=0, limit=limit, unlimited=True, store=None)
        store = store if store is not None else default_quota_store()
        return cls(
            date=today,
            calls=store.read(today),
            limit=limit,
            unlimited=False,
            store=store,
        )

    @property
    def path(self) -> pathlib.Path | None:
        """Back-compat for callers that reported where the counter lives."""
        return getattr(self.store, "path", None)

    @property
    def remaining(self) -> int:
        if self.unlimited:
            return 1 << 30
        return max(0, self.limit - self.calls)

    def _exhausted(self) -> "QuotaExhausted":
        return QuotaExhausted(
            f"daily OpenTopoData budget spent ({self.calls}/{self.limit}). "
            "Cached batches are already on disk — re-run tomorrow to resume, "
            "or set OPENTOPODATA_BASE_URL to a local instance "
            "(docker run -p 5000:5000 opentopodata) to remove the limit."
        )

    def check(self, n: int = 1) -> None:
        """Refuse a call that would cross the limit, *before* it goes out.

        Re-reads the shared store rather than trusting the in-process count, so
        a second machine spending the same day's budget is noticed.
        """
        if self.unlimited:
            return
        if self.store is not None:
            self.calls = max(self.calls, self.store.read(self.date))
        if self.calls + n > self.limit:
            raise self._exhausted()

    def spend(self, n: int = 1) -> None:
        if self.unlimited:
            return
        if self.store is not None:
            self.calls = self.store.add(self.date, n)
        else:
            self.calls += n
        if self.on_spend is not None:
            self.on_spend(self.calls)
        # Verified after the increment, not before: the response is already
        # parsed and cached by the time spend() is called, so raising here keeps
        # the work and still stops the next call. Only a concurrent spender can
        # push us over this way.
        if self.calls > self.limit:
            raise self._exhausted()


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
