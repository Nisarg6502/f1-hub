"""On-demand 3D track-geometry builds — trigger, status, availability (CP57).

Batch 15 baked four circuits offline and shipped them as static files. Batch 16
turns that into a button: a visitor asks for a circuit, a Cloud Run Job runs the
same `scripts/trackgeo` pipeline, writes `gs://f1-scratch-assets/tracks/<key>.json`,
and reports its progress into Mongo as it goes. This module is only the *control
plane* for that — it never builds anything itself.

Division of responsibility, frozen in `ROADMAP.md`'s Batch 16 contract:

- **This module** creates the initial `queued` document, takes the global
  single-build lock, starts the job execution, and reads status back out.
- **The job (CP56)** owns every subsequent write to that document — `running`,
  the `phase`/`progress_pct`/`message` fields as it works, and the terminal
  `done`/`failed`. Nothing here duplicates those writes, so there is exactly one
  writer for progress and no interleaving between the API and the worker.

`track_geometry_builds` holds one document per circuit:

    {circuit_id, status, phase, progress_pct, message, started_at, updated_at, error}

with `status` one of `queued | running | done | failed`.

## Why the lock is a separate collection, and why it is race-safe

The build is expensive (OpenTopoData is a courtesy-rate public service and the
project's daily quota is shared), so **one build runs at a time, globally** — a
second click is rejected with 409 naming the circuit already building, never
queued behind it.

A read-then-write check ("is anything running? no? then mark mine running") is
wrong here on purpose-built grounds: this is a *public, unauthenticated*
endpoint, so two clicks landing in the same millisecond on two Cloud Run
instances is a realistic event, not a theoretical one, and both would pass the
read before either wrote. The lock is therefore a single document with a fixed
`_id` in `track_geometry_lock`, and acquisition is one atomic
`find_one_and_update(..., upsert=True)`:

- If the document does not exist, or exists with no holder, or exists with an
  expired holder, the filter matches and the update takes the lock.
- If the document exists *and* is validly held, the filter does not match, so
  the upsert tries to insert a second `_id: "global"` and MongoDB's unique `_id`
  index rejects it with `DuplicateKeyError`. That error *is* the "someone else
  won" signal, and the primary's index guarantees exactly one winner no matter
  how many instances race.

Handing the lock on is compare-and-swap for the same reason: takeover matches
the *specific* holder and `acquired_at` it observed, so a stale reader cannot
steal a lock that changed hands underneath it.

Two ways a lock is released: the holder's build document reaching a terminal
status (checked on the next acquisition attempt), or `LOCK_TTL_SECONDS`
elapsing, which covers a job that died without ever writing `failed`.

## Public-endpoint hardening

`circuit_id` is never used as anything but a lookup key. It is length-capped and
regex-checked, then resolved against the curated spec registry, and only the
*registry's own* key is ever passed to a job argument, a GCS path or a Mongo
query. A value that is not a known spec gets a 404 and touches nothing. There is
no path where caller-supplied text reaches a subprocess, a shell, or a URL.

Failures fail soft with a named error code rather than 500-ing, and internal
exception text is logged, never returned — the same philosophy as the rest of
this backend.

## Configuration

All of these are read at import time from the environment:

| Env var | Default | Purpose |
|---|---|---|
| `TRACK_GEOMETRY_JOB_NAME` | *(unset)* | Cloud Run Job to execute. **Required** — CP56 names and deploys the job, so there is deliberately no guessed default; unset means `/build` returns a clear `job_not_configured` payload instead of calling a job that may not exist. |
| `TRACK_GEOMETRY_PROJECT_ID` | `f1-dashboard-493015` | GCP project holding the job. |
| `TRACK_GEOMETRY_JOB_REGION` | `asia-south1` | Job region. |
| `TRACK_GEOMETRY_JOB_ARGS` | `--only,{key}` | Comma-separated argument override template; `{key}` is substituted with the resolved spec key. Configurable so a CP56 entrypoint change needs no backend release. |
| `TRACK_GEOMETRY_BUCKET` | `f1-scratch-assets` | Bucket holding built payloads. |
| `TRACK_GEOMETRY_PREFIX` | `tracks/` | Object prefix inside that bucket. |
| `TRACK_GEOMETRY_ASSET_BASE_URL` | `https://storage.googleapis.com/f1-scratch-assets` | Public base URL returned to the frontend. |
| `TRACK_GEOMETRY_SPECS` | *(unset)* | Optional `key:ergast_id:Display Name` list (comma-separated) that overrides spec discovery entirely — an escape hatch for a deployment that ships neither `curated.py` nor a spec collection. |
| `TRACK_GEOMETRY_SPEC_FILE` | *(unset)* | Explicit path to `curated.py`, bypassing the walk-up below. Only needed if the image layout stops mirroring the repo. |
| `TRACK_GEOMETRY_LOCK_TTL_SECONDS` | `1800` | How long a held lock survives without a terminal status. |
| `TRACK_GEOMETRY_AVAILABLE_TTL_SECONDS` | `60` | GCS listing cache window. |

## IAM the backend's service account needs (not changed by this module)

Applied to the *backend* Cloud Run service's runtime service account:

1. **`roles/run.invoker` on the geometry job**, i.e.
   `gcloud run jobs add-iam-policy-binding <TRACK_GEOMETRY_JOB_NAME>
   --region=asia-south1 --member=serviceAccount:<backend-sa>
   --role=roles/run.invoker`.
   This grants `run.jobs.run`. This module starts the execution *with argument
   overrides*, which additionally requires `run.jobs.runWithOverrides` — if the
   `:run` call comes back 403 while plain invoker is bound, grant
   **`roles/run.developer`** on the job instead, which contains both.
2. **`roles/storage.objectViewer` on `gs://f1-scratch-assets`**, for the
   `/available` listing. (Object *reads* may already be public; `objects.list`
   is not necessarily, and this endpoint lists.)

Nothing here attempts to modify IAM.

## Spec discovery is dynamic, never a hardcoded circuit list

CP55 adds 18 `CircuitSpec` entries in `scripts/trackgeo/curated.py` in parallel
with this checkpoint, so a list baked in here would be wrong the moment it
merged. The registry is resolved at runtime and cached for
`SPEC_TTL_SECONDS`.

**`curated.py` is the reliable default, and it is baked into the image.**
`Dockerfile.backend` copies that one file (and only that one — its siblings in
`scripts/trackgeo` import numpy/scipy, while `curated.py` imports nothing but
`dataclasses`) to `/app/scripts/trackgeo/curated.py`, mirroring the repo
layout. `_repo_curated_path()` therefore walks up from this module and finds it
at the same relative position in both worlds: `<root>/scripts/trackgeo/` where
`<root>` is the repo checkout locally and `/app` in the container. Nothing here
hardcodes a path that only works in one of the two, and
`TRACK_GEOMETRY_SPEC_FILE` can point at it explicitly if a future layout breaks
the walk-up.

The full order is:

1. `TRACK_GEOMETRY_SPECS`, if set — a total override, for a deployment that
   somehow has neither of the below.
2. The curated file. This is the load-bearing source.
3. The `track_geometry_specs` Mongo collection — optional, consulted only when
   the curated file is missing entirely. It is deliberately not the primary
   mechanism: the collection is empty until something publishes to it, so on a
   fresh deploy every `/build` would 404 — including the first click, which is
   precisely the flow this feature exists for. Keeping it off the normal path
   also means a slow or unreachable Mongo cannot delay "which circuits are
   buildable?" for a deployment that ships `curated.py`.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .db import get_db

try:  # pragma: no cover - trivial import shim
    from pymongo import ReturnDocument
    from pymongo.errors import DuplicateKeyError
except Exception:  # pragma: no cover - keeps the module importable without pymongo
    class DuplicateKeyError(Exception):
        pass

    class ReturnDocument:
        BEFORE = False
        AFTER = True


router = APIRouter(prefix="/api")

BUILDS_COLLECTION = "track_geometry_builds"
LOCK_COLLECTION = "track_geometry_lock"
SPECS_COLLECTION = "track_geometry_specs"
LOCK_ID = "global"

PROJECT_ID = os.getenv("TRACK_GEOMETRY_PROJECT_ID", "f1-dashboard-493015")
JOB_REGION = os.getenv("TRACK_GEOMETRY_JOB_REGION", "asia-south1")
JOB_NAME = os.getenv("TRACK_GEOMETRY_JOB_NAME", "").strip()
JOB_ARGS_TEMPLATE = os.getenv("TRACK_GEOMETRY_JOB_ARGS", "--only,{key}")
BUCKET = os.getenv("TRACK_GEOMETRY_BUCKET", "f1-scratch-assets")
OBJECT_PREFIX = os.getenv("TRACK_GEOMETRY_PREFIX", "tracks/")
ASSET_BASE_URL = os.getenv(
    "TRACK_GEOMETRY_ASSET_BASE_URL", "https://storage.googleapis.com/f1-scratch-assets"
).rstrip("/")

LOCK_TTL_SECONDS = int(os.getenv("TRACK_GEOMETRY_LOCK_TTL_SECONDS", "1800"))
AVAILABLE_TTL_SECONDS = int(os.getenv("TRACK_GEOMETRY_AVAILABLE_TTL_SECONDS", "60"))
SPEC_TTL_SECONDS = int(os.getenv("TRACK_GEOMETRY_SPEC_TTL_SECONDS", "300"))

TERMINAL_STATUSES = frozenset({"done", "failed"})
ACTIVE_STATUSES = frozenset({"queued", "running"})

# Deliberately strict: this is the *only* thing a caller controls, and it is
# then used as a Mongo key, a job argument and (indirectly) a GCS object name.
_CIRCUIT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")

_METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/"
    "instance/service-accounts/default/token"
)
# NOTE: the path segment is "service-accounts" — hyphenated and PLURAL. A
# previous version of this constant read "service_account" (underscore,
# singular), which does not exist on the real metadata server. httpx does not
# raise on a non-2xx response by default, so that 404 was silently swallowed by
# the `if response.status_code == 200` check below and fell through to the ADC
# fallback, which also fails (no google-auth dependency) — the net effect was
# every trigger returning "credentials_unavailable" with no clue why. Caught in
# production after CP56/57 deployed; see HANDOFF.md.


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


# How long a failed build is refused for before it may be retried.
#
# The global lock stops two builds running AT ONCE, and the already-built check
# stops a successful build repeating. Neither bounds the FAILURE loop: a circuit
# whose build fails releases the lock and returns to the unbuilt pool, so a
# script — or an impatient reload — can restart it as fast as the job can fail.
# Each attempt spends Cloud Run Job minutes and OpenTopoData courtesy quota,
# both of which this project has a strictly limited free allowance of, and a
# build that just failed is unlikely to succeed a second later anyway.
#
# Five minutes is short enough that a genuine transient failure (a cold job, a
# momentary upstream refusal) costs a person one wait, and long enough that a
# tight loop cannot spend anything meaningful.
BUILD_FAILURE_COOLDOWN_SECONDS = 300


def _failure_cooldown_remaining(existing: dict | None) -> int | None:
    """Seconds left before a failed build may be retried, or None if it may now.

    Reads the build document already fetched by the caller rather than adding a
    round trip, and treats an unreadable or missing timestamp as "no cooldown":
    the cost of wrongly allowing one retry is one job run, while wrongly
    blocking one is a circuit nobody can ever build.
    """
    if not existing or existing.get("status") != "failed":
        return None

    updated_at = existing.get("updated_at")
    if isinstance(updated_at, str):
        try:
            updated_at = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(updated_at, datetime):
        return None
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)

    elapsed = (_now() - updated_at).total_seconds()
    # A clock skew that puts the failure in the future must not read as an
    # indefinite block.
    if elapsed < 0 or elapsed >= BUILD_FAILURE_COOLDOWN_SECONDS:
        return None
    return int(BUILD_FAILURE_COOLDOWN_SECONDS - elapsed)


def _iso(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value


def _log(message: str) -> None:
    print(f"track_geometry: {message}")


def payload_url(key: str) -> str:
    return f"{ASSET_BASE_URL}/{OBJECT_PREFIX}{key}.json"


# --------------------------------------------------------------------------
# spec registry
# --------------------------------------------------------------------------

_spec_cache: dict = {"at": 0.0, "specs": {}}
_spec_lock = asyncio.Lock()


def _normalise_id(raw) -> str | None:
    """Lowercase, trim and validate a caller-supplied circuit id."""
    if not isinstance(raw, str):
        return None
    candidate = raw.strip().lower()
    if not _CIRCUIT_ID_RE.match(candidate):
        return None
    return candidate


def _specs_from_env() -> dict:
    raw = os.getenv("TRACK_GEOMETRY_SPECS", "").strip()
    if not raw:
        return {}
    specs: dict = {}
    for entry in raw.split(","):
        parts = [p.strip() for p in entry.split(":")]
        key = _normalise_id(parts[0] if parts else "")
        if not key:
            continue
        ergast = _normalise_id(parts[1]) if len(parts) > 1 and parts[1] else key
        display = parts[2] if len(parts) > 2 and parts[2] else key
        specs[key] = {
            "circuit_id": key,
            "ergast_circuit_id": ergast or key,
            "display_name": display,
        }
    return specs


# Relative to each ancestor of this module. The first is the repo layout, which
# `Dockerfile.backend` reproduces under /app on purpose so one rule covers both
# the container and a dev checkout; the second is a flatter layout in case a
# future image copies the module beside `app/`.
_CURATED_CANDIDATES = (
    ("scripts", "trackgeo", "curated.py"),
    ("trackgeo", "curated.py"),
)


def _repo_curated_path() -> Path | None:
    """Locate the curated `CircuitSpec` module.

    Resolved by walking up from *this file*, never from the process's working
    directory — uvicorn's cwd is `/app` in the container and `backend/` in dev,
    so a cwd-relative path would work in exactly one of them.
    """
    override = os.getenv("TRACK_GEOMETRY_SPEC_FILE", "").strip()
    if override:
        path = Path(override)
        return path if path.is_file() else None

    here = Path(__file__).resolve()
    for parent in here.parents:
        for parts in _CURATED_CANDIDATES:
            candidate = parent.joinpath(*parts)
            if candidate.is_file():
                return candidate
    return None


def _specs_from_curated_file() -> dict:
    """Load CP55's `SPECS` tuple straight off disk, if the repo tree is here.

    Loaded by file path rather than as `scripts.trackgeo.curated` so it works
    regardless of how the process was started, and without importing the
    pipeline package (whose other modules pull in numpy/scipy/httpx machinery
    the API has no business loading).
    """
    path = _repo_curated_path()
    if path is None:
        return {}
    try:
        spec = importlib.util.spec_from_file_location("_trackgeo_curated", path)
        if spec is None or spec.loader is None:
            return {}
        module = importlib.util.module_from_spec(spec)
        # `dataclasses` resolves annotations through `sys.modules[cls.__module__]`,
        # so a module executed without being registered there dies with an
        # opaque `'NoneType' object has no attribute '__dict__'`.
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        entries = getattr(module, "SPECS", ()) or ()
    except Exception as error:
        _log(f"could not read curated specs from {path}: {error}")
        return {}

    specs: dict = {}
    for entry in entries:
        key = _normalise_id(getattr(entry, "key", ""))
        if not key:
            continue
        ergast = _normalise_id(getattr(entry, "ergast_circuit_id", "") or "") or key
        specs[key] = {
            "circuit_id": key,
            "ergast_circuit_id": ergast,
            "display_name": getattr(entry, "display_name", "") or key,
        }
    return specs


async def _specs_from_mongo() -> dict:
    try:
        db = get_db()
        cursor = db[SPECS_COLLECTION].find({})
        # Hard timeout: this is a supplement, and a slow or unreachable Mongo
        # must not turn "which circuits are buildable?" into a 30s hang on the
        # driver's own server-selection timeout.
        docs = await asyncio.wait_for(cursor.to_list(length=200), timeout=5.0)
    except Exception as error:
        _log(f"spec collection unavailable: {error}")
        return {}

    specs: dict = {}
    for doc in docs or []:
        key = _normalise_id(doc.get("key") or doc.get("circuit_id") or "")
        if not key:
            continue
        ergast = _normalise_id(doc.get("ergast_circuit_id") or "") or key
        specs[key] = {
            "circuit_id": key,
            "ergast_circuit_id": ergast,
            "display_name": doc.get("display_name") or key,
        }
    return specs


async def load_specs(force: bool = False) -> dict:
    """Return `{key: spec_dict}`, cached for `SPEC_TTL_SECONDS`."""
    now = time.monotonic()
    if not force and _spec_cache["specs"] and now - _spec_cache["at"] < SPEC_TTL_SECONDS:
        return _spec_cache["specs"]

    async with _spec_lock:
        now = time.monotonic()
        if not force and _spec_cache["specs"] and now - _spec_cache["at"] < SPEC_TTL_SECONDS:
            return _spec_cache["specs"]

        specs = _specs_from_env()
        if not specs:
            specs = dict(_specs_from_curated_file())
            if not specs:
                # Only consulted when the baked-in file is missing. A circuit
                # published here that has no CircuitSpec could not be built
                # anyway, so this is a fallback, not an extension point — and
                # keeping it off the normal path means a Mongo hiccup can never
                # affect a deployment that ships curated.py.
                specs = await _specs_from_mongo()

        _spec_cache["specs"] = specs
        _spec_cache["at"] = time.monotonic()
        return specs


async def resolve_spec(raw_circuit_id) -> dict | None:
    """Resolve a caller id (spec key *or* Ergast circuitId) to a curated spec."""
    candidate = _normalise_id(raw_circuit_id)
    if candidate is None:
        return None
    specs = await load_specs()
    if candidate in specs:
        return specs[candidate]
    for spec in specs.values():
        if spec["ergast_circuit_id"] == candidate:
            return spec
    return None


# --------------------------------------------------------------------------
# Google API access
# --------------------------------------------------------------------------

_token_cache: dict = {"token": None, "expires_at": 0.0}


async def _access_token() -> str | None:
    """An OAuth token for the runtime service account, or None.

    Prefers the metadata server (always present on Cloud Run, zero
    dependencies); falls back to google-auth's ADC if that library happens to
    be installed, which makes local `gcloud auth application-default login`
    work without adding a required dependency to the image.
    """
    now = time.monotonic()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(
                _METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"}
            )
        if response.status_code == 200:
            body = response.json()
            token = body.get("access_token")
            if token:
                ttl = float(body.get("expires_in", 600) or 600)
                _token_cache["token"] = token
                _token_cache["expires_at"] = time.monotonic() + max(ttl - 60.0, 30.0)
                return token
            _log("metadata server returned 200 with no access_token in the body")
        else:
            # Logged at non-2xx specifically: this is the case a silent `pass`
            # previously hid, and it is exactly the failure mode the wrong URL
            # path produced — see the note on _METADATA_TOKEN_URL above.
            _log(
                f"metadata server token request returned {response.status_code}: "
                f"{response.text[:200]}"
            )
    except Exception as error:
        # Expected off-GCP (local dev, CI) — logged at low volume since it is
        # the normal path there, not a production alarm.
        _log(f"metadata server unreachable ({error}); trying ADC")

    try:  # pragma: no cover - depends on an optional library and real creds
        import google.auth  # type: ignore
        import google.auth.transport.requests  # type: ignore

        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        await asyncio.to_thread(
            credentials.refresh, google.auth.transport.requests.Request()
        )
        if credentials.token:
            _token_cache["token"] = credentials.token
            _token_cache["expires_at"] = time.monotonic() + 300.0
            return credentials.token
    except ImportError:
        pass  # google-auth is optional; this path is for local dev only
    except Exception as error:
        _log(f"ADC token refresh failed: {error}")

    return None


def _job_args(key: str) -> list[str]:
    """Build the job's argument override. `key` is already registry-validated."""
    return [part.format(key=key) for part in JOB_ARGS_TEMPLATE.split(",") if part]


