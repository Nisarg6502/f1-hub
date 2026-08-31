import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_stints imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import openf1_sessions, race_stints


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, race_stints=None, race_date="2026-07-26"):
        self.race_stints = race_stints or FakeCollection()
        # The OpenF1 path looks a round's date up here before it can find a
        # session key; a None date means "no date on file" and skips OpenF1.
        self.races = FakeCollection({"date": race_date} if race_date else None)


def lap(driver, stint, lap_number, compound="SOFT", tyre_life=1):
    return {
        "DriverNumber": driver,
        "Stint": stint,
        "LapNumber": lap_number,
        "Compound": compound,
        "TyreLife": tyre_life,
    }


class StintsFromLapsTests(unittest.TestCase):
    def test_groups_laps_into_one_record_per_driver_stint(self):
        laps = [
            lap("1", 1, 1, "SOFT", 1),
            lap("1", 1, 2, "SOFT", 2),
            lap("1", 2, 3, "HARD", 1),
            lap("44", 1, 1, "MEDIUM", 3),
        ]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(len(stints), 3)
        self.assertEqual(stints[0], {
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 2,
            "compound": "SOFT",
            "tyre_age_at_start": 1,
        })
        self.assertEqual(stints[1]["compound"], "HARD")
        self.assertEqual(stints[2]["driver_number"], 44)

    def test_orders_by_driver_then_stint_regardless_of_lap_order(self):
        laps = [lap("44", 2, 30), lap("1", 1, 5), lap("44", 1, 1)]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(
            [(s["driver_number"], s["stint_number"]) for s in stints],
            [(1, 1), (44, 1), (44, 2)],
        )

    def test_tyre_age_comes_from_the_stints_earliest_lap_not_the_first_row(self):
        # FastF1 does not guarantee lap order within the frame.
        laps = [lap("1", 1, 12, "HARD", 9), lap("1", 1, 10, "HARD", 7)]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(stints[0]["tyre_age_at_start"], 7)
        self.assertEqual(stints[0]["lap_start"], 10)
        self.assertEqual(stints[0]["lap_end"], 12)

    def test_drops_rows_missing_a_driver_stint_or_lap_number(self):
        laps = [
            lap(None, 1, 1),
            lap("1", None, 1),
            lap("1", 1, None),
            lap("1", 1, 4),
        ]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(len(stints), 1)
        self.assertEqual(stints[0]["lap_start"], 4)

    def test_a_missing_compound_falls_back_to_unknown(self):
        stints = race_stints.stints_from_laps([lap("1", 1, 1, compound=None)])

        self.assertEqual(stints[0]["compound"], "UNKNOWN")

    def test_no_laps_yields_no_stints(self):
        self.assertEqual(race_stints.stints_from_laps([]), [])


def openf1_stint(driver, stint, lap_start, lap_end, compound="SOFT", age=0):
    """One row in the shape OpenF1's `/stints` endpoint actually returns."""
    return {
        "meeting_key": 1291,
        "session_key": 11342,
        "driver_number": driver,
        "stint_number": stint,
        "lap_start": lap_start,
        "lap_end": lap_end,
        "compound": compound,
        "tyre_age_at_start": age,
    }


class StintsFromOpenF1Tests(unittest.TestCase):
    def test_maps_rows_onto_the_same_document_shape_as_the_fastf1_path(self):
        rows = race_stints.stints_from_openf1([openf1_stint(1, 1, 1, 17, "MEDIUM", 0)])

        # Exact key parity with `stints_from_laps` is the whole point: the
        # frontend must not be able to tell which source filled the cache.
        self.assertEqual(rows, [{
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 17,
            "compound": "MEDIUM",
            "tyre_age_at_start": 0,
        }])
        self.assertEqual(
            set(rows[0]),
            set(race_stints.stints_from_laps([lap("1", 1, 1)])[0]),
        )

    def test_orders_by_driver_then_stint(self):
        rows = race_stints.stints_from_openf1([
            openf1_stint(44, 2, 20, 40),
            openf1_stint(1, 1, 1, 19),
            openf1_stint(44, 1, 1, 19),
        ])

        self.assertEqual(
            [(r["driver_number"], r["stint_number"]) for r in rows],
            [(1, 1), (44, 1), (44, 2)],
        )

    def test_a_null_compound_falls_back_to_unknown(self):
        rows = race_stints.stints_from_openf1([openf1_stint(1, 1, 1, 5, compound=None)])

        self.assertEqual(rows[0]["compound"], "UNKNOWN")

    def test_a_null_tyre_age_falls_back_to_zero(self):
        rows = race_stints.stints_from_openf1([openf1_stint(1, 1, 1, 5, age=None)])

        self.assertEqual(rows[0]["tyre_age_at_start"], 0)

    def test_drops_rows_missing_any_of_the_four_numeric_fields(self):
        rows = race_stints.stints_from_openf1([
            openf1_stint(None, 1, 1, 5),
            openf1_stint(1, None, 1, 5),
            openf1_stint(1, 1, None, 5),
            openf1_stint(1, 1, 1, None),
            openf1_stint(1, 1, 1, 5),
        ])

        self.assertEqual(len(rows), 1)

    def test_a_lap_end_before_lap_start_is_clamped_to_a_single_lap_stint(self):
        # The chart derives a bar length from `lap_end - lap_start + 1`; a
        # negative length would render as a missing bar rather than an error.
        rows = race_stints.stints_from_openf1([openf1_stint(1, 3, 40, 39)])

        self.assertEqual(rows[0]["lap_start"], 40)
        self.assertEqual(rows[0]["lap_end"], 40)

    def test_no_rows_yields_no_stints(self):
        self.assertEqual(race_stints.stints_from_openf1([]), [])


