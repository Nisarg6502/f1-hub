"""API subpackage for backend.app

This file marks `backend.app` as a package so relative imports
like `from . import races` work reliably when the app is started
by different tools (uvicorn, pytest, etc.).
"""

__all__ = [
    "main",
    "races",
    "participants",
    "session_results",
    "championship_standings",
    "circuit_info",
]
