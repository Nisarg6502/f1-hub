import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_radio imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_radio
from app.race_radio import lap_boundaries, place_clips, resolve_lap, sort_clips, to_wire

RACE_START = "2026-08-23T13:00:00+00:00"


def clip(date, driver=63, **extra):
    return {
        "id": f"11353-{driver}-x",
        "driver_number": driver,
        "date": date,
        "url": "https://livetiming.formula1.com/a.mp3",
        "duration_s": 9.0,
        **extra,
    }


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.queries = []

    async def find_one(self, query, projection=None):
        self.queries.append({"query": query, "projection": projection})
        return self.doc


class FakeDb:
    def __init__(self, race_radio=None):
        self.race_radio = race_radio or FakeCollection()


def run(coroutine):
    return asyncio.run(coroutine)


def body(response):
    return json.loads(response.body)


class PlacementTests(unittest.TestCase):
    def test_a_clip_becomes_elapsed_milliseconds_against_the_anchor(self):
        placed = place_clips([clip("2026-08-23T13:34:31.961000+00:00")], RACE_START)

        self.assertEqual(placed[0]["t_ms"], 2071961)

    def test_a_clip_before_lights_out_keeps_a_negative_t_ms_rather_than_vanishing(self):
        """F1 publishes grid-walk radio, and it is real radio.

        `race_timing` drops pre-race samples because a phantom position shuffle
        is worse than a missing one. A caption is not a position — the Pitwall
        module still lists these — so they survive with a negative `t_ms` that
        watch mode simply never reaches.
        """
        placed = place_clips([clip("2026-08-23T12:50:00+00:00")], RACE_START)

        self.assertEqual(len(placed), 1)
        self.assertLess(placed[0]["t_ms"], 0)

    def test_no_anchor_leaves_every_clip_unplaced_but_present(self):
        placed = place_clips([clip("2026-08-23T13:34:31+00:00")], None)

        self.assertEqual(len(placed), 1)
        self.assertIsNone(placed[0]["t_ms"])

    def test_an_unparseable_date_does_not_abort_the_session(self):
        placed = place_clips([clip("not a timestamp"), clip("2026-08-23T13:10:00+00:00")], RACE_START)

        self.assertEqual(len(placed), 2)
        self.assertIsNone(placed[0]["t_ms"] if placed[0]["date"] == "not a timestamp" else None)

    def test_a_datetime_anchor_is_accepted_as_well_as_a_string(self):
        import datetime

        anchor = datetime.datetime.fromisoformat(RACE_START)

        placed = place_clips([clip("2026-08-23T13:00:10+00:00")], anchor)

        self.assertEqual(placed[0]["t_ms"], 10000)


class LapResolutionTests(unittest.TestCase):
    # DURATIONS, not elapsed instants — three 90-second laps, so the crossings
    # are at 90s, 180s and 270s. Reading this array as instants is a silent
    # failure that resolves every clip to the final lap; see `lap_boundaries`.
    LAP_MS = [90000, 90000, 90000]

    def test_lap_durations_accumulate_into_crossing_times(self):
        self.assertEqual(lap_boundaries(self.LAP_MS), [90000, 180000, 270000])

    def test_a_null_lap_duration_does_not_break_the_running_total(self):
        self.assertEqual(lap_boundaries([90000, None, 90000]), [90000, 90000, 180000])

    def test_a_clip_early_in_the_race_does_not_resolve_to_the_final_lap(self):
        """The regression this array's shape actually caused.

        Measured on the 2026 Dutch GP: a clip 3 minutes in reported lap 72 of 72,
        because every per-lap duration is smaller than any mid-race timestamp.
        """
        self.assertEqual(resolve_lap(188669, [84177, 123197, 1701681, 198679, 145053]), 2)

    def test_a_clip_inside_a_lap_resolves_to_that_lap(self):
        self.assertEqual(resolve_lap(120000, self.LAP_MS), 2)

    def test_the_first_lap_is_lap_one_not_lap_zero(self):
        self.assertEqual(resolve_lap(1000, self.LAP_MS), 1)

    def test_radio_after_the_flag_belongs_to_the_final_lap(self):
        """There is a lot of post-chequered-flag radio, and it is often the best."""
        self.assertEqual(resolve_lap(999999, self.LAP_MS), 3)

    def test_no_lap_array_yields_no_lap_rather_than_an_estimate(self):
        self.assertIsNone(resolve_lap(120000, []))
        self.assertIsNone(resolve_lap(120000, None))

    def test_an_unplaced_clip_gets_no_lap(self):
        self.assertIsNone(resolve_lap(None, self.LAP_MS))

    def test_a_negative_t_ms_gets_no_lap_chip(self):
        placed = place_clips([clip("2026-08-23T12:50:00+00:00")], RACE_START, self.LAP_MS)

        self.assertNotIn("lap", placed[0])


