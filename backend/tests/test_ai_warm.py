"""ai_warm: which AI texts the sync pre-generates, and that it never raises."""

import datetime
import json

from app import ai_warm

TODAY = datetime.date(2026, 11, 19)


def race(round_number, date, sprint=False):
    entry = {"round": str(round_number), "date": date, "raceName": f"Race {round_number}"}
    if sprint:
        entry["Sprint"] = {"date": date}
    return entry


def paths_for(round_number, year=2026, sprint=False):
    out = [
        f"/api/session_recap?year={year}&round={round_number}&session=race",
        f"/api/session_recap?year={year}&round={round_number}&session=qualifying",
    ]
    if sprint:
        out.append(f"/api/session_recap?year={year}&round={round_number}&session=sprint")
    out.append(f"/api/strategy_commentary?year={year}&round={round_number}")
    return out


def test_targets_include_sprint_only_on_sprint_weekends():
    races = [race(2, "2026-11-01", sprint=True), race(3, "2026-11-08")]

    targets = ai_warm.ai_targets(races, 2026, TODAY)

    assert targets == paths_for(2, sprint=True) + paths_for(3)
    assert len(targets) == 7


def test_targets_skip_future_and_out_of_window_rounds():
    races = [race(1, "2026-10-01"), race(2, "2026-11-22")]

    assert ai_warm.ai_targets(races, 2026, TODAY, window_days=30) == []


def test_window_runs_from_thirty_days_back_to_two_days_ahead():
    # Race day itself is in: its text should exist on race evening, and the job
    # runs in UTC, so waiting for the next date would lose up to a day. Two days
    # ahead is in too: qualifying and sprint recaps exist before the race.
    races = [
        race(1, "2026-10-19"),  # 31 days back: out
        race(2, "2026-10-20"),  # 30 days back: in
        race(3, "2026-11-19"),  # today: in
        race(4, "2026-11-21"),  # two days ahead: in
        race(5, "2026-11-22"),  # three days ahead: out
    ]

    targets = ai_warm.ai_targets(races, 2026, TODAY, window_days=30)

    assert targets == paths_for(2) + paths_for(3) + paths_for(4)


def test_targets_ignore_rows_with_no_usable_date_or_round():
    races = [{"round": "4"}, {"date": "2026-11-01"}, race("x", "2026-11-01"), race(5, "not-a-date")]

    assert ai_warm.ai_targets(races, 2026, TODAY) == []


def test_warm_reports_empty_bodies_as_missing(monkeypatch):
    calendar = json.dumps({"races": [race(3, "2026-11-08")]})

    def fake_get(url):
        if "/api/races" in url:
            return calendar
        if "session=race" in url:
            return "Recap text"
        return ""

    monkeypatch.setattr(ai_warm, "_get_text", fake_get)

    missing = ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY)

    assert missing == [
        "/api/session_recap?year=2026&round=3&session=qualifying",
        "/api/strategy_commentary?year=2026&round=3",
    ]


def test_warm_treats_a_failed_request_as_missing(monkeypatch):
    calendar = json.dumps({"races": [race(3, "2026-11-08")]})
    monkeypatch.setattr(ai_warm, "_get_text", lambda url: calendar if "/api/races" in url else None)

    missing = ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY)

    assert missing == paths_for(3)


def test_warm_returns_nothing_when_the_calendar_is_unavailable(monkeypatch):
    monkeypatch.setattr(ai_warm, "_get_text", lambda url: None)

    assert ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY) == []


def test_warm_requests_each_target_against_the_given_base(monkeypatch):
    calendar = json.dumps({"races": [race(3, "2026-11-08")]})
    seen = []

    def fake_get(url):
        seen.append(url)
        return calendar if "/api/races" in url else "text"

    monkeypatch.setattr(ai_warm, "_get_text", fake_get)

    ai_warm.warm_ai_season("http://backend.test/", 2026, today=TODAY)

    assert seen[0] == "http://backend.test/api/races?year=2026"
    assert seen[1:] == ["http://backend.test" + path for path in paths_for(3)]


def test_warm_stops_starting_new_texts_once_the_budget_is_spent(monkeypatch):
    """A slow or degraded model must not carry the sync past its task timeout."""
    calendar = json.dumps({"races": [race(3, "2026-11-08")]})
    clock = {"now": 0.0}
    fetched = []

    def fake_get(url):
        if "/api/races" in url:
            return calendar
        fetched.append(url)
        clock["now"] += 400  # every text takes 400s
        return "text"

    monkeypatch.setattr(ai_warm, "_get_text", fake_get)

    missing = ai_warm.warm_ai_season(
        "http://backend.test", 2026, today=TODAY, budget_s=600, clock=lambda: clock["now"]
    )

    # Two texts started (at 0s and 400s); the third would start at 800s > 600s.
    assert len(fetched) == 2
    assert missing == [paths_for(3)[2]]


def test_a_zero_budget_still_reads_the_calendar_but_generates_nothing(monkeypatch):
    calendar = json.dumps({"races": [race(3, "2026-11-08")]})
    fetched = []

    def fake_get(url):
        fetched.append(url)
        return calendar

    monkeypatch.setattr(ai_warm, "_get_text", fake_get)

    missing = ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY, budget_s=0)

    assert len(fetched) == 1
    assert missing == paths_for(3)


def test_ai_warm_days_falls_back_on_a_bad_value(monkeypatch):
    from app import data_sync

    monkeypatch.setenv("AI_WARM_DAYS", "banana")
    assert data_sync._ai_warm_days() == 30

    monkeypatch.setenv("AI_WARM_DAYS", "-5")
    assert data_sync._ai_warm_days() == 0

    monkeypatch.setenv("AI_WARM_DAYS", "7")
    assert data_sync._ai_warm_days() == 7

    monkeypatch.delenv("AI_WARM_DAYS")
    assert data_sync._ai_warm_days() == 30


def test_warm_never_raises(monkeypatch):
    def boom(url):
        raise RuntimeError("network on fire")

    monkeypatch.setattr(ai_warm, "_get_text", boom)

    assert ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY) == []