async def trigger_job(key: str) -> tuple[bool, str]:
    """Start one execution of the geometry job. Returns (ok, error_code)."""
    if not JOB_NAME:
        return False, "job_not_configured"

    token = await _access_token()
    if not token:
        _log("no access token available; cannot start the geometry job")
        return False, "credentials_unavailable"

    url = (
        f"https://{JOB_REGION}-run.googleapis.com/v2/projects/{PROJECT_ID}"
        f"/locations/{JOB_REGION}/jobs/{JOB_NAME}:run"
    )
    body = {"overrides": {"containerOverrides": [{"args": _job_args(key)}]}}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url, json=body, headers={"Authorization": f"Bearer {token}"}
            )
    except Exception as error:
        _log(f"job trigger request failed: {error}")
        return False, "trigger_failed"

    if response.status_code in (200, 201, 202):
        return True, ""

    # Logged, never returned — the body can carry project/job internals.
    _log(f"job trigger returned {response.status_code}: {response.text[:400]}")
    if response.status_code in (401, 403):
        return False, "permission_denied"
    if response.status_code == 404:
        return False, "job_not_found"
    return False, "trigger_failed"


# --------------------------------------------------------------------------
# GCS availability
# --------------------------------------------------------------------------

_available_cache: dict = {"at": 0.0, "keys": frozenset(), "ok": False}
_available_lock = asyncio.Lock()


