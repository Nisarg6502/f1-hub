"""Load this repo's `.env` files, in the right order, from anywhere.

A bare `load_dotenv()` walks up from the caller and stops at the **first**
`.env` it finds. This repo has two, and the nearer one is the wrong one:

    .env            <- MONGODB_URI, OLLAMA_API_KEY   (the one that matters)
    backend/.env    <- a Maps key and an email password, and no database URI

So anything under `backend/` — `app/db.py`, `scripts/sync_race_radio.py`,
`data_sync.py`, a `uvicorn --app-dir backend` process — silently resolves
`MONGODB_URI` to the `mongodb://localhost:27017` default and then fails against
a database that was never running. It is a confusing failure because it reads as
a connection problem rather than a configuration one, and because the same code
works when run from the repo root.

Both files are loaded, root first, and `override=False` on the second means the
root's values win where they overlap. A variable already exported into the
environment beats both, which is what makes the deployed services unaffected:
in a container there is no `.env` at all and every call here is a no-op.

Kept free of every import except `dotenv` so the transcription job can call it
without dragging in a scientific stack — see `openf1_sessions.py` for what that
costs when it goes wrong.
"""

from pathlib import Path

# `backend/app/local_env.py` -> repo root is three parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]


def load_local_env() -> None:
    """Load `.env` then `backend/.env`, if `python-dotenv` is installed."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - dotenv is optional in production
        return

    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "backend" / ".env", override=False)
