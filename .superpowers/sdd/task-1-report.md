# CP71 Task 1 — Backend: citations carry an inspectable snippet

**Files:** `backend/agent/ledger.py`, `backend/tests/test_agent_ledger.py`. No frontend files touched.

## What shipped

`Evidence.citation()` gains `snippet: list[dict]` — up to 6 ordered `{"label", "value"}` pairs
rendered from `self.data`, so a citation pill can show the fact rather than only its provenance.

- `SNIPPET_MAX_PAIRS = 6`, `SNIPPET_MAX_VALUE = 120` (truncated with `…`). Sized as a transport
  constraint: this rides on every `sources` SSE event, one per evidence entry.
- Shallow flattening. Top-level scalars → pairs. A top-level list of dicts → a count summary plus
  its **first** entry's scalars, prefixed (`Results · Driver`). Anything deeper is summarised
  (`"12 items"` / `"2 fields"`), never dumped.
- Keys humanised (`race_name` → `Race name`); `_`-prefixed Mongo keys and `None` values dropped.
- Total shape tolerance: `None`, `{}`, a bare string/number, a list-at-root, a value whose `__str__`
  raises, a mapping whose `items()` raises — all return a list, never raise. `_snippet()` wraps the
  builder in a catch-all because a formatting error must not discard a good answer.
- `ledger.py` stays framework-free (new test asserts no langchain/langgraph import).
- All seven pre-existing citation keys unchanged.

## Tests

New `CitationSnippetTests` (23 cases) + `FrameworkFreedomTests`, written failing first. The one
pre-existing test asserting the full citation dict (`test_a_citation_has_no_url_for_an_internal_source`)
was updated to include `"snippet": []`.

`cd backend && python -m unittest discover tests` → **Ran 815 tests, OK (skipped=3)**.
