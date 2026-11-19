"""Write recent races' AI text during the hourly sync, not on someone's first visit.

`/api/session_recap` and `/api/strategy_commentary` generate on a cache miss.
That put the model call, and its quota, inside the first reader's page load: the
person opening the newest race (the one most people open) was exactly the one
who waited, and when Ollama Cloud's cap was hit they got no card at all, while
rounds opened earlier still had one. Calling the endpoints after the sync has
stored a round's results moves that cost to a moment nobody is waiting on.

The calls go through the public API rather than the generators, for the same
reason `watch_cache_warm.py` does: the request exercises exactly the code a
reader would, so the text is cached under the same key and fingerprint.

Only rounds from the last `window_days` are warmed. Older uncached rounds stay
on demand, so a first run, or a long outage followed by a recovery, cannot burn
a whole quota backfilling past seasons in one go.

Stdlib only, like `watch_cache_warm.py`. Never raises: a missing recap is a card
with an empty state, not a failed sync.
"""

import datetime
import json
import urllib.parse
import urllib.request

# A recap is a model call of tens of seconds; commentary can be longer.
TIMEOUT_S = 240


def _get_text(url: str) -> str | None:
    """The response body as text, or `None` on any failure."""
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "apex-ai-warmer"})
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return response.read().decode("utf-8")
    except Exception as error:  # noqa: BLE001 - reported, never raised
        print(f"  ! {url}: {error}")
        return None


def ai_targets(
    races: list[dict], year: int, today: datetime.date, window_days: int = 30
) -> list[str]:
    """Relative API paths to warm, rounds ascending.

    A round qualifies when its race date is before `today` and no more than
    `window_days` before it. Each qualifying round yields its race recap, its
    qualifying recap, its strategy commentary, and a sprint recap only when the
    weekend had a sprint.
    """
    earliest = today - datetime.timedelta(days=window_days)
    dated: list[tuple[int, bool]] = []
    for race in races or []:
        try:
            round_number = int(race["round"])
            race_date = datetime.date.fromisoformat(race["date"])
        except (KeyError, ValueError, TypeError):
            continue
        if earliest <= race_date < today:
            dated.append((round_number, "Sprint" in race))

    paths: list[str] = []
    for round_number, has_sprint in sorted(dated):
        recap = f"/api/session_recap?year={year}&round={round_number}&session="
        paths.append(recap + "race")
        paths.append(recap + "qualifying")
        if has_sprint:
            paths.append(recap + "sprint")
        paths.append(f"/api/strategy_commentary?year={year}&round={round_number}")
    return paths


def _label(path: str) -> str:
    query = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
    kind = query["session"][0] if "session" in query else "commentary"
    return f"R{query['round'][0]} {kind}"


def warm_ai_season(
    base: str,
    year: int,
    today: datetime.date | None = None,
    window_days: int = 30,
) -> list[str]:
    """Generate (or confirm) the AI text for `year`'s recent rounds.

    Returns the targets whose response was empty or failed, so the caller can
    report them. Empty means every one answered with text. Requests run one at
    a time: the model allows one concurrent call on this plan.
    """
    base = base.rstrip("/")
    try:
        calendar = _get_text(f"{base}/api/races?year={year}")
        if calendar is None:
            return []
        races = (json.loads(calendar) or {}).get("races") or []
        targets = ai_targets(races, year, today or datetime.date.today(), window_days)
        if not targets:
            print(f"ai warm: no rounds of {year} in the last {window_days} days")
            return []
        print(f"ai warm: {len(targets)} text(s) for {year} against {base}")

        missing: list[str] = []
        for path in targets:
            body = _get_text(base + path)
            present = bool(body and body.strip())
            print(f"  AI {_label(path)}: {'ok' if present else 'empty'}")
            if not present:
                missing.append(path)
        return missing
    except Exception as error:  # noqa: BLE001 - must never fail a sync
        print(f"ai warm failed for {year}: {error}")
        return []