async def _list_bucket_keys() -> tuple[frozenset, bool]:
    """List `<prefix>*.json` object stems. Returns (keys, ok)."""
    url = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o"
    params = {
        "prefix": OBJECT_PREFIX,
        "delimiter": "/",
        "fields": "items(name),nextPageToken",
        "maxResults": "500",
    }
    headers = {}
    token = await _access_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    keys: set[str] = set()
    page_token = None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for _ in range(5):  # hard page cap; the bucket holds ~22 payloads
                query = dict(params)
                if page_token:
                    query["pageToken"] = page_token
                response = await client.get(url, params=query, headers=headers)
                if response.status_code != 200:
                    _log(f"bucket listing returned {response.status_code}")
                    return frozenset(), False
                body = response.json()
                for item in body.get("items", []) or []:
                    name = item.get("name", "")
                    if name.startswith(OBJECT_PREFIX) and name.endswith(".json"):
                        stem = name[len(OBJECT_PREFIX) : -len(".json")]
                        normalised = _normalise_id(stem)
                        if normalised:
                            keys.add(normalised)
                page_token = body.get("nextPageToken")
                if not page_token:
                    break
    except Exception as error:
        _log(f"bucket listing failed: {error}")
        return frozenset(), False

    return frozenset(keys), True


async def available_keys(force: bool = False) -> tuple[frozenset, bool]:
    """Cached view of what is actually in the bucket.

    Cached for `AVAILABLE_TTL_SECONDS` and single-flighted behind a lock so a
    public button — or a frontend poller — cannot turn into a GCS listing
    storm. On a listing failure the previous good answer is kept and `ok` goes
    false, so the caller can degrade rather than wrongly report "nothing built".
    """
    now = time.monotonic()
    if not force and _available_cache["ok"] and now - _available_cache["at"] < AVAILABLE_TTL_SECONDS:
        return _available_cache["keys"], True

    async with _available_lock:
        now = time.monotonic()
        if not force and _available_cache["ok"] and now - _available_cache["at"] < AVAILABLE_TTL_SECONDS:
            return _available_cache["keys"], True

        keys, ok = await _list_bucket_keys()
        if ok:
            _available_cache["keys"] = keys
            _available_cache["at"] = time.monotonic()
            _available_cache["ok"] = True
            return keys, True
        return _available_cache["keys"], False