class SprintAnchorTests(unittest.TestCase):
    """A sprint must not be placed against the race's lights-out.

    `race_timing` is race-only, so a lookup keyed on the round alone hands a
    sprint the anchor of a session held the day before. Measured on the 2026
    Dutch GP sprint before the fix: every clip landed at about minus 27 hours.
    Watch mode hid them (it drops negative times), but the Pitwall module
    labelled real sprint radio "Before lights out" — true of the wrong session.
    """

    def test_the_job_refuses_to_hand_a_sprint_the_races_anchor(self):
        from scripts.sync_race_radio import _anchor_for

        class Timing:
            def find_one(self, *args, **kwargs):
                return {"race_start": RACE_START, "lap_ms": [90000]}

        class Db:
            race_timing = Timing()

        self.assertEqual(_anchor_for(Db(), 2026, 12, "race"), (RACE_START, [90000]))
        self.assertEqual(_anchor_for(Db(), 2026, 12, "sprint"), (None, []))

    def test_an_unanchored_session_keeps_its_clips(self):
        """Unplaced is a degraded session, not a hidden one."""
        placed = place_clips([clip("2026-08-22T12:00:00+00:00")], None)

        self.assertEqual(len(placed), 1)
        self.assertIsNone(placed[0]["t_ms"])
        self.assertNotIn("lap", placed[0])


class OrderingTests(unittest.TestCase):
    def test_clips_sort_by_elapsed_time_with_nulls_last(self):
        clips = [
            {"t_ms": None, "date": "2026-08-23T13:00:00+00:00"},
            {"t_ms": 5000, "date": "2026-08-23T13:00:05+00:00"},
            {"t_ms": 1000, "date": "2026-08-23T13:00:01+00:00"},
        ]

        ordered = sort_clips(clips)

        self.assertEqual([c["t_ms"] for c in ordered], [1000, 5000, None])

    def test_unplaced_clips_keep_a_stable_chronological_order(self):
        clips = [
            {"t_ms": None, "date": "2026-08-23T14:00:00+00:00"},
            {"t_ms": None, "date": "2026-08-23T13:00:00+00:00"},
        ]

        ordered = sort_clips(clips)

        self.assertEqual(ordered[0]["date"], "2026-08-23T13:00:00+00:00")


class WireShapeTests(unittest.TestCase):
    def test_the_masked_text_is_served_and_the_raw_text_is_not(self):
        stored = clip(
            "2026-08-23T13:10:00+00:00",
            t_ms=600000,
            transcript={
                "engine": "groq/whisper-large-v3-turbo",
                "utterances": [
                    {
                        "speaker": "driver",
                        "text_raw": "fucking hell",
                        "text_masked": "*** hell",
                        "start": 0.0,
                        "end": 1.2,
                        "confidence": 0.9,
                    }
                ],
            },
            flags={"strong_language": True},
        )

        wire = to_wire(stored)

        self.assertEqual(wire["utterances"][0]["text"], "*** hell")
        self.assertTrue(wire["strong_language"])
        self.assertNotIn("text_raw", json.dumps(wire))

    def test_a_clip_with_no_transcript_still_serves_as_a_playable_clip(self):
        wire = to_wire(clip("2026-08-23T13:10:00+00:00", t_ms=600000))

        self.assertEqual(wire["utterances"], [])
        self.assertEqual(wire["duration_s"], 9.0)
        self.assertFalse(wire["strong_language"])

    def test_an_utterance_with_no_masked_text_is_dropped_not_served_empty(self):
        stored = clip(
            "2026-08-23T13:10:00+00:00",
            transcript={"utterances": [{"speaker": "pit", "text_raw": "x", "text_masked": ""}]},
        )

        self.assertEqual(to_wire(stored)["utterances"], [])

    def test_a_missing_speaker_serves_as_unknown_rather_than_null(self):
        stored = clip(
            "2026-08-23T13:10:00+00:00",
            transcript={"utterances": [{"text_masked": "copy that"}]},
        )

        self.assertEqual(to_wire(stored)["utterances"][0]["speaker"], "unknown")

    def test_the_driver_number_is_a_string_to_match_every_other_payload(self):
        """`ReplayDriver` and the timing tower both key drivers by string."""
        self.assertEqual(to_wire(clip("2026-08-23T13:10:00+00:00", driver=63))["driver_number"], "63")


