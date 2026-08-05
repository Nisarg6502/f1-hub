"""The external web tools — `CHAT-AGENT-PLAN.md` §5.2, taxonomy classes 8-9.

Everything in `agent/tools/*` up to CP60 reads this app's own Mongo. These
three tools are the one place the agent reaches past that boundary, for the
two question classes nothing in our database can ever answer: **live world /
news** ("what's the latest on the 2027 engine regs?") and **rules / glossary**
("explain DRS") explicitly flagged as general knowledge, not app data.

Same fact-bundle contract as every other tool (`tools/base.py`), same
never-raises posture, same reasons — a search that returns nothing must not
abort an agent run that has already spent free-tier GPU time (§4.2) to answer
a question the run could simply say it could not research. What's different
here is *trust*: these are the only tools in the package whose payload was
written by someone other than this app or FastF1/Ergast, and that payload can
be actively adversarial. Every piece of retrieved text is therefore passed
through `agent/quarantine.py` before it reaches `data` — wrapped in
delimiters, tagged `untrusted`, and scanned for instruction-shaped content —
which is failure mode 2 in the plan's §10 table and the reason this
checkpoint exists at all.

**Talks to Tavily and Wikipedia directly over `httpx`, not through
`langchain-tavily`.** The package is pinned in `requirements-agent.txt`
because the plan named it, but `agent/model.py` already set the precedent for
this package: it talks to Ollama's own `/api/chat` endpoint directly rather
than through `langchain-ollama`'s `ChatOllama`, specifically so the "seam" —
one small module that knows the wire format — stays swappable and testable
with `httpx.MockTransport` and no framework import at all. `langchain-tavily`
0.2.18 turned out to match the plan's description reasonably well (its
`TavilySearchAPIWrapper`/`TavilyExtractAPIWrapper` post JSON to exactly the
endpoints used below and return the same `results` shape), so nothing here
contradicts it — but importing three LangChain `BaseTool` subclasses for two
POST requests this package can make itself would be the same unnecessary
framework coupling CP59 already declined once. Tavily's REST contract
(https://docs.tavily.com) is stable and small enough to own directly.

**Never triggers a FastF1 fetch.** Not a risk these tools could create on
their own — they hold no FastF1 import — but stated for the same reason
`tools/base.py` and `tools/__init__.py` both state it: the invariant is worth
repeating at every place someone might otherwise add a "just check the live
session" shortcut.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

from ..ledger import EvidenceLedger
from ..quarantine import quarantine
from .base import bundle, fact_tool, unavailable

# Overridable for tests and for a future self-hosted proxy; never anything
# other than Tavily's/Wikipedia's real hosts in production, since these are
# the one place this package's traffic leaves our own infrastructure.
TAVILY_BASE_URL = os.getenv("TAVILY_BASE_URL") or "https://api.tavily.com"
WIKIPEDIA_BASE_URL = (
    os.getenv("WIKIPEDIA_BASE_URL") or "https://en.wikipedia.org/api/rest_v1"
)

# Generous enough for an "advanced" Tavily search under real load, short
# enough that one slow upstream cannot quietly eat the in-process semaphore
# of 1 an agent run is guarded by (§4.2) — a hung web call would otherwise
# block every other queued caller, not just this one.
_REQUEST_TIMEOUT_SECONDS = 20.0

_VALID_TOPICS = {"general", "news", "finance"}
_MAX_SEARCH_RESULTS = 10
_MAX_EXTRACT_URLS = 5


def _tavily_api_key() -> str | None:
    """Read the key at call time, not import time — same reasoning as
    `agent/config.api_key()`: Cloud Run injects secrets before the process
    starts so import time would work there, but tests patch the environment
    and local dev edits `.env` between runs, and a module-level constant
    would silently ignore both.

    **`TAVILY_API_KEY` is provisioned in Secret Manager as a placeholder
    value right now** (`HANDOFF.md` / CP62's brief) — a present-but-fake key
    still reaches the network and gets a real 401/403 back from Tavily, which
    the status-code branch below turns into an ordinary `unavailable()`
    exactly like any other upstream failure. Nothing here assumes the key
    that exists is a *working* one.
    """
    return os.getenv("TAVILY_API_KEY") or None


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


@fact_tool("web_search")
async def web_search(
    query: str,
    topic: str = "general",
    max_results: int = 5,
    *,
    ledger: EvidenceLedger | None = None,
) -> dict:
    """Search the live web via Tavily and return quarantined, cited results.

    `topic="news"` is the right choice for taxonomy class 8 ("what's the
    latest on the 2027 engine regs?") — Tavily optimises news-topic queries
    for recency and mainstream coverage. `search_depth="basic"` is used
    rather than `"advanced"`, which costs two Tavily credits per call against
    a 1,000-credit/month free tier (§5.2's decision record); `"advanced"` is
    a tuning knob left for whoever wires this into the deep agent to raise
    per-query if the basic tier's relevance turns out to be insufficient,
    not a default this tool should spend on every call.

    Each result's `content` snippet — the only field here that is retrieved
    prose rather than metadata — is passed through `quarantine()` before it
    is returned. `title`/`url`/`score` are left as plain fields: they are
    short, structured, and Tavily's own relevance ranking, not free text
    written by the page's author, so scanning them for injected instructions
    would be motion without a real risk behind it.
    """
    query = (query or "").strip()
    if not query:
        return unavailable("no search query given")

    key = _tavily_api_key()
    if not key:
        return unavailable("no TAVILY_API_KEY is configured; web search is unavailable")

    topic = topic if topic in _VALID_TOPICS else "general"
    try:
        max_results = int(max_results)
    except (TypeError, ValueError):
        max_results = 5
    max_results = max(1, min(max_results, _MAX_SEARCH_RESULTS))

    payload: dict[str, Any] = {
        "query": query,
        "topic": topic,
        "max_results": max_results,
        "search_depth": "basic",
        "include_answer": False,
        "include_raw_content": False,
    }

    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{TAVILY_BASE_URL}/search", json=payload, headers=_headers(key)
        )

    if response.status_code != 200:
        return unavailable(f"tavily search failed: HTTP {response.status_code}")

    body = response.json() or {}
    raw_results = body.get("results") or []
    if not raw_results:
        return unavailable(f"no web results found for '{query}'")

    results = []
    for item in raw_results[:max_results]:
        results.append(
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "score": item.get("score"),
                **quarantine(item.get("content") or "", label=item.get("title")),
            }
        )

    return bundle(
        data={"query": query, "topic": topic, "results": results},
        source=f"web:tavily-search/{query[:80]}",
        ledger=ledger,
        tool="web_search",
        args={"query": query, "topic": topic, "max_results": max_results},
    )


@fact_tool("web_extract")
async def web_extract(
    urls: list[str] | str,
    *,
    ledger: EvidenceLedger | None = None,
) -> dict:
    """Read one or more specific pages via Tavily Extract, quarantined per page.

    For "reading one specific page the search surfaced" (§5.2) — a
    `web_search` hit whose snippet is not enough, or a URL the user or an
    earlier tool call already named. Capped at `_MAX_EXTRACT_URLS` per call
    for the same budget reason `web_search` caps `max_results`: an unbounded
    URL list is an unbounded number of Tavily credits and an unbounded
    payload size to quarantine and hand to the model.

    Every page's extracted text is quarantined independently — a call
    fetching several URLs must not let one page's injection risk (or lack of
    one) bleed into how another page's content is judged; each entry in the
    `pages` list carries its own `injection_suspected` and `injection_signals`.
    """
    if isinstance(urls, str):
        urls = [urls]
    urls = [u.strip() for u in (urls or []) if isinstance(u, str) and u.strip()]
    if not urls:
        return unavailable("no urls given")
    urls = urls[:_MAX_EXTRACT_URLS]

    key = _tavily_api_key()
    if not key:
        return unavailable("no TAVILY_API_KEY is configured; web extract is unavailable")

    payload = {"urls": urls, "extract_depth": "basic"}

    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{TAVILY_BASE_URL}/extract", json=payload, headers=_headers(key)
        )

    if response.status_code != 200:
        return unavailable(f"tavily extract failed: HTTP {response.status_code}")

    body = response.json() or {}
    raw_results = body.get("results") or []
    failed = body.get("failed_results") or []
    if not raw_results:
        return unavailable(
            f"tavily could not extract any of the {len(urls)} given url(s)",
            failed=failed,
        )

    pages = []
    for item in raw_results:
        pages.append(
            {
                "url": item.get("url"),
                **quarantine(item.get("raw_content") or "", label=item.get("url")),
            }
        )

    return bundle(
        data={"requested": urls, "pages": pages, "failed": failed},
        source=f"web:tavily-extract/{','.join(urls)[:120]}",
        ledger=ledger,
        tool="web_extract",
        args={"urls": urls},
    )


@fact_tool("wikipedia_summary")
async def wikipedia_summary(
    title: str,
    *,
    ledger: EvidenceLedger | None = None,
) -> dict:
    """A short, sourced glossary/background summary from Wikipedia.

    Free and keyless (§5.2), which is why this is the preferred route for
    taxonomy class 9 ("explain DRS") ahead of `web_search`: it costs no
    Tavily credit and its summary endpoint is built for exactly this shape of
    question. The plan's alternative for class 9 is bare model knowledge,
    "explicitly flagged as general knowledge, not app data" — this tool is
    what lets the answer carry a real citation instead of that flag being the
    whole story.

    Quarantined like every other web result, even though a landmark
    Wikipedia article is a comparatively low-risk source: it is still text
    written by someone outside this app, anyone can edit it, and the
    contract this package holds is "retrieved web text is untrusted", not
    "retrieved web text is untrusted unless the domain seems reputable" — the
    second version is a judgment call this module is not in a position to
    make per-source.
    """
    title = (title or "").strip()
    if not title:
        return unavailable("no title given")

    encoded = quote(title.replace(" ", "_"), safe="")
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{WIKIPEDIA_BASE_URL}/page/summary/{encoded}",
            headers={"User-Agent": "f1-hub-agent/1.0 (CP62 web research)"},
        )

    if response.status_code == 404:
        return unavailable(f"no Wikipedia page found for '{title}'")
    if response.status_code != 200:
        return unavailable(f"wikipedia summary failed: HTTP {response.status_code}")

    body = response.json() or {}
    extract = body.get("extract") or ""
    if not extract:
        return unavailable(f"'{title}' has no summary extract")

    page_url = ((body.get("content_urls") or {}).get("desktop") or {}).get("page")
    resolved_title = body.get("title") or title

    return bundle(
        data={
            "title": resolved_title,
            "description": body.get("description"),
            "page_url": page_url,
            **quarantine(extract, label=resolved_title),
        },
        source=f"web:wikipedia/{resolved_title}",
        ledger=ledger,
        tool="wikipedia_summary",
        args={"title": title},
    )