# --------------------------------------------------------------------------
# build documents
# --------------------------------------------------------------------------


def _public_doc(doc: dict | None, spec: dict | None = None) -> dict | None:
    """Project a stored build document into the frozen response shape."""
    if not doc:
        return None
    out = {
        "circuit_id": doc.get("circuit_id"),
        "status": doc.get("status"),
        "phase": doc.get("phase"),
        "progress_pct": doc.get("progress_pct"),
        "message": doc.get("message"),
        "started_at": _iso(doc.get("started_at")),
        "updated_at": _iso(doc.get("updated_at")),
        "error": doc.get("error"),
    }
    out["ergast_circuit_id"] = doc.get("ergast_circuit_id") or (
        spec or {}
    ).get("ergast_circuit_id")
    out["display_name"] = doc.get("display_name") or (spec or {}).get("display_name")
    if out["status"] == "done" and out["circuit_id"]:
        out["url"] = payload_url(out["circuit_id"])
    return out


def _synthetic_done_doc(spec: dict) -> dict:
    """A `done` document for a circuit whose payload exists without a build row.

    The four Batch 15 circuits were baked offline and were never queued through
    this API, so `/status` would otherwise 404 for a circuit the viewer can
    happily load.
    """
    return {
        "circuit_id": spec["circuit_id"],
        "ergast_circuit_id": spec["ergast_circuit_id"],
        "display_name": spec["display_name"],
        "status": "done",
        "phase": "complete",
        "progress_pct": 100,
        "message": "Geometry already available.",
        "started_at": None,
        "updated_at": None,
        "error": None,
    }


