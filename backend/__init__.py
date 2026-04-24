"""Backend package for F1 Scratch API.

Having this file ensures `backend` is a regular Python package and
allows relative imports like `from . import app` to work reliably
across different runtime/import mechanisms.
"""

__all__ = ["app"]
