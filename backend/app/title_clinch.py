"""Whether a championship is mathematically decided, and since when.

Nothing on the site knew. With Antonelli 119 points clear and four Grands Prix
(100 points) left after the 2026 Mexico City GP, the home page still called him
"Championship leader", the catch-up narrative was forbidden from mentioning
the eventual champion, and the chat agent had no way to know. The standings
page did compute it, client-side, but counted a fastest-lap bonus point that
was abolished after 2024 (a 104-point ceiling instead of 100).

**The test is strict:** the title is decided once the leader's margin is
*greater than* every point still available to the runner-up. Equal is not
enough: a tie on points goes to countback, which this does not model, so it is
never called decided on a tie that countback might resolve either way.

Only the runner-up matters: whoever is second has the most points of anyone
chasing, so if they cannot catch the leader, nobody can.

**Remaining rounds are counted from the standings' own round**, not from the
clock. Counting by the clock gets one window badly wrong: after a race has
started, a clock-based count already treats it as run, while the standings
have not yet been updated with its points, so the runner-up's 25 points from
that race would be missing from both sides of the comparison and a live title
fight could be declared over. Callers pass the round the standings describe.

Points systems before 2010 are not modelled; `ceilings` returns None for them
and nothing is claimed.
"""

from __future__ import annotations

# The scoring table in force since 2010 (P1 25, P2 18).
RACE_WIN_POINTS = 25
RACE_SECOND_POINTS = 18

# +1 for fastest lap (top-ten finish required), 2019 to 2024 inclusive.
FASTEST_LAP_SEASONS = range(2019, 2025)


def ceilings(season: int, scope: str = "driver") -> tuple[int, int] | None:
    """`(per race, per sprint)` maximum a single driver/team can score, or None.

    A constructor's ceiling is its two cars first and second (plus the single
    fastest-lap point, generously assumed to be theirs).
    """
    if season < 2010:
        return None
    fastest_lap = 1 if season in FASTEST_LAP_SEASONS else 0
    if season >= 2022:
        sprint_win, sprint_second = 8, 7
    elif season == 2021:
        sprint_win, sprint_second = 3, 2
    else:
        sprint_win = sprint_second = 0
    if scope == "constructor":
        return RACE_WIN_POINTS + RACE_SECOND_POINTS + fastest_lap, sprint_win + sprint_second
    return RACE_WIN_POINTS + fastest_lap, sprint_win


def remaining_after(schedule: list[dict], standings_round: int) -> tuple[int, int]:
    """`(races, sprints)` scheduled after `standings_round`.

    A round counts as having a sprint when its schedule entry carries a
    `Sprint` block, as Ergast's schedule does.
    """
    races = sprints = 0
    for race in schedule or []:
        try:
            number = int(race.get("round"))
        except (TypeError, ValueError):
            continue
        if number > standings_round:
            races += 1
            if race.get("Sprint"):
                sprints += 1
    return races, sprints


def title_status(
    leader_points: float,
    runner_up_points: float,
    remaining_races: int,
    remaining_sprints: int,
    season: int,
    scope: str = "driver",
) -> dict | None:
    """The clinch arithmetic for one championship, or None when not modelled."""
    limits = ceilings(season, scope)
    if limits is None:
        return None
    per_race, per_sprint = limits
    available = remaining_races * per_race + remaining_sprints * per_sprint
    gap = leader_points - runner_up_points
    clinched = gap > available
    return {
        "clinched": clinched,
        "gap": _clean(gap),
        "points_available": available,
        "remaining_races": remaining_races,
        "remaining_sprints": remaining_sprints,
        # Lead the leader must add to be certain; 0 once decided.
        "points_to_clinch": 0 if clinched else _clean(available - gap + 1),
    }


def _clean(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value