async def _read_build(db, key: str) -> dict | None:
    # Filters by `_id`, NOT the `circuit_id` field — see the note on the
    # `queued_doc` upsert below for why the two are not interchangeable here.
    try:
        return await db[BUILDS_COLLECTION].find_one({"_id": key})
    except Exception as error:
        _log(f"build read failed for {key}: {error}")
        return None


# --------------------------------------------------------------------------
# the global single-build lock
# --------------------------------------------------------------------------


async def _lock_holder(db) -> dict | None:
    try:
        return await db[LOCK_COLLECTION].find_one({"_id": LOCK_ID})
    except Exception as error:
        _log(f"lock read failed: {error}")
        return None


async def acquire_lock(db, spec: dict) -> tuple[bool, dict | None]:
    """Take the global build lock atomically.

    Returns `(True, None)` on success, or `(False, holder_doc)` when another
    circuit holds it. See the module docstring for why this is a conditional
    upsert plus a compare-and-swap rather than a read followed by a write.
    """
    key = spec["circuit_id"]
    now = _now()
    expires_at = now + timedelta(seconds=LOCK_TTL_SECONDS)
    claim = {
        "holder": key,
        "holder_display": spec.get("display_name") or key,
        "acquired_at": now,
        "expires_at": expires_at,
    }

    # Attempt 1 — free, never-created, or expired. The unique `_id` index turns
    # a lost race into DuplicateKeyError rather than a second lock.
    try:
        await db[LOCK_COLLECTION].find_one_and_update(
            {
                "_id": LOCK_ID,
                "$or": [
                    {"holder": None},
                    {"holder": {"$exists": False}},
                    {"expires_at": {"$lte": now}},
                ],
            },
            {"$set": claim},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return True, None
    except DuplicateKeyError:
        pass
    except Exception as error:
        _log(f"lock acquire failed: {error}")
        return False, None

    holder = await _lock_holder(db)
    if not holder or not holder.get("holder"):
        return False, None

    holder_key = holder.get("holder")
    if holder_key == key:
        # Same circuit already queued/running — not a lock failure to report as
        # a different circuit; the caller decides what that means.
        return False, holder

    # Attempt 2 — the holder finished but never released. Compare-and-swap on
    # the exact holder/acquired_at observed, so a concurrent handover wins
    # cleanly instead of both callers believing they took the lock.
    holder_build = await _read_build(db, holder_key)
    if holder_build and holder_build.get("status") in TERMINAL_STATUSES:
        try:
            result = await db[LOCK_COLLECTION].find_one_and_update(
                {
                    "_id": LOCK_ID,
                    "holder": holder_key,
                    "acquired_at": holder.get("acquired_at"),
                },
                {"$set": claim},
                return_document=ReturnDocument.AFTER,
            )
        except Exception as error:
            _log(f"lock handover failed: {error}")
            return False, holder
        if result:
            return True, None

    return False, holder


async def release_lock(db, key: str) -> None:
    """Release the lock only if we still hold it (compare on holder)."""
    try:
        await db[LOCK_COLLECTION].update_one(
            {"_id": LOCK_ID, "holder": key},
            {"$set": {"holder": None, "holder_display": None, "expires_at": _now()}},
        )
    except Exception as error:
        _log(f"lock release failed: {error}")


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------


class BuildRequest(BaseModel):
    circuit_id: str


@router.post("/track_geometry/build")
async def start_track_geometry_build(request: BuildRequest):
    """Queue a geometry build for one circuit.

    - `202` with the status document when a build was queued and the job started.
    - `200` with `already_built: true` when the payload already exists — the
      first successful build is permanent, so there is nothing to do and this is
      not an error state for the UI to render. (The contract allowed 409 here;
      200 is chosen so the frontend's success path is "load the payload"
      regardless of whether this click or an earlier one produced it.)
    - `409` `build_in_progress` when another circuit holds the global lock; the
      body names that circuit so the UI can say "Already generating Silverstone".
    - `404` `unknown_circuit` when the id has no `CircuitSpec`.
    - `503` with a named code when the job could not be started.
    """
    spec = await resolve_spec(request.circuit_id)
    if spec is None:
        return JSONResponse(
            status_code=404,
            content={
                "error": "unknown_circuit",
                "message": "That circuit has no track geometry recipe yet.",
            },
        )

    key = spec["circuit_id"]
    db = get_db()

    built, listing_ok = await available_keys()
    existing = await _read_build(db, key)
    if key in built:
        doc = existing if (existing or {}).get("status") == "done" else _synthetic_done_doc(spec)
        return JSONResponse(
            status_code=200,
            content={"already_built": True, "build": _public_doc(doc, spec)},
        )
    if not listing_ok and (existing or {}).get("status") == "done":
        # GCS listing degraded; trust the terminal build record rather than
        # rebuilding something that is very likely already there.
        return JSONResponse(
            status_code=200,
            content={"already_built": True, "build": _public_doc(existing, spec)},
        )

    cooling = _failure_cooldown_remaining(existing)
    if cooling is not None:
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": str(cooling)},
            content={
                "error": "build_cooling_down",
                "circuit_id": key,
                "display_name": spec.get("display_name"),
                "retry_after_seconds": cooling,
                "message": (
                    "That build failed recently. Give it a few minutes before trying again."
                ),
                "build": _public_doc(existing, spec),
            },
        )

    acquired, holder = await acquire_lock(db, spec)
    if not acquired:
        holder_key = (holder or {}).get("holder")
        if holder_key == key:
            return JSONResponse(
                status_code=409,
                content={
                    "error": "build_in_progress",
                    "circuit_id": key,
                    "display_name": spec.get("display_name"),
                    "same_circuit": True,
                    "message": f"{spec.get('display_name') or key} is already generating.",
                    "build": _public_doc(existing, spec),
                },
            )
        if holder_key:
            holder_spec = await resolve_spec(holder_key) or {}
            holder_name = (
                holder.get("holder_display")
                or holder_spec.get("display_name")
                or holder_key
            )
            return JSONResponse(
                status_code=409,
                content={
                    "error": "build_in_progress",
                    "circuit_id": holder_key,
                    "display_name": holder_name,
                    "same_circuit": False,
                    "message": f"Already generating {holder_name}. Try again once it finishes.",
                    "build": _public_doc(await _read_build(db, holder_key), holder_spec),
                },
            )
        return JSONResponse(
            status_code=503,
            content={
                "error": "lock_unavailable",
                "message": "Could not start a build right now. Please try again shortly.",
            },
        )

    now = _now()
    queued_doc = {
        "circuit_id": key,
        "ergast_circuit_id": spec["ergast_circuit_id"],
        "display_name": spec["display_name"],
        "status": "queued",
        "phase": "queued",
        "progress_pct": 0,
        "message": "Queued — waiting for a build worker.",
        "started_at": now,
        "updated_at": now,
        "error": None,
    }
    # Filtered and upserted by `_id: key`, matching the pipeline's own
    # `BuildProgress`, which always upserts `{"_id": self.circuit_id}` — see
    # `scripts/trackgeo/storage.py`. `circuit_id` stays as an ordinary field in
    # the document (for readability and any query that finds it more natural),
    # but it must never be the filter for a write or a read: the earlier code
    # filtered by the `circuit_id` field, which meant the very first upsert
    # here — before the job ever runs — created a document with an
    # auto-generated ObjectId `_id`, distinct from the `_id: <circuit_id>`
    # document the job upserts into moments later. Every build ended up
    # split across two rows: the one this endpoint could see, permanently
    # stuck at "queued", and the one actually being updated with real
    # progress, which nothing ever read. Caught only after a separate,
    # unrelated fix (the started_at $set/$setOnInsert conflict in
    # storage.py) let the job's writes start succeeding for the first time —
    # before that, both rows were equally stuck, and the split was invisible.
    try:
        await db[BUILDS_COLLECTION].update_one(
            {"_id": key}, {"$set": queued_doc}, upsert=True
        )
    except Exception as error:
        _log(f"could not write queued doc for {key}: {error}")
        await release_lock(db, key)
        return JSONResponse(
            status_code=503,
            content={
                "error": "queue_failed",
                "message": "Could not start a build right now. Please try again shortly.",
            },
        )

    ok, code = await trigger_job(key)
    if not ok:
        failed = {
            "status": "failed",
            "phase": "trigger",
            "message": "The build could not be started.",
            "error": code,
            "updated_at": _now(),
        }
        try:
            await db[BUILDS_COLLECTION].update_one({"_id": key}, {"$set": failed})
        except Exception as error:
            _log(f"could not mark {key} failed: {error}")
        await release_lock(db, key)
        return JSONResponse(
            status_code=503,
            content={
                "error": code,
                "message": "Could not start the geometry build. Please try again later.",
            },
        )

    return JSONResponse(status_code=202, content={"build": _public_doc(queued_doc, spec)})


