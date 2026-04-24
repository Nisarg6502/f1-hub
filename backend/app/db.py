"""
MongoDB connection module using motor (async driver).

Reads MONGODB_URI from environment. Falls back to localhost for local dev.
Database name: f1_scratch
"""

import os
from motor.motor_asyncio import AsyncIOMotorClient

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGODB_DB_NAME", "f1_scratch")

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