class EndpointTests(unittest.TestCase):
    def test_the_query_excludes_raw_text_at_the_database_boundary(self):
        collection = FakeCollection(doc={"clips": [], "synced": True, "source": None})

        with patch.object(race_radio, "get_db", return_value=FakeDb(collection)):
            run(race_radio.get_race_radio(year=2026, round_number=15, session="race"))

        projection = collection.queries[0]["projection"]
        self.assertEqual(projection.get("clips.transcript.utterances.text_raw"), 0)

    def test_an_unprocessed_session_reports_not_synced(self):
        with patch.object(race_radio, "get_db", return_value=FakeDb(FakeCollection(doc=None))):
            response = run(race_radio.get_race_radio(year=2026, round_number=1, session="race"))

        self.assertFalse(body(response)["synced"])
        self.assertEqual(body(response)["clips"], [])

    def test_a_session_f1_published_nothing_for_reports_synced_with_no_clips(self):
        """Distinct from "not processed yet" — one invites a retry, the other doesn't.

        Eight 2026 race and sprint sessions are in this state.
        """
        doc = {"clips": [], "synced": True, "source": None}

        with patch.object(race_radio, "get_db", return_value=FakeDb(FakeCollection(doc=doc))):
            response = run(race_radio.get_race_radio(year=2026, round_number=1, session="race"))

        self.assertTrue(body(response)["synced"])
        self.assertEqual(body(response)["clips"], [])

    def test_a_database_failure_answers_like_an_unprocessed_session(self):
        class Exploding(FakeCollection):
            async def find_one(self, *args, **kwargs):
                raise RuntimeError("mongo is having a day")

        with patch.object(race_radio, "get_db", return_value=FakeDb(Exploding())):
            response = run(race_radio.get_race_radio(year=2026, round_number=15, session="race"))

        self.assertFalse(body(response)["synced"])

    def test_an_unknown_session_type_falls_back_to_race(self):
        collection = FakeCollection(doc={"clips": [], "synced": True})

        with patch.object(race_radio, "get_db", return_value=FakeDb(collection)):
            response = run(race_radio.get_race_radio(year=2026, round_number=15, session="qualifying"))

        self.assertEqual(collection.queries[0]["query"]["session_type"], "race")
        self.assertEqual(body(response)["session"], "race")

    def test_sprint_is_a_valid_session_type(self):
        collection = FakeCollection(doc={"clips": [], "synced": True})

        with patch.object(race_radio, "get_db", return_value=FakeDb(collection)):
            response = run(race_radio.get_race_radio(year=2026, round_number=15, session="sprint"))

        self.assertEqual(collection.queries[0]["query"]["session_type"], "sprint")
        self.assertEqual(body(response)["session"], "sprint")

    def test_served_clips_are_ordered_even_when_stored_out_of_order(self):
        doc = {
            "clips": [
                clip("2026-08-23T13:20:00+00:00", t_ms=1200000),
                clip("2026-08-23T13:05:00+00:00", t_ms=300000),
            ],
            "synced": True,
        }

        with patch.object(race_radio, "get_db", return_value=FakeDb(FakeCollection(doc=doc))):
            response = run(race_radio.get_race_radio(year=2026, round_number=15, session="race"))

        self.assertEqual([c["t_ms"] for c in body(response)["clips"]], [300000, 1200000])


if __name__ == "__main__":
    unittest.main()