@router.get("/track_geometry/status")
async def get_track_geometry_status(circuit_id: str = Query(...)):
    """Current build state for one circuit, or 404 if it was never built."""
    spec = await resolve_spec(circuit_id)
    if spec is None:
        return JSONResponse(
            status_code=404,
            content={
                "error": "unknown_circuit",
                "message": "That circuit has no track geometry recipe yet.",
            },
        )

    key = spec["circuit_id"]
    doc = await _read_build(get_db(), key)
    if doc:
        # `done` is the frontend's cue to stop polling and re-render into the
        # viewer, which it does by re-reading /available. That listing is cached
        # for AVAILABLE_TTL_SECONDS, so a build finishing inside the current
        # window reports done while /available still omits the circuit — and the
        # page falls back to the Generate button it just came from. Refresh the
        # listing here so the two endpoints cannot disagree at the one moment
        # the UI acts on the answer. Costs one GCS list, once per build.
        if doc.get("status") == "done":
            built, _ok = await available_keys()
            if key not in built:
                await available_keys(force=True)
        return JSONResponse(content={"build": _public_doc(doc, spec)})

    built, _ok = await available_keys()
    if key in built:
        return JSONResponse(content={"build": _public_doc(_synthetic_done_doc(spec), spec)})

    return JSONResponse(
        status_code=404,
        content={
            "error": "not_built",
            "circuit_id": key,
            "message": "No build has been requested for this circuit yet.",
        },
    )


@router.get("/track_geometry/available")
async def list_available_track_geometry():
    """Circuits that already have a payload in GCS.

    Intersected with the curated spec registry, so the response can never echo
    an arbitrary object name back to the frontend, and every entry carries the
    Ergast circuitId the app keys circuits by — which is what lets CP58 delete
    its hardcoded `GEOMETRY_BY_CIRCUIT_ID` map.

    `degraded: true` means the bucket listing failed and this is a stale or
    empty answer; the frontend should keep its current state rather than hide
    tracks it was already showing.
    """
    specs = await load_specs()
    keys, ok = await available_keys()

    circuits = [
        {
            "circuit_id": spec["circuit_id"],
            "ergast_circuit_id": spec["ergast_circuit_id"],
            "display_name": spec["display_name"],
            "url": payload_url(spec["circuit_id"]),
        }
        for key, spec in sorted(specs.items())
        if key in keys
    ]
    return JSONResponse(
        content={
            "circuits": circuits,
            "buildable": sorted(specs.keys()),
            "degraded": not ok,
        }
    )