class BuildRaceStintsOpenF1Tests(unittest.TestCase):
    """Two fetch seams, not one, since the session lookup moved out.

    `fetch_openf1_session_key` now lives in `openf1_sessions`, which has no
    scientific-stack imports — the transcription job cannot import fastf1
    without segfaulting CTranslate2 (see that module's docstring). So the
    sessions call goes through `openf1_sessions.fetch_json` and the stints call
    through `race_stints._fetch_json`, and a test that patches only one of them
    lets the other reach the real network.
    """

    def _patch_both(self, sessions_result, stints_result):
        session_calls, stint_calls = [], []

        def fake_sessions(url, params=None, timeout=20.0):
            session_calls.append((url, params))
            return sessions_result

        def fake_stints(url, params=None, timeout=20.0):
            stint_calls.append((url, params))
            return stints_result

        return (
            patch.object(openf1_sessions, "fetch_json", side_effect=fake_sessions),
            patch.object(race_stints, "_fetch_json", side_effect=fake_stints),
            session_calls,
            stint_calls,
        )

    def test_looks_up_the_session_by_date_then_fetches_its_stints(self):
        sessions, stints_patch, session_calls, stint_calls = self._patch_both(
            [
                {"session_key": 11334, "date_start": "2026-07-19T13:00:00+00:00"},
                {"session_key": 11342, "date_start": "2026-07-26T13:00:00+00:00"},
            ],
            [openf1_stint(1, 1, 1, 17)],
        )

        with sessions, stints_patch:
            stints = race_stints.build_race_stints_openf1("2026-07-26")

        self.assertEqual(session_calls[0][1], {"year": "2026", "session_type": "Race"})
        self.assertEqual(stint_calls[0][1], {"session_key": 11342})
        self.assertEqual(len(stints), 1)

    def test_a_date_with_no_matching_session_returns_none(self):
        sessions, stints_patch, _, stint_calls = self._patch_both(
            [{"session_key": 11342, "date_start": "2026-07-26T13:00:00+00:00"}], []
        )

        with sessions, stints_patch:
            self.assertIsNone(race_stints.build_race_stints_openf1("2026-08-23"))

        # And it gave up before asking for stints, rather than fetching
        # somebody else's session.
        self.assertEqual(stint_calls, [])

    def test_a_season_openf1_does_not_cover_returns_none(self):
        # OpenF1 404s (-> None from the fetch helper) for anything before 2023,
        # which is exactly what has to hand off to the FastF1 fallback.
        with patch.object(openf1_sessions, "fetch_json", return_value=None):
            self.assertIsNone(race_stints.build_race_stints_openf1("2018-07-26"))

    def test_an_empty_stint_feed_returns_none_rather_than_an_empty_list(self):
        # None/empty both have to read as "OpenF1 has nothing" so the caller
        # falls through to FastF1 instead of caching an empty document.
        sessions, stints_patch, _, _ = self._patch_both(
            [{"session_key": 11342, "date_start": "2026-07-26T13:00:00+00:00"}], []
        )

        with sessions, stints_patch:
            self.assertIsNone(race_stints.build_race_stints_openf1("2026-07-26"))

    def test_no_race_date_returns_none_without_calling_openf1(self):
        with patch.object(openf1_sessions, "fetch_json") as sessions_fetch, patch.object(
            race_stints, "_fetch_json"
        ) as stints_fetch:
            self.assertIsNone(race_stints.build_race_stints_openf1(""))

        sessions_fetch.assert_not_called()
        stints_fetch.assert_not_called()


