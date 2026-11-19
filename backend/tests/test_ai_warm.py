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


def test_window_includes_its_first_day_and_excludes_race_day_itself():
    # today - 30 days is 2026-10-20: in. A race dated today has not finished.
    races = [race(1, "2026-10-20"), race(2, "2026-11-19")]

    targets = ai_warm.ai_targets(races, 2026, TODAY, window_days=30)

    assert targets == paths_for(1)


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


def test_warm_never_raises(monkeypatch):
    def boom(url):
        raise RuntimeError("network on fire")

    monkeypatch.setattr(ai_warm, "_get_text", boom)

    assert ai_warm.warm_ai_season("http://backend.test", 2026, today=TODAY) == []
