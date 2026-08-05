"""Turn a vague reference into a concrete id, in Python, before any model runs.

"How did *he* do in the *last* race?" is taxonomy class 13 in
`CHAT-AGENT-PLAN.md` §2, and it is the cheapest hallucination class to close:
a model that is asked to guess a round number will guess one, and a wrong
round produces an answer that is fluent, cited and about the wrong Grand Prix.
Every resolution here is a lookup against this app's own calendar, roster and
clock — no inference, no model call, no network.

The module's actual contract is the *negative* one, and it is why this is a
separate module rather than a helper inside the router:

    **Ambiguity is reported, never guessed.**

"Kimi" is Räikkönen or Antonelli depending on the era. "Verstappen" is Max or
Jos. "the American GP" is three different rounds of a modern season. Each of
those returns `resolved=False` with the candidate list attached, so the caller
can ask the user or narrow by season. A resolver that silently picked the
first match would be worse than no resolver at all: it would convert an
answerable "which one do you mean?" into a confident wrong answer, which is
precisely the CP38 failure shape in a different costume.

Everything is derived from data rather than hardcoded wherever it can be.
Circuit aliases come out of the calendar itself — `raceName` ("Hungarian Grand
Prix"), `circuitName` ("Hungaroring"), locality ("Budapest") and country
("Hungary") between them cover the ways people name a race, so no demonym
table is needed and a new circuit resolves the day it is synced. Driver names
likewise come off the roster. Only genuine nicknames that are *not* derivable
from a name — "Checo", "Schumi", "the Hulk" — need a table, and even those are
filtered against the roster so a resolution can never name a driver who is not
actually in the season being asked about.

Pure functions, all of them. `agent/tools/context.py` is where Mongo is read
and these are called; keeping the two apart is what lets the whole resolution
surface be unit-tested with no database and no network.
"""

from __future__ import annotations

import datetime
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------

_PUNCTUATION_RE = re.compile(r"[^a-z0-9 ]+")
_WHITESPACE_RE = re.compile(r"\s+")

# Dropped before matching so "the Hungarian GP", "Hungarian Grand Prix" and
# "Hungary" all reduce to a comparable core. "gp" is included because it is how
# people actually write it and it never carries meaning on its own.
_RACE_STOPWORDS = frozenset({"grand", "prix", "gp", "the", "a", "an", "circuit", "of"})