class RaceStintsSourceOrderTests(unittest.TestCase):
    """OpenF1 is tried before FastF1, and the winner is recorded on the doc."""

    def test_openf1_is_tried_first_and_fastf1_is_never_reached_when_it_answers(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [openf1_stint(1, 1, 1, 17)]

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(
                 race_stints, "build_race_stints_openf1", return_value=built
             ) as openf1, \
             patch.object(race_stints, "build_race_stints") as fastf1_build:
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=11))

        openf1.assert_called_once_with("2026-07-26")
        fastf1_build.assert_not_called()
        self.assertTrue(json.loads(response.body)["synced"])
        self.assertEqual(fake_db.race_stints.update["update"]["$set"]["source"], "openf1")

    def test_falls_back_to_fastf1_and_marks_the_source_when_openf1_has_nothing(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 20,
            "compound": "SOFT",
            "tyre_age_at_start": 1,
        }]

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints_openf1", return_value=None), \
             patch.object(race_stints, "build_race_stints", return_value=built) as fastf1_build:
            asyncio.run(race_stints.get_race_stints(year=2026, round_number=11))

        fastf1_build.assert_called_once_with(2026, 11)
        self.assertEqual(fake_db.race_stints.update["update"]["$set"]["source"], "fastf1")

    def test_a_round_with_no_known_date_skips_openf1_and_uses_fastf1(self):
        # Nothing to look a session key up by, so the OpenF1 stage can't run
        # at all -- it must not block the FastF1 path that used to be the only one.
        fake_db = FakeDb(FakeCollection(None), race_date=None)

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints_openf1") as openf1, \
             patch.object(race_stints, "build_race_stints", return_value=None):
            response = asyncio.run(race_stints.get_race_stints(year=1998, round_number=3))

        openf1.assert_not_called()
        self.assertFalse(json.loads(response.body)["synced"])

    def test_a_cached_document_short_circuits_both_sources(self):
        cached = FakeCollection({"season": 2026, "round": "11", "stints": [openf1_stint(1, 1, 1, 5)]})

        with patch.object(race_stints, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_stints, "build_race_stints_openf1") as openf1, \
             patch.object(race_stints, "build_race_stints") as fastf1_build:
            asyncio.run(race_stints.get_race_stints(year=2026, round_number=11))

        openf1.assert_not_called()
        fastf1_build.assert_not_called()


class RaceStintsEndpointTests(unittest.TestCase):
    def test_serves_cached_stints_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "stints": [{
                "driver_number": 1,
                "stint_number": 1,
                "lap_start": 1,
                "lap_end": 20,
                "compound": "SOFT",
                "tyre_age_at_start": 0,
            }],
        })

        with patch.object(race_stints, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_stints, "build_race_stints_openf1", return_value=None), \
             patch.object(race_stints, "build_race_stints") as build:
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(len(body["stints"]), 1)

    def test_rebuilds_from_fastf1_on_a_miss_and_self_heals_the_cache(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 20,
            "compound": "SOFT",
            "tyre_age_at_start": 0,
        }]

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints_openf1", return_value=None), \
             patch.object(race_stints, "build_race_stints", return_value=built) as build:
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_called_once_with(2026, 3)
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["stints"], built)

        self.assertTrue(fake_db.race_stints.update["upsert"])
        written = fake_db.race_stints.update["update"]["$set"]
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["round"], "3")
        self.assertEqual(written["stints"], built)

    def test_an_unbuildable_round_reports_unsynced_rather_than_failing(self):
        # This is the Cloud Run case: livetiming 403s, so the rebuild returns
        # nothing and the frontend should say "not synced yet", not error.
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints_openf1", return_value=None), \
             patch.object(race_stints, "build_race_stints", return_value=None):
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertFalse(body["synced"])
        self.assertEqual(body["stints"], [])
        self.assertIsNone(fake_db.race_stints.update)

    def test_a_cached_doc_with_no_stints_triggers_a_rebuild(self):
        fake_db = FakeDb(FakeCollection({"season": 2026, "round": "3", "stints": []}))

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints_openf1", return_value=None), \
             patch.object(race_stints, "build_race_stints", return_value=None) as build:
            asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_called_once()


if __name__ == "__main__":
    unittest.main()
