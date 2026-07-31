"""Where a built payload goes, and where the build reports what it is doing.

Everything in this module exists because the pipeline now runs in two very
different places, and each one broke a different assumption the offline CLI was
built on:

1. **The output path.** CP50 wrote `frontend/public/tracks/<key>.json`. That
   directory is copied into the frontend Docker image at *build* time, so a file
   written there at *run* time is never served by anything — the running
   container has the image's copy, not the job's. Cloud output therefore goes to
   `gs://f1-scratch-assets/tracks/<key>.json`, the bucket that already serves
   driver, team and flag images through `NEXT_PUBLIC_ASSET_BASE_URL`. The local
   directory stays a first-class destination for offline/CLI use — this is an
   additional sink, not a replacement.

2. **Progress.** A Cloud Run Job execution is invisible to the browser that
   triggered it. `BuildProgress` writes the frozen `track_geometry_builds`
   contract to Mongo as the build moves through its phases, and the frontend
   loader renders `phase`/`message` verbatim. Both strings are therefore written
   for a human ("Sampling elevation data…"), never as log lines.

Both cloud dependencies (`google-cloud-storage`, `pymongo`) are imported lazily,
inside the code path that actually needs them, so a plain local
`python scripts/build_track_geometry.py --only spa` still runs on a machine that
has neither installed.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import sys
from typing import Any

GCS_SCHEME = "gs://"

DEFAULT_GCS_DESTINATION = "gs://f1-scratch-assets/tracks"

# Payloads are immutable in practice but a rebuild must become visible without a
# cache purge, so this is short rather than the year-long max-age used for the
# content-addressed image assets in the same bucket.
GCS_CACHE_CONTROL = "public, max-age=300"

BUILDS_COLLECTION = "track_geometry_builds"
QUOTA_COLLECTION = "track_geometry_quota"


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


# --------------------------------------------------------------------------
# Mongo
# --------------------------------------------------------------------------


_mongo_database: Any = None
_mongo_resolved = False


def mongo_uri() -> str | None:
    """The configured Mongo URI, or None.

    Deliberately does NOT fall back to `mongodb://localhost:27017` the way
    `backend/app/db.py` does. For the API a local Mongo is a reasonable dev
    default; for this pipeline "no URI configured" has to mean "run fully
    offline against the local file cache", otherwise every CLI invocation would
    stall on a connection attempt to a database that is not there.
    """
    uri = os.getenv("MONGODB_URI") or os.getenv("mongodburi")
    return uri.strip() or None if uri else None


def mongo_database(*, quiet: bool = False) -> Any:
    """Return a pymongo Database, or None when Mongo is not usable here.

    Resolved once per process and memoised, including the None case: a build
    that cannot reach Mongo should degrade to file-backed quota and silent
    progress immediately, not re-attempt a 20 s connection on every call.
    """
    global _mongo_database, _mongo_resolved
    if _mongo_resolved:
        return _mongo_database

    _mongo_resolved = True
    uri = mongo_uri()
    if not uri:
        return None

    try:
        from pymongo import MongoClient  # noqa: PLC0415 - optional dependency
    except ImportError:
        if not quiet:
            print(
                "trackgeo: MONGODB_URI is set but pymongo is not installed — "
                "falling back to the local quota file and no progress reporting",
                file=sys.stderr,
            )
        return None

    db_name = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=20000)
        client.admin.command("ping")  # fail fast rather than at first real use
        _mongo_database = client[db_name]
    except Exception as error:  # noqa: BLE001 - any driver error means "no Mongo"
        if not quiet:
            print(f"trackgeo: Mongo unavailable ({error}) — running file-backed", file=sys.stderr)
        return None
    return _mongo_database


def reset_mongo_cache() -> None:
    """Forget the memoised connection. For tests only."""
    global _mongo_database, _mongo_resolved
    _mongo_database = None
    _mongo_resolved = False


# --------------------------------------------------------------------------
# Payload sinks
# --------------------------------------------------------------------------


def _serialize(payload: dict) -> bytes:
    # separators without spaces: machine-read, and it saves ~15%. Matches
    # emit.write_payload byte for byte so both sinks produce the same file.
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class PayloadSink:
    """Somewhere a built payload can be written."""

    def write(self, payload: dict) -> str:
        raise NotImplementedError

    def describe(self) -> str:
        raise NotImplementedError


class LocalSink(PayloadSink):
    """The original destination: a directory of `<key>.json` files."""

    def __init__(self, directory: str | pathlib.Path) -> None:
        self.directory = pathlib.Path(directory)

    def write(self, payload: dict) -> str:
        from . import emit  # noqa: PLC0415 - avoids a cycle at import time

        return str(emit.write_payload(payload, self.directory))

    def describe(self) -> str:
        return str(self.directory)


class GcsSink(PayloadSink):
    """`gs://<bucket>/<prefix>/<key>.json`, served via NEXT_PUBLIC_ASSET_BASE_URL."""

    def __init__(self, bucket: str, prefix: str = "") -> None:
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def object_name(self, key: str) -> str:
        return f"{self.prefix}/{key}.json" if self.prefix else f"{key}.json"

    def write(self, payload: dict) -> str:
        try:
            from google.cloud import storage as gcs  # noqa: PLC0415 - optional dependency
        except ImportError as error:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "writing to gs:// needs google-cloud-storage "
                "(pip install -r scripts/requirements.txt)"
            ) from error

        name = self.object_name(payload["id"])
        blob = gcs.Client().bucket(self.bucket).blob(name)
        blob.cache_control = GCS_CACHE_CONTROL
        blob.upload_from_string(_serialize(payload), content_type="application/json")
        return f"gs://{self.bucket}/{name}"

    def describe(self) -> str:
        return f"gs://{self.bucket}/{self.prefix}" if self.prefix else f"gs://{self.bucket}"


def resolve_sink(destination: str) -> PayloadSink:
    """`gs://bucket/prefix` -> GcsSink, anything else -> a local directory."""
    if destination.startswith(GCS_SCHEME):
        remainder = destination[len(GCS_SCHEME) :].strip("/")
        if not remainder:
            raise ValueError("a gs:// destination needs a bucket name")
        bucket, _, prefix = remainder.partition("/")
        return GcsSink(bucket, prefix)
    return LocalSink(destination)


# --------------------------------------------------------------------------
# Build progress
# --------------------------------------------------------------------------


class NullProgress:
    """No Mongo configured: every report is a no-op.

    Used by the local CLI so the pipeline code can call `progress.phase(...)`
    unconditionally instead of guarding every call site.
    """

    enabled = False

    def start(self) -> None:
        pass

    def phase(self, phase: str, progress_pct: int, message: str) -> None:
        pass

    def done(self, message: str = "3D view ready.") -> None:
        pass

    def fail(self, error: str, message: str = "The 3D build failed.") -> None:
        pass


class BuildProgress:
    """One `track_geometry_builds` document, updated as the build runs.

    The document shape is the batch's frozen contract and nothing may be added
    to it here, because CP57's status endpoint and CP58's loader are being built
    against it in parallel:

        {circuit_id, status, phase, progress_pct, message,
         started_at, updated_at, error}

    `status` is one of queued | running | done | failed. `phase` and `message`
    are rendered verbatim by the loader, so they are sentences for a person.

    A reporting failure never fails a build: losing the progress row is a
    cosmetic problem, while aborting a build that has already spent scarce
    OpenTopoData quota is a real one.
    """

    enabled = True

    def __init__(self, circuit_id: str, collection: Any) -> None:
        self.circuit_id = circuit_id
        self.collection = collection
        self.started_at = _now()

    def _set(self, **fields: Any) -> None:
        # MongoDB rejects an update where the same path is targeted by two
        # operators at once — `started_at` cannot appear in both `$set` and
        # `$setOnInsert` in the same call. `start()` deliberately `$set`s it
        # (a rebuild restarts the clock), so `$setOnInsert` is only added when
        # the caller has NOT already supplied it via `fields`.
        update: dict[str, Any] = {
            "$set": {
                "circuit_id": self.circuit_id,
                "updated_at": _now(),
                **fields,
            }
        }
        if "started_at" not in fields:
            update["$setOnInsert"] = {"started_at": self.started_at}
        try:
            self.collection.update_one(
                {"_id": self.circuit_id}, update, upsert=True
            )
        except Exception as error:  # noqa: BLE001 - never fail a build over telemetry
            print(f"trackgeo: progress update failed ({error})", file=sys.stderr)

    def start(self) -> None:
        # started_at is $set here (not $setOnInsert) so a rebuild of a circuit
        # that already has a finished row restarts the clock rather than
        # reporting an elapsed time measured from a previous build.
        self._set(
            status="running",
            phase="Starting",
            progress_pct=0,
            message="Starting the 3D build…",
            started_at=self.started_at,
            error=None,
        )

    def phase(self, phase: str, progress_pct: int, message: str) -> None:
        self._set(
            status="running",
            phase=phase,
            progress_pct=int(max(0, min(100, progress_pct))),
            message=message,
        )

    def done(self, message: str = "3D view ready.") -> None:
        self._set(
            status="done",
            phase="Done",
            progress_pct=100,
            message=message,
            error=None,
        )

    def fail(self, error: str, message: str = "The 3D build failed.") -> None:
        self._set(status="failed", phase="Failed", message=message, error=str(error))


def make_progress(circuit_id: str, *, database: Any = None) -> Any:
    """A BuildProgress when Mongo is reachable, otherwise a NullProgress."""
    db = database if database is not None else mongo_database()
    if db is None:
        return NullProgress()
    return BuildProgress(circuit_id, db[BUILDS_COLLECTION])
