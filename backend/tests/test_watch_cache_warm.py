"""watch_cache_warm: which rounds it warms, and that it never raises."""

import datetime

from app import watch_cache_warm as warm


def test_finished_rounds_takes_only_races_before_today(monkeypatch):
    races = {
        "races": [
            {"round": "2", "date": "2026-03-15"},
            {"round": "1", "date": "2026-03-08"},
            {"round": "3", "date": "2026-03-29"},  # today: not finished
            {"round": "4"},  # no date: skipped, not a crash
        ]
    }
    monkeypatch.setattr(warm, "_get", lambda url: (races, 0.1, False))
    assert warm.finished_rounds("http://x", 2026, datetime.date(2026, 3, 29)) == [1, 2]


def test_unsynced_round_skips_timing(monkeypatch):
    calls = []

    def fake_get(url):
        calls.append(url)
        return {"synced": False}, 0.1, False

    monkeypatch.setattr(warm, "_get", fake_get)
    assert "no replay yet" in warm.warm_round("http://x", 2026, 20)
    assert len(calls) == 1 and "race_replay" in calls[0]


def test_warm_season_reports_rounds_not_served_from_cache(monkeypatch):
    # Judged by the cache-hit header, not by speed: R1's slow hit is warm
    # (a distant build worker), R2's fast miss is cold (OpenF1 refused).
    def fake_get(url):
        if "round=2" in url and "race_timing" in url:
            return {"synced": True}, 1.2, False
        return {"synced": True}, 2.5, True

    monkeypatch.setattr(warm, "_get", fake_get)
    assert warm.warm_season("http://x/", 2026, [1, 2]) == ["R2 race_timing 1.2s"]


def test_warm_season_never_raises(monkeypatch):
    def boom(url):
        raise RuntimeError("network down")

    monkeypatch.setattr(warm, "_get", boom)
    assert warm.warm_season("http://x", 2026, [1]) == []