def normalise(text: str | None) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace.

    Accent folding is not cosmetic: `Räikkönen`, `Perez`/`Pérez` and
    `Hülkenberg` are all typed both ways, and an exact-string matcher that did
    not fold them would report "no such driver" for a correctly spelled name.
    """
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    lowered = _PUNCTUATION_RE.sub(" ", stripped.lower())
    return _WHITESPACE_RE.sub(" ", lowered).strip()


def _tokens(text: str | None) -> list[str]:
    return [t for t in normalise(text).split(" ") if t]


def _race_core(text: str | None) -> str:
    """A race/circuit name reduced to its distinguishing words."""
    return " ".join(t for t in _tokens(text) if t not in _RACE_STOPWORDS)


# --------------------------------------------------------------------------
# result types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """One thing the hint could have meant.

    `detail` carries whatever disambiguates it for a human — a driver's team
    and season span, a circuit's country — because "did you mean Kimi
    Räikkönen or Kimi Antonelli?" is only a useful question if the caller can
    render the difference.
    """

    id: str
    label: str
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"id": self.id, "label": self.label, **self.detail}


@dataclass(frozen=True)
class Resolution:
    """The outcome of one resolution attempt.

    `resolved` false with candidates means ambiguous; false without means
    nothing matched. The two are different answers — "which Kimi?" versus "I
    have no driver by that name" — and collapsing them would make the caller
    guess which apology to write.
    """

    kind: str
    query: str
    resolved: bool = False
    value: Any = None
    candidates: tuple[Candidate, ...] = ()
    via: str | None = None
    reason: str | None = None

    @property
    def ambiguous(self) -> bool:
        return not self.resolved and len(self.candidates) > 1

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "query": self.query,
            "resolved": self.resolved,
            "value": self.value,
            "ambiguous": self.ambiguous,
            "candidates": [c.to_dict() for c in self.candidates],
            "via": self.via,
            "reason": self.reason,
        }


def _hit(kind: str, query: str, value: Any, via: str) -> Resolution:
    return Resolution(kind=kind, query=query, resolved=True, value=value, via=via)


def _ambiguous(kind: str, query: str, candidates: Iterable[Candidate], via: str) -> Resolution:
    options = tuple(candidates)
    return Resolution(
        kind=kind,
        query=query,
        candidates=options,
        via=via,
        reason=f"{len(options)} candidates match; ask which one rather than picking",
    )


def _miss(kind: str, query: str, reason: str, via: str | None = None) -> Resolution:
    return Resolution(kind=kind, query=query, via=via, reason=reason)


# --------------------------------------------------------------------------
# normalising the inputs this module resolves against
# --------------------------------------------------------------------------


def _as_int(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def normalise_calendar(race_docs: Iterable[dict]) -> list[dict]:
    """Flatten `races` documents into the one shape every resolver here reads.

    Ergast stores `round` as a string, so "10" sorts before "2" in Mongo — the
    same trap `races._round_key` exists to dodge. Coercing to int once here
    means no downstream comparison has to remember it.
    """
    calendar: list[dict] = []
    for doc in race_docs or []:
        season = _as_int(doc.get("season"))
        round_number = _as_int(doc.get("round"))
        if season is None or round_number is None:
            continue
        circuit = doc.get("Circuit") or {}
        location = circuit.get("Location") or {}
        calendar.append(
            {
                "season": season,
                "round": round_number,
                "race_name": doc.get("raceName") or "",
                "date": doc.get("date") or "",
                "circuit_id": circuit.get("circuitId") or "",
                "circuit_name": circuit.get("circuitName") or "",
                "locality": location.get("locality") or "",
                "country": location.get("country") or "",
            }
        )
    calendar.sort(key=lambda r: (r["season"], r["round"]))
    return calendar


def normalise_roster(rows: Iterable[dict]) -> list[dict]:
    """Flatten result/standings rows into a de-duplicated driver roster.

    Accepts either shape — a classification row (`{"Driver": {...},
    "Constructor": {...}}`) or a standings row (`{"Driver": {...},
    "Constructors": [...]}`) — because the caller reads whichever collection is
    populated for the season, and making it convert first would just move this
    branch somewhere less tested.
    """
    by_id: dict[str, dict] = {}
    for row in rows or []:
        driver = row.get("Driver") or {}
        driver_id = (driver.get("driverId") or "").strip()
        if not driver_id:
            continue
        constructors = row.get("Constructors") or []
        team = (row.get("Constructor") or {}).get("name") or (
            constructors[0].get("name") if constructors else None
        )
        entry = by_id.setdefault(
            driver_id,
            {
                "driver_id": driver_id,
                "given_name": driver.get("givenName") or "",
                "family_name": driver.get("familyName") or "",
                "code": (driver.get("code") or "").upper(),
                "number": driver.get("permanentNumber") or row.get("number") or "",
                "team": team,
            },
        )
        # A driver who changed teams mid-season appears twice; keep the first
        # team seen rather than flapping, and fill blanks from later rows.
        if not entry.get("team") and team:
            entry["team"] = team
    return list(by_id.values())


def circuits_from_calendar(calendar: Iterable[dict]) -> list[dict]:
    """Collapse a calendar into one entry per physical circuit.

    Race names are accumulated across seasons rather than overwritten: Miami
    has been the "Miami Grand Prix" throughout, but plenty of circuits have
    hosted differently-named races over the decades and a resolver that only
    knew the latest name would miss "the European Grand Prix".
    """
    circuits: dict[str, dict] = {}
    for race in calendar or []:
        circuit_id = race.get("circuit_id")
        if not circuit_id:
            continue
        entry = circuits.setdefault(
            circuit_id,
            {
                "circuit_id": circuit_id,
                "circuit_name": race.get("circuit_name") or "",
                "locality": race.get("locality") or "",
                "country": race.get("country") or "",
                "race_names": [],
                "seasons": [],
            },
        )
        name = race.get("race_name")
        if name and name not in entry["race_names"]:
            entry["race_names"].append(name)
        season = race.get("season")
        if season is not None and season not in entry["seasons"]:
            entry["seasons"].append(season)
    for entry in circuits.values():
        entry["seasons"].sort()
    return list(circuits.values())


# --------------------------------------------------------------------------
# the clock
# --------------------------------------------------------------------------


def today_utc() -> datetime.date:
    """The current UTC date.

    A separate function so every resolver takes the date as an argument and
    the whole module is deterministic under test. "The next race" that depends
    on a hidden `datetime.now()` is untestable and, worse, untestable in
    exactly the boundary cases (race day, season rollover) where it is wrong.
    """
    return datetime.datetime.now(datetime.timezone.utc).date()


def _race_date(race: dict) -> datetime.date | None:
    raw = (race.get("date") or "")[:10]
    try:
        return datetime.date.fromisoformat(raw)
    except ValueError:
        return None


def current_season(calendar: Iterable[dict], today: datetime.date) -> int | None:
    """Which season "this season" means, from the calendar and the date.

    Not simply `today.year`: the calendar is the authority on what has been
    synced, and between the last race of one year and the first of the next
    "this season" still sensibly means the year that just finished if the new
    one is not in the calendar yet.
    """
    seasons = sorted({r["season"] for r in calendar or []})
    if not seasons:
        return None
    if today.year in seasons:
        return today.year
    past = [s for s in seasons if s <= today.year]
    return past[-1] if past else seasons[0]


def season_state(calendar: Iterable[dict], today: datetime.date) -> dict:
    """A compact "where are we in the season" bundle for the clock tool.

    Models do not know today's date (§5.3), and injecting it as a bare
    timestamp is not enough — "the next race" needs the calendar beside it.
    """
    races = list(calendar or [])
    season = current_season(races, today)
    in_season = [r for r in races if r["season"] == season]
    run = [r for r in in_season if (_race_date(r) or datetime.date.max) <= today]
    return {
        "today": today.isoformat(),
        "season": season,
        "rounds_scheduled": len(in_season),
        "rounds_completed": len(run),
        "last_race": _race_summary(run[-1]) if run else None,
        "next_race": _race_summary(_next_race(races, today)),
    }


def _race_summary(race: dict | None) -> dict | None:
    if not race:
        return None
    return {
        "season": race["season"],
        "round": race["round"],
        "race_name": race.get("race_name"),
        "date": race.get("date"),
        "circuit_id": race.get("circuit_id"),
        "circuit_name": race.get("circuit_name"),
    }


def _last_race(calendar: Iterable[dict], today: datetime.date) -> dict | None:
    run = [r for r in calendar or [] if (_race_date(r) or datetime.date.max) <= today]
    return run[-1] if run else None


def _next_race(calendar: Iterable[dict], today: datetime.date) -> dict | None:
    upcoming = [r for r in calendar or [] if (_race_date(r) or datetime.date.min) > today]
    return upcoming[0] if upcoming else None


# --------------------------------------------------------------------------
# season
# --------------------------------------------------------------------------

_YEAR_RE = re.compile(r"\b(19[5-9]\d|20\d\d)\b")

_THIS_SEASON_RE = re.compile(r"\b(this|current)\s+(season|year|championship)\b")
_LAST_SEASON_RE = re.compile(r"\b(last|previous)\s+(season|year)\b")
_NEXT_SEASON_RE = re.compile(r"\bnext\s+(season|year)\b")


def resolve_season(
    text: str, *, calendar: Iterable[dict], today: datetime.date | None = None
) -> Resolution:
    """A concrete season year from a phrase, or an honest miss.

    An explicit year wins over a relative phrase: "how did he do last year in
    2021" is a question about 2021, and preferring the phrase would answer a
    different one.
    """
    today = today or today_utc()
    query = text or ""
    calendar = list(calendar or [])

    years = _YEAR_RE.findall(query)
    if len(set(years)) > 1:
        return _ambiguous(
            "season",
            query,
            (Candidate(id=y, label=y) for y in sorted(set(years))),
            "explicit_year",
        )
    if years:
        return _hit("season", query, int(years[0]), "explicit_year")

    current = current_season(calendar, today)
    if current is None:
        return _miss("season", query, "no calendar is synced, so 'this season' has no value")

    lowered = normalise(query)
    if _THIS_SEASON_RE.search(lowered):
        return _hit("season", query, current, "phrase:this_season")
    if _LAST_SEASON_RE.search(lowered):
        return _hit("season", query, current - 1, "phrase:last_season")
    if _NEXT_SEASON_RE.search(lowered):
        return _hit("season", query, current + 1, "phrase:next_season")

    return _miss("season", query, "no season referenced")


# --------------------------------------------------------------------------
# race / round
# --------------------------------------------------------------------------

_LAST_RACE_RE = re.compile(
    r"\b(last|latest|previous|most recent)\s+(race|round|gp|grand prix|weekend)\b"
)
_NEXT_RACE_RE = re.compile(r"\b(next|upcoming|coming)\s+(race|round|gp|grand prix|weekend)\b")
_THIS_WEEKEND_RE = re.compile(r"\bthis\s+(weekend|week)\b")
_ROUND_RE = re.compile(r"\bround\s+(\d{1,2})\b")

# How far either side of today a race can sit and still be "this weekend".
# Three days forward covers a Friday question about Sunday's race; two back
# covers a Monday post-mortem. Wider than that and "this weekend" would start
# resolving to a race a week away, which is a guess rather than a resolution.
WEEKEND_WINDOW_BACK = datetime.timedelta(days=2)
WEEKEND_WINDOW_FORWARD = datetime.timedelta(days=3)


def resolve_race(
    text: str,
    *,
    calendar: Iterable[dict],
    today: datetime.date | None = None,
    season: int | None = None,
) -> Resolution:
    """A concrete `(season, round)` from a phrase, or an honest miss.

    Handles the three phrases the taxonomy actually turns on — "the last
    race", "the next race", "this weekend" — plus an explicit round number and
    a circuit name. A circuit named without a season is scoped by `season` if
    the caller resolved one, and otherwise resolves to that circuit's most
    recent running rather than reporting every year it has ever been raced:
    "who won at Monza" is a question about the latest Monza, and the seasons
    are returned on the resolution so a caller can see what was assumed.
    """
    today = today or today_utc()
    query = text or ""
    calendar = list(calendar or [])
    if not calendar:
        return _miss("race", query, "no calendar is synced")

    lowered = normalise(query)

    if _LAST_RACE_RE.search(lowered):
        race = _last_race(calendar, today)
        if race is None:
            return _miss(
                "race",
                query,
                "no race in the synced calendar has been run yet",
                "phrase:last_race",
            )
        return _hit("race", query, _race_summary(race), "phrase:last_race")

    if _NEXT_RACE_RE.search(lowered):
        race = _next_race(calendar, today)
        if race is None:
            return _miss(
                "race",
                query,
                "the synced calendar has no race after today; the season may be over",
                "phrase:next_race",
            )
        return _hit("race", query, _race_summary(race), "phrase:next_race")

    if _THIS_WEEKEND_RE.search(lowered):
        window = [
            r
            for r in calendar
            if (date := _race_date(r))
            and today - WEEKEND_WINDOW_BACK <= date <= today + WEEKEND_WINDOW_FORWARD
        ]
        if not window:
            return _miss(
                "race",
                query,
                "there is no race within a few days of today",
                "phrase:this_weekend",
            )
        if len(window) > 1:  # pragma: no cover - the calendar never doubles up
            return _ambiguous(
                "race",
                query,
                (
                    Candidate(id=f"{r['season']}-{r['round']}", label=r["race_name"])
                    for r in window
                ),
                "phrase:this_weekend",
            )
        return _hit("race", query, _race_summary(window[0]), "phrase:this_weekend")

    season_hint = resolve_season(query, calendar=calendar, today=today)
    year = season_hint.value if season_hint.resolved else season

    round_match = _ROUND_RE.search(lowered)
    if round_match:
        wanted = int(round_match.group(1))
        target_year = year if year is not None else current_season(calendar, today)
        race = next(
            (
                r
                for r in calendar
                if r["season"] == target_year and r["round"] == wanted
            ),
            None,
        )
        if race is None:
            return _miss(
                "race",
                query,
                f"round {wanted} is not in the {target_year} calendar",
                "explicit_round",
            )
        return _hit("race", query, _race_summary(race), "explicit_round")

    circuit = resolve_circuit(query, circuits=circuits_from_calendar(calendar))
    if circuit.ambiguous:
        return Resolution(
            kind="race",
            query=query,
            candidates=circuit.candidates,
            via="circuit",
            reason=circuit.reason,
        )
    if not circuit.resolved:
        return _miss("race", query, "no race, round or circuit referenced")

    runs = [r for r in calendar if r["circuit_id"] == circuit.value]
    if year is not None:
        runs = [r for r in runs if r["season"] == year]
        if not runs:
            return _miss(
                "race",
                query,
                f"{circuit.value} does not appear in the {year} calendar",
                "circuit",
            )
    race = runs[-1]
    return _hit("race", query, _race_summary(race), "circuit")


# --------------------------------------------------------------------------
# drivers
# --------------------------------------------------------------------------

# Only names that are NOT derivable from a driver's own given/family name.
# Anything a roster lookup already catches ("Lewis", "Leclerc", "VER") is
# deliberately absent — duplicating it here would create a second place to keep
# current and a first place to get wrong.
#
# Values are tuples because a nickname can be genuinely shared. "Kimi" is the
# canonical example and the reason this module exists: it means Räikkönen in
# 2007 and Antonelli in 2026, and every entry is filtered against the roster
# before it is used, so it is only ambiguous when both are actually present.
DRIVER_NICKNAMES: dict[str, tuple[str, ...]] = {
    "checo": ("perez",),
    "mad max": ("max_verstappen",),
    "supermax": ("max_verstappen",),
    "super max": ("max_verstappen",),
    "kimi": ("raikkonen", "kimi_antonelli"),
    "the hulk": ("hulkenberg",),
    "hulk": ("hulkenberg",),
    "seb": ("vettel",),
    "nando": ("alonso",),
    "danny ric": ("ricciardo",),
    "the honey badger": ("ricciardo",),
    "schumi": ("michael_schumacher", "mick_schumacher"),
    "magnussen": ("kevin_magnussen", "jan_magnussen"),
    "britney": ("bottas",),
    "the professor": ("prost",),
    "il leone": ("nuvolari",),
    "mr saturday": ("hulkenberg",),
}


def _driver_candidate(entry: dict) -> Candidate:
    name = f"{entry.get('given_name', '')} {entry.get('family_name', '')}".strip()
    return Candidate(
        id=entry["driver_id"],
        label=name or entry["driver_id"],
        detail={"team": entry.get("team"), "code": entry.get("code") or None},
    )


def _driver_result(query: str, matches: list[dict], via: str) -> Resolution | None:
    """One match resolves, several are reported, none falls through to the next rule."""
    if len(matches) == 1:
        return _hit("driver", query, matches[0]["driver_id"], via)
    if len(matches) > 1:
        return _ambiguous("driver", query, (_driver_candidate(m) for m in matches), via)
    return None


# A pronoun is not ambiguous between two drivers — it is a reference this
# module cannot see, because it lives in the conversation rather than the data.
# Saying so is the honest answer; picking the roster's first driver would not be.
_PRONOUN_RE = re.compile(r"^(he|him|his|she|her|hers|they|them|their|it)$")

# Words that appear in questions and never in a name or a circuit alias.
# Skipped when scanning a sentence for an n-gram, so a stray "at"/"in"/"do"
# cannot be tried as a driver code or a circuit name in the first place.
_HINT_STOP_TOKENS = frozenset(
    {
        "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "by",
        "was", "is", "are", "were", "did", "do", "does", "how", "who", "what",
        "when", "where", "why", "which", "that", "this", "there", "here",
        "race", "races", "round", "gp", "grand", "prix", "season", "year",
        "win", "won", "wins", "winner", "last", "next", "latest", "previous",
        "most", "recent", "upcoming", "weekend", "week", "get", "got", "go",
        "his", "her", "their", "its", "he", "she", "they", "it", "him", "them",
        "me", "my", "you", "your", "us", "our", "about", "with", "from", "up",
        "out", "over", "after", "before", "during", "than", "then", "so",
    }
)


def _ngrams(needle: str, max_size: int = 3) -> list[str]:
    """Word windows of a hint, longest first.

    Longest-first matters: "Kimi Antonelli" must be tried as a full name before
    "Kimi" is tried as a nickname, or an unambiguous question would be reported
    as ambiguous.
    """
    tokens = [t for t in needle.split(" ") if t]
    grams: list[str] = []
    for size in range(min(max_size, len(tokens)), 0, -1):
        for start in range(len(tokens) - size + 1):
            window = tokens[start : start + size]
            if size == 1 and window[0] in _HINT_STOP_TOKENS:
                continue
            grams.append(" ".join(window))
    return grams


def _match_driver(
    needle: str, roster: list[dict], query: str, *, allow_partial: bool
) -> Resolution | None:
    """Try every identification rule against one candidate string.

    Rules are ordered most-specific first and **stop at the first rule that
    matches anything at all**, including when it matches several. Falling
    through from an ambiguous rule to a looser one would let a sloppier match
    silently break a genuine tie.

    The id and family-name rules are deliberately merged into one stage. Most
    Ergast driver ids *are* a surname (`norris`, `hamilton`), so keeping them
    as separate stages meant "Verstappen" resolved to Jos — whose id happens to
    be exactly `verstappen` — instead of reporting the tie with Max. Unioning
    them makes the two Verstappens ambiguous while leaving `max_verstappen`
    (which no family name matches) unambiguous.
    """
    # Held rather than returned. A nickname that matches nobody in this roster
    # must **fall through** to the name rules, because several nicknames are
    # also real given names: "Kimi" is a nickname keyed to Räikkönen and
    # Antonelli, and a roster storing Antonelli under a different driver_id
    # would otherwise report "known nickname, nobody here" for a driver whose
    # first name is literally Kimi. The miss is kept as the answer of last
    # resort, so "Schumi" against a modern grid still says something useful.
    nickname_miss: Resolution | None = None
    nickname_ids = DRIVER_NICKNAMES.get(needle)
    if nickname_ids:
        matches = [d for d in roster if d["driver_id"] in nickname_ids]
        result = _driver_result(query, matches, "nickname")
        if result:
            return result
        nickname_miss = _miss(
            "driver",
            query,
            f"'{needle}' is a known nickname but nobody it refers to is in this roster",
            "nickname",
        )

    # The three-letter TV code. Length-gated so a surname that happens to be
    # three letters ("Ito") is not read as a code.
    if len(needle) == 3:
        by_code = [d for d in roster if normalise(d.get("code")) == needle]
        result = _driver_result(query, by_code, "code")
        if result:
            return result

    full = [
        d
        for d in roster
        if normalise(f"{d.get('given_name', '')} {d.get('family_name', '')}") == needle
    ]
    result = _driver_result(query, full, "full_name")
    if result:
        return result

    by_name = [
        d
        for d in roster
        if normalise(d["driver_id"]) == needle or normalise(d.get("family_name")) == needle
    ]
    result = _driver_result(query, by_name, "family_name")
    if result:
        return result

    by_given = [d for d in roster if normalise(d.get("given_name")) == needle]
    result = _driver_result(query, by_given, "given_name")
    if result:
        return result

    # Last resort, and only on the whole hint. A fragment tried against every
    # window of a sentence would match noise — "an" is a substring of
    # "kimi antonelli" — so this is length-gated and never used on an n-gram.
    if allow_partial and len(needle) >= 4:
        partial = [
            d
            for d in roster
            if needle in normalise(f"{d.get('given_name', '')} {d.get('family_name', '')}")
        ]
        result = _driver_result(query, partial, "partial_name")
        if result:
            return result

    return nickname_miss


def resolve_driver(text: str, *, roster: Iterable[dict]) -> Resolution:
    """A canonical `driver_id` from a name, surname, code or nickname.

    Hints arrive as whole questions ("how did Max do in the last race"), not as
    bare names, so the whole hint is tried first and the sentence is then
    scanned window by window. Longest windows go first — see `_ngrams`.
    """
    query = text or ""
    roster = list(roster or [])
    needle = normalise(query)
    if not needle:
        return _miss("driver", query, "no driver referenced")
    if not roster:
        return _miss("driver", query, "no driver roster is synced")

    tokens = needle.split(" ")
    if _PRONOUN_RE.match(needle):
        return _miss(
            "driver",
            query,
            "a pronoun refers to something earlier in the conversation, which "
            "this resolver cannot see — resolve it from thread memory first",
            "pronoun",
        )

    result = _match_driver(needle, roster, query, allow_partial=True)
    if result:
        return result

    if len(tokens) > 1:
        for gram in _ngrams(needle):
            result = _match_driver(gram, roster, query, allow_partial=False)
            if result:
                return result

    # Nothing named a driver, but something referred to one. Reported as a
    # pronoun rather than as "no such driver", because the two need different
    # responses: one asks the caller to look at thread memory, the other says
    # the name is wrong.
    if any(_PRONOUN_RE.match(token) for token in tokens):
        return _miss(
            "driver",
            query,
            "a pronoun refers to something earlier in the conversation, which "
            "this resolver cannot see — resolve it from thread memory first",
            "pronoun",
        )

    return _miss("driver", query, f"no driver in this roster matches '{query.strip()}'")


# --------------------------------------------------------------------------
# circuits
# --------------------------------------------------------------------------


def _circuit_aliases(circuit: dict) -> set[str]:
    """Every string this circuit can legitimately be called.

    Derived rather than curated — see the module docstring. `_race_core`
    reduces "Hungarian Grand Prix" to "hungarian", which is what makes "the
    Hungarian GP" and "Hungarian Grand Prix" the same key without a table.
    """
    aliases = {
        normalise(circuit.get("circuit_id")),
        normalise(circuit.get("circuit_name")),
        _race_core(circuit.get("circuit_name")),
        normalise(circuit.get("locality")),
        normalise(circuit.get("country")),
    }
    for name in circuit.get("race_names") or []:
        aliases.add(normalise(name))
        aliases.add(_race_core(name))
    aliases.discard("")
    return aliases


def _circuit_candidate(circuit: dict) -> Candidate:
    return Candidate(
        id=circuit["circuit_id"],
        label=circuit.get("circuit_name") or circuit["circuit_id"],
        detail={
            "country": circuit.get("country") or None,
            "locality": circuit.get("locality") or None,
            "seasons": circuit.get("seasons") or [],
        },
    )


def resolve_circuit(text: str, *, circuits: Iterable[dict]) -> Resolution:
    """A canonical `circuit_id` from a circuit, city, country or GP name.

    The ambiguity this exists for is geographic: "the American GP" is Miami,
    Austin and Las Vegas in a modern season, and "Emilia-Romagna" and "San
    Marino" are both Italy. Those return every candidate rather than the first.
    """
    query = text or ""
    circuits = list(circuits or [])
    needle = normalise(query)
    if not needle:
        return _miss("circuit", query, "no circuit referenced")
    if not circuits:
        return _miss("circuit", query, "no calendar is synced")

    aliases = [(c, _circuit_aliases(c)) for c in circuits]

    def _decide(matched: list[dict], via: str) -> Resolution | None:
        if len(matched) == 1:
            return _hit("circuit", query, matched[0]["circuit_id"], via)
        if len(matched) > 1:
            return _ambiguous(
                "circuit", query, (_circuit_candidate(c) for c in matched), via
            )
        return None

    # Exact alias, on the whole hint and then on its stopword-stripped core.
    for candidate, via in ((needle, "alias"), (_race_core(query), "alias_core")):
        if not candidate:
            continue
        result = _decide([c for c, a in aliases if candidate in a], via)
        if result:
            return result

    # Then window by window, because hints arrive as questions rather than as
    # bare names: "who won the Hungarian GP" has to find "hungarian" inside it.
    for gram in _ngrams(needle):
        result = _decide([c for c, a in aliases if gram in a], "alias_ngram")
        if result:
            return result

    # Substring, last, and only on the hint's own core. "Francorchamps" against
    # "Circuit de Spa-Francorchamps" needs it. Applied to sentence windows it
    # would match noise, so it deliberately is not.
    core = _race_core(query)
    if core and len(core) >= 4:
        result = _decide(
            [c for c, a in aliases if any(core in alias for alias in a)], "partial"
        )
        if result:
            return result

    return _miss("circuit", query, f"no circuit matches '{query.strip()}'")


# --------------------------------------------------------------------------
# the whole hint at once
# --------------------------------------------------------------------------


def resolve(
    text: str,
    *,
    calendar: Iterable[dict],
    roster: Iterable[dict] = (),
    circuits: Iterable[dict] | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Resolve every kind of reference in one hint.

    Returns one `Resolution` per kind rather than a single winner: a question
    routinely carries several ("how did Max do in the last race?"), and the
    router needs all of them. `ambiguous` at the top level is the one flag the
    caller must branch on — it is true if *any* kind came back with a tie,
    which is the signal to ask a clarifying question instead of calling a tool
    with a guessed argument.
    """
    today = today or today_utc()
    calendar = list(calendar or [])
    circuit_list = list(circuits) if circuits is not None else circuits_from_calendar(calendar)

    season = resolve_season(text, calendar=calendar, today=today)
    race = resolve_race(
        text,
        calendar=calendar,
        today=today,
        season=season.value if season.resolved else None,
    )
    driver = resolve_driver(text, roster=roster)
    circuit = resolve_circuit(text, circuits=circuit_list)

    # A resolved race is a stronger statement about the season than a phrase
    # is: "the last race" pins a year even when nothing in the text named one.
    if race.resolved and not season.resolved:
        season = _hit("season", text or "", race.value["season"], "from_race")

    resolutions = {
        "season": season,
        "race": race,
        "driver": driver,
        "circuit": circuit,
    }
    return {
        "today": today.isoformat(),
        "ambiguous": any(r.ambiguous for r in resolutions.values()),
        **{kind: resolution.to_dict() for kind, resolution in resolutions.items()},
    }
