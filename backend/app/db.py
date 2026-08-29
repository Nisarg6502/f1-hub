"""
MongoDB connection module using motor (async driver).

Reads MONGODB_URI from environment. Falls back to localhost for local dev.
Database name: f1_scratch
"""

import os
from motor.motor_asyncio import AsyncIOMotorClient

from .local_env import load_local_env

# Both `.env` files, root first. A bare `load_dotenv()` stops at `backend/.env`,
# which has no `MONGODB_URI`, so every process started from inside `backend/`
# — including `uvicorn --app-dir backend` — silently fell back to localhost.
load_local_env()

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    """Return a singleton Motor client."""
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(MONGODB_URI)
    return _client


def get_db():
    """Return the default database instance."""
    return get_client()[DB_NAME]
