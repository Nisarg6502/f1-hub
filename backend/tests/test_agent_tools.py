"""Tests for the agent's internal tool layer (CP60).

Everything external is faked. Mongo is an in-memory collection and no network
call happens, so this runs the same way in CI as on a laptop.

**The fake is deliberately stricter than a convenient one would be.** Batch
16's PR #97 lesson was that a fake more permissive than real MongoDB lets a
broken query pass its tests and then fail in production, so `_matches` below:

* compares types the way real Mongo does — `{"round": "14"}` does **not** match
  a document storing `14`, which matters because every collection here stores
  `round` as an Ergast string and a tool that forgot `str()` would silently
  return nothing;
* honours projections, including `{"_id": 0}` and inclusion lists, so a tool
  that projected away the `synced_at` it then relies on for `as_of` would fail
  here rather than quietly report the wrong freshness;
* raises on an operator it does not implement, rather than ignoring it, so a
  query this fake cannot actually evaluate can never look like a pass.

The two contract-level properties are asserted for every tool: a success is a
fact bundle with `data`/`evidence_id`/`source`/`as_of`, and a missing
dependency is `{"available": False}` rather than an exception.
"""

import asyncio
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from agent.ledger import EvidenceLedger
from agent.tools import TOOLS
from agent.tools import base, circuits, context, drivers, history, race, season


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------


def _field(doc, path):
    """Read a possibly-dotted field, the way a Mongo query path resolves."""
    value = doc
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _matches(doc, query):
    for path, condition in (query or {}).items():
        value = _field(doc, path)
        if isinstance(condition, dict):
            for op, operand in condition.items():
                if op == "$gte":
                    if value is None or not value >= operand:
                        return False
                elif op == "$lte":
                    if value is None or not value <= operand:
                        return False
                else:
                    raise AssertionError(
                        f"the fake collection does not implement {op}; implement "
                        "it rather than letting an unevaluated query pass"
                    )
        else:
            # Type-strict, like real MongoDB. `"14" != 14`.
            if type(value) is not type(condition) or value != condition:
                return False
    return True


def _project(doc, projection):
    if not projection:
        return dict(doc)
    includes = {k: v for k, v in projection.items() if v and k != "_id"}
    if includes:
        out = {k: doc[k] for k in includes if k in doc}
    else:
        out = {k: v for k, v in doc.items() if projection.get(k) != 0}
    if projection.get("_id") == 0:
        out.pop("_id", None)
    elif "_id" in doc and not includes:
        out.setdefault("_id", doc["_id"])
    return out


class FakeCollection:
    def __init__(self, docs=None, fail=False):
        self.docs = [dict(d) for d in (docs or [])]
        # Set to simulate an unreachable database, which is what the fail-soft
        # contract actually has to survive.
        self.fail = fail

    async def find_one(self, query=None, projection=None):
        await asyncio.sleep(0)
        if self.fail:
            raise RuntimeError("connection lost")
        for doc in self.docs:
            if _matches(doc, query or {}):
                return _project(doc, projection)
        return None

    def find(self, query=None, projection=None):
        fail = self.fail
        matched = [
            _project(d, projection) for d in self.docs if _matches(d, query or {})
        ]

        class _Cursor:
            def sort(self_inner, spec):
                for field, direction in reversed(spec):
                    matched.sort(
                        key=lambda d: d.get(field), reverse=direction < 0
                    )
                return self_inner

            async def to_list(self_inner, length=None):
                await asyncio.sleep(0)
                if fail:
                    raise RuntimeError("connection lost")
                return matched if length is None else matched[:length]

        return _Cursor()


class FakeDB:
    """A database of `FakeCollection`s; anything unnamed is simply empty.

    Matching Motor's own surface — `db.races` and `db["races"]` are the same
    collection — because the tools use both forms and a fake that only
    supported one would pass while the other broke.
    """

    def __init__(self, **collections):
        self._collections = {
            name: value if isinstance(value, FakeCollection) else FakeCollection(value)
            for name, value in collections.items()
        }

    def __getattr__(self, name):
        return self._collections.setdefault(name, FakeCollection())

    def __getitem__(self, name):
        return getattr(self, name)


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

SYNCED_RESULTS = "2026-07-27T09:00:00+00:00"
SYNCED_REPLAY = "2026-07-28T09:00:00+00:00"


def result_row(
    number, driver_id, given, family, code, team, position, grid, points,
    status="Finished", time="+0.000", fastest=False,
):
    row = {
        "number": number,
        "position": str(position),
        "positionText": str(position),
        "grid": str(grid),
        "points": str(points),
        "status": status,
        "Driver": {
            "driverId": driver_id,
            "code": code,
            "givenName": given,
            "familyName": family,
        },
        "Constructor": {"constructorId": team.lower().replace(" ", "_"), "name": team},
        "Time": {"time": time},
    }
    if fastest:
        row["FastestLap"] = {"rank": "1", "lap": "42", "Time": {"time": "1:17.207"}}
    return row


HUNGARY_RESULTS = [
    result_row("4", "norris", "Lando", "Norris", "NOR", "McLaren", 1, 2, 25, time="1:35:21.000"),
    result_row("1", "max_verstappen", "Max", "Verstappen", "VER", "Red Bull", 2, 1, 18, time="+2.337"),
    result_row("81", "piastri", "Oscar", "Piastri", "PIA", "McLaren", 3, 5, 15, time="+8.100", fastest=True),
    result_row("12", "antonelli", "Kimi", "Antonelli", "ANT", "Mercedes", 12, 4, 0, status="Engine", time=""),
]

HUNGARY_QUALI = [
    {
        "position": "1",
        "Driver": {"driverId": "max_verstappen", "code": "VER", "givenName": "Max", "familyName": "Verstappen"},
        "Constructor": {"name": "Red Bull"},
        "Q1": "1:18.100", "Q2": "1:17.500", "Q3": "1:17.207",
    },
    {
        "position": "2",
        "Driver": {"driverId": "norris", "code": "NOR", "givenName": "Lando", "familyName": "Norris"},
        "Constructor": {"name": "McLaren"},
        "Q1": "1:18.300", "Q2": "1:17.600", "Q3": "1:17.498",
    },
    {
        "position": "11",
        "Driver": {"driverId": "piastri", "code": "PIA", "givenName": "Oscar", "familyName": "Piastri"},
        "Constructor": {"name": "McLaren"},
        "Q1": "1:18.400", "Q2": "1:17.900", "Q3": "",
    },
    {
        "position": "17",
        "Driver": {"driverId": "antonelli", "code": "ANT", "givenName": "Kimi", "familyName": "Antonelli"},
        "Constructor": {"name": "Mercedes"},
        "Q1": "1:18.900", "Q2": "", "Q3": "",
    },
]

RACES = [
    {
        "season": 2026, "round": "13", "raceName": "Hungarian Grand Prix",
        "date": "2026-07-26", "synced_at": SYNCED_RESULTS,
        "Circuit": {
            "circuitId": "hungaroring", "circuitName": "Hungaroring",
            "Location": {"locality": "Budapest", "country": "Hungary", "lat": "47.5789", "long": "19.2486"},
        },
    },
    {
        "season": 2026, "round": "14", "raceName": "Belgian Grand Prix",
        "date": "2026-08-09", "synced_at": SYNCED_RESULTS,
        "Circuit": {
            "circuitId": "spa", "circuitName": "Circuit de Spa-Francorchamps",
            "Location": {"locality": "Spa", "country": "Belgium", "lat": "50.4372", "long": "5.9714"},
        },
    },
]

RACE_DOC = {
    "season": 2026, "round": "13", "synced_at": SYNCED_RESULTS,
    "race": {
        "raceName": "Hungarian Grand Prix", "season": "2026", "round": "13",
        "date": "2026-07-26", "Circuit": {"circuitName": "Hungaroring"},
    },
    "results": HUNGARY_RESULTS,
}

QUALI_DOC = {
    "season": 2026, "round": "13", "synced_at": SYNCED_RESULTS,
    "race": {"raceName": "Hungarian Grand Prix", "Circuit": {"circuitName": "Hungaroring"}},
    "results": HUNGARY_QUALI,
}

# Round 6 is a sprint weekend, used by the after_round standings test.
SPRINT_DOC = {
    "season": 2026, "round": "6", "synced_at": SYNCED_RESULTS,
    "race": {"raceName": "Miami Grand Prix"},
    "results": [
        result_row("81", "piastri", "Oscar", "Piastri", "PIA", "McLaren", 1, 1, 8),
        result_row("4", "norris", "Lando", "Norris", "NOR", "McLaren", 2, 2, 7),
    ],
}

ROUND_6_RACE_DOC = {
    "season": 2026, "round": "6", "synced_at": SYNCED_RESULTS,
    "race": {"raceName": "Miami Grand Prix"},
    "results": [
        result_row("1", "max_verstappen", "Max", "Verstappen", "VER", "Red Bull", 1, 1, 25),
        result_row("4", "norris", "Lando", "Norris", "NOR", "McLaren", 2, 2, 18),
    ],
}

DRIVER_STANDINGS_DOC = {
    "season": 2026, "synced_at": SYNCED_RESULTS,
    "standings": [
        {
            "position": "1", "points": "284", "wins": "6",
            "Driver": {"driverId": "norris", "givenName": "Lando", "familyName": "Norris"},
            "Constructors": [{"name": "McLaren"}],
        },
        {
            "position": "2", "points": "241", "wins": "4",
            "Driver": {"driverId": "max_verstappen", "givenName": "Max", "familyName": "Verstappen"},
            "Constructors": [{"name": "Red Bull"}],
        },
    ],
}

CONSTRUCTOR_STANDINGS_DOC = {
    "season": 2026, "synced_at": SYNCED_RESULTS,
    "standings": [
        {"position": "1", "points": "500", "wins": "9",
         "Constructor": {"constructorId": "mclaren", "name": "McLaren"}},
        {"position": "2", "points": "330", "wins": "4",
         "Constructor": {"constructorId": "red_bull", "name": "Red Bull"}},
    ],
}

# Norris (4) pits on lap 20, Verstappen (1) on lap 22. Verstappen leads before
# the window and Norris leads after it: an undercut, and the only kind of claim
# `strategy_commentary` will let a model make about a pit stop.
LAPS = []
for lap in range(1, 31):
    if lap <= 21:
        pos_1, pos_4 = 1, 2
    else:
        pos_1, pos_4 = 2, 1
    LAPS.append({"driver_number": 1, "lap_number": lap, "position": pos_1, "gap_seconds": 0.0 if pos_1 == 1 else 2.5})
    LAPS.append({"driver_number": 4, "lap_number": lap, "position": pos_4, "gap_seconds": 0.0 if pos_4 == 1 else 2.5})

LAPS_DOC = {"season": 2026, "round": "13", "laps": LAPS, "source": "openf1", "synced_at": SYNCED_RESULTS}

STINTS_DOC = {
    "season": 2026, "round": "13", "synced_at": SYNCED_RESULTS,
    "stints": [
        {"driver_number": 4, "stint_number": 1, "compound": "MEDIUM", "lap_start": 1, "lap_end": 19},
        {"driver_number": 4, "stint_number": 2, "compound": "HARD", "lap_start": 20, "lap_end": 30},
        {"driver_number": 1, "stint_number": 1, "compound": "MEDIUM", "lap_start": 1, "lap_end": 21},
        {"driver_number": 1, "stint_number": 2, "compound": "HARD", "lap_start": 22, "lap_end": 30},
        {"driver_number": 81, "stint_number": 1, "compound": "SOFT", "lap_start": 1, "lap_end": 10},
        {"driver_number": 81, "stint_number": 2, "compound": "MEDIUM", "lap_start": 11, "lap_end": 20},
        {"driver_number": 81, "stint_number": 3, "compound": "HARD", "lap_start": 21, "lap_end": 30},
    ],
}

PIT_STOPS_DOC = {
    "season": 2026, "round": "13", "synced_at": SYNCED_RESULTS,
    "stops": [
        {"driver_id": "norris", "lap": 20, "stop": 1, "duration": "21.789", "duration_seconds": 21.789},
        {"driver_id": "max_verstappen", "lap": 22, "stop": 1, "duration": "22.100", "duration_seconds": 22.1},
        {"driver_id": "piastri", "lap": 10, "stop": 1, "duration": "20.500", "duration_seconds": 20.5},
        {"driver_id": "piastri", "lap": 20, "stop": 2, "duration": "16:12.356", "duration_seconds": 972.356},
    ],
}

REPLAY_DOC = {
    "season": 2026, "round": "13", "version": 3, "synced_at": SYNCED_REPLAY,
    "replay": {
        "race_name": "Hungarian Grand Prix",
        "laps": [
            {"lap": 5, "runners": [], "events": [
                {"kind": "safety_car_deployed", "drivers": [], "message": "SAFETY CAR DEPLOYED"}
            ]},
            {"lap": 18, "runners": [], "events": [
                {"kind": "penalty", "drivers": ["Max Verstappen"],
                 "message": "CAR 1 (VER) 5 SECOND TIME PENALTY - TRACK LIMITS"}
            ]},
            {"lap": 25, "runners": [], "events": []},
        ],
    },
}

WEATHER_DOC = {
    "season": 2026, "round": "13", "date": "2026-07-26", "synced_at": SYNCED_RESULTS,
    "air_temperature": 31.4, "track_temperature": 48.2, "humidity": 38,
    "pressure": 1004.2, "wind_speed": 1.9, "wind_direction": 210, "rainfall": 0,
}

CIRCUIT_DETAILS_DOC = {
    "season": 2026, "round": 13, "country": "Hungary", "circuit_name": "Hungaroring",
    "grand_prix": "Hungarian Grand Prix", "date": "2026-07-26", "synced_at": SYNCED_RESULTS,
    "track_information": {
        "first_grand_prix": 1986, "number_of_laps": 70,
        "number_of_corners": 14, "lap_record": "1:16.627 (HAM)",
    },
}

DRIVER_BIO_DOC = {
    "driverId": "max_verstappen", "givenName": "Max", "familyName": "Verstappen",
    "code": "VER", "permanentNumber": "1", "dateOfBirth": "1997-09-30",
    "nationality": "Dutch", "wikiUrl": "https://en.wikipedia.org/wiki/Max_Verstappen",
    "wins": 68, "podiums": 118, "poles": 45, "championships": 4,
    "synced_at": SYNCED_RESULTS,
}

# Monza across four eras, including the chassis/engine-era Lotus ids that
# `historical_index.CONSTRUCTOR_ALIASES` collapses, plus a 1955 Indy 500 that
# must never be tallied as a Grand Prix win.
HISTORICAL_INDEX = [
    {"season": 1963, "round": 8, "date": "1963-09-08", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "Jim Clark", "constructor_key": "lotus",
     "constructor_name": "Lotus", "indy500": False},
    {"season": 1965, "round": 8, "date": "1965-09-12", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "Jackie Stewart", "constructor_key": "brm",
     "constructor_name": "BRM", "indy500": False},
    {"season": 1968, "round": 9, "date": "1968-09-08", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "Denny Hulme", "constructor_key": "mclaren",
     "constructor_name": "McLaren", "indy500": False},
    {"season": 1978, "round": 14, "date": "1978-09-10", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "Niki Lauda", "constructor_key": "brabham",
     "constructor_name": "Brabham", "indy500": False},
    {"season": 1970, "round": 7, "date": "1970-09-06", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "Clay Regazzoni", "constructor_key": "ferrari",
     "constructor_name": "Ferrari", "indy500": False},
    {"season": 1967, "round": 8, "date": "1967-09-10", "race_name": "Italian Grand Prix",
     "circuit_id": "monza", "driver": "John Surtees", "constructor_key": "lotus",
     "constructor_name": "Lotus", "indy500": False},
    {"season": 1955, "round": 3, "date": "1955-05-30", "race_name": "Indianapolis 500",
     "circuit_id": "indianapolis", "driver": "Bob Sweikert", "constructor_key": "kurtis_kraft",
     "constructor_name": "Kurtis Kraft", "indy500": True},
    {"season": 2003, "round": 4, "date": "2003-05-18", "race_name": "United States Grand Prix",
     "circuit_id": "indianapolis", "driver": "Michael Schumacher", "constructor_key": "ferrari",
     "constructor_name": "Ferrari", "indy500": False},
]


def full_db(**overrides):
    """A database with every collection these tools read, populated."""
    collections = {
        "races": RACES,
        "race_results": [RACE_DOC, ROUND_6_RACE_DOC],
        "qualifying_results": [QUALI_DOC],
        "sprint_results": [SPRINT_DOC],
        "driver_standings": [DRIVER_STANDINGS_DOC],
        "constructor_standings": [CONSTRUCTOR_STANDINGS_DOC],
        "race_laps": [LAPS_DOC],
        "race_stints": [STINTS_DOC],
        "pit_stops": [PIT_STOPS_DOC],
        "race_replay": [REPLAY_DOC],
        "weather_cache": [WEATHER_DOC],
        "circuit_details": [CIRCUIT_DETAILS_DOC],
        "driver_bios": [DRIVER_BIO_DOC],
        "historical_race_index": HISTORICAL_INDEX,
        "constructor_seasons_cache": [
            {"constructor_id": "team_lotus", "seasons": [1958, 1959, 1960, 1961, 1962, 1963]}
        ],
        "circuit_history_cache": [
            {"circuit_name": "Hungaroring", "first_year": 1986,
             "closest_finish": {"gap_seconds": 0.288, "season": 2000, "round": 12}}
        ],
        "track_geometry_builds": [{"_id": "hungaroring", "status": "done"}],
    }
    collections.update(overrides)
    return FakeDB(**collections)


class BundleAssertions(unittest.TestCase):
    def assertBundle(self, result, source_startswith=None):
        """Every success must carry the whole §5 shape, not most of it."""
        self.assertTrue(result.get("available"), result.get("reason"))
        self.assertIn("data", result)
        self.assertIsInstance(result["data"], dict)
        self.assertIn("evidence_id", result)
        self.assertIn("source", result)
        self.assertIn("as_of", result)
        self.assertTrue(result["as_of"])
        if source_startswith:
            self.assertTrue(
                result["source"].startswith(source_startswith), result["source"]
            )
        return result["data"]

    def assertUnavailable(self, result):
        self.assertIsInstance(result, dict)
        self.assertFalse(result.get("available"))
        self.assertTrue(result.get("reason"))
        self.assertNotIn("data", result)
        return result


# --------------------------------------------------------------------------
# the fake itself
# --------------------------------------------------------------------------


class FakeCollectionFidelityTests(unittest.TestCase):
    """A fake looser than Mongo hides the bug it was written to catch."""

    def test_a_string_query_does_not_match_an_int_field(self):
        collection = FakeCollection([{"season": 2026, "round": 13}])

        self.assertIsNone(run(collection.find_one({"season": 2026, "round": "13"})))

    def test_an_int_query_does_not_match_a_string_field(self):
        collection = FakeCollection([{"season": 2026, "round": "13"}])

        self.assertIsNone(run(collection.find_one({"round": 13})))
        self.assertIsNotNone(run(collection.find_one({"round": "13"})))

    def test_a_dotted_path_resolves(self):
        collection = FakeCollection([{"Circuit": {"circuitId": "spa"}}])

        self.assertIsNotNone(run(collection.find_one({"Circuit.circuitId": "spa"})))
        self.assertIsNone(run(collection.find_one({"Circuit.circuitId": "monza"})))

    def test_an_unimplemented_operator_raises_rather_than_being_ignored(self):
        collection = FakeCollection([{"season": 2026}])

        with self.assertRaises(AssertionError):
            run(collection.find_one({"season": {"$ne": 2025}}))

    def test_a_projection_actually_removes_fields(self):
        collection = FakeCollection([{"_id": 1, "a": 1, "synced_at": "x"}])

        doc = run(collection.find_one({}, {"_id": 0, "a": 1}))

        self.assertEqual(doc, {"a": 1})


# --------------------------------------------------------------------------
# base: the contract
# --------------------------------------------------------------------------


class ContractTests(BundleAssertions):
    def test_as_of_is_the_oldest_synced_at_not_the_newest(self):
        stamp = base.as_of_from(
            [
                {"synced_at": "2026-08-05T10:00:00+00:00"},
                {"synced_at": "2026-07-01T10:00:00+00:00"},
                None,
            ]
        )

        self.assertEqual(stamp, "2026-07-01T10:00:00+00:00")

    def test_as_of_falls_back_to_now_when_nothing_carried_a_stamp(self):
        stamp = base.as_of_from([{"a": 1}, None])

        self.assertTrue(stamp.endswith("+00:00"))

    def test_a_bundle_records_itself_in_the_ledger_with_the_documents_stamp(self):
        ledger = EvidenceLedger()

        result = base.bundle(
            data={"x": 1},
            source="mongo:test/1",
            docs=[{"synced_at": "2026-07-01T10:00:00+00:00"}],
            ledger=ledger,
            tool="t",
        )

        self.assertEqual(result["evidence_id"], "ev_1")
        self.assertEqual(ledger.get("ev_1").as_of, "2026-07-01T10:00:00+00:00")
        self.assertEqual(result["as_of"], "2026-07-01T10:00:00+00:00")

    def test_a_bundle_without_a_ledger_has_no_evidence_id(self):
        result = base.bundle(data={}, source="s")

        self.assertIsNone(result["evidence_id"])

    def test_every_registered_tool_is_registered_under_the_name_it_answers_to(self):
        for name, fn in TOOLS.items():
            with self.subTest(tool=name):
                self.assertEqual(fn.tool_name, name)

    def test_the_registry_covers_the_plans_sixteen_internal_tools(self):
        expected = {
            "get_season_calendar", "get_session_result", "get_standings",
            "get_driver_profile", "get_driver_season_summary", "get_head_to_head",
            "get_race_narrative_facts", "get_race_strategy", "get_race_control",
            "get_lap_summary", "get_pit_stops", "get_weather",
            "get_circuit_profile", "get_circuit_history",
            "get_historical_race_index", "get_constructor_seasons",
        }

        self.assertTrue(expected.issubset(set(TOOLS)))

    def test_a_tool_reports_a_dead_database_rather_than_raising(self):
        """The fail-soft contract, exercised against every tool in the registry."""
        calls = {
            "get_season_calendar": (2026,),
            "get_session_result": (2026, 13),
            "get_standings": (2026,),
            "get_driver_profile": ("norris",),
            "get_driver_season_summary": ("norris", 2026),
            "get_head_to_head": ("norris", "max_verstappen", 2026),
            "get_race_narrative_facts": (2026, 13),
            "get_race_strategy": (2026, 13),
            "get_race_control": (2026, 13),
            "get_lap_summary": (2026, 13),
            "get_pit_stops": (2026, 13),
            "get_weather": (2026, 13),
            "get_circuit_profile": ("hungaroring",),
            "get_circuit_history": ("monza",),
            "get_historical_race_index": (),
            "get_constructor_seasons": ("lotus",),
            "resolve_context": ("the last race",),
            "get_season_state": (),
        }
        for name, args in calls.items():
            with self.subTest(tool=name):
                broken = FakeDB(
                    **{
                        collection: FakeCollection([], fail=True)
                        for collection in (
                            "races", "race_results", "qualifying_results",
                            "sprint_results", "driver_standings",
                            "constructor_standings", "race_laps", "race_stints",
                            "pit_stops", "race_replay", "weather_cache",
                            "circuit_details", "driver_bios",
                            "historical_race_index", "constructor_seasons_cache",
                            "circuit_history_cache", "track_geometry_builds",
                        )
                    }
                )
                result = run(TOOLS[name](*args, db=broken))
                self.assertUnavailable(result)


# --------------------------------------------------------------------------
# season tools
# --------------------------------------------------------------------------


class SeasonCalendarTests(BundleAssertions):
    def test_it_returns_rounds_with_winners_attached(self):
        data = self.assertBundle(
            run(season.get_season_calendar(2026, db=full_db())), "mongo:races/2026"
        )

        self.assertEqual(data["rounds_scheduled"], 2)
        self.assertEqual(data["rounds"][0]["round"], 13)
        self.assertEqual(data["rounds"][0]["circuit_id"], "hungaroring")
        self.assertEqual(data["rounds"][0]["winner"], "Lando Norris")
        self.assertIsNone(data["rounds"][1]["winner"])

    def test_the_run_count_is_computed_rather_than_left_to_the_model(self):
        data = self.assertBundle(run(season.get_season_calendar(2026, db=full_db())))

        self.assertEqual(data["rounds_with_a_result"], 1)

    def test_an_unsynced_season_is_unavailable(self):
        self.assertUnavailable(run(season.get_season_calendar(1999, db=full_db())))

    def test_it_writes_one_ledger_entry(self):
        ledger = EvidenceLedger()

        run(season.get_season_calendar(2026, ledger=ledger, db=full_db()))

        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger.get("ev_1").tool, "get_season_calendar")


class SessionResultTests(BundleAssertions):
    def test_a_race_bundle_states_teammates_rather_than_implying_them(self):
        """The direct CP38 fix: the pairing is a fact, never an inference."""
        data = self.assertBundle(
            run(season.get_session_result(2026, 13, "R", db=full_db())),
            "mongo:race_results/2026-13",
        )

        self.assertEqual(data["teammates"], [{"team": "McLaren", "drivers": ["Lando Norris", "Oscar Piastri"]}])

    def test_a_race_bundle_carries_the_podium_and_retirements(self):
        data = self.assertBundle(run(season.get_session_result(2026, 13, "R", db=full_db())))

        self.assertEqual([p["driver"] for p in data["podium"]], ["Lando Norris", "Max Verstappen", "Oscar Piastri"])
        self.assertEqual([r["driver"] for r in data["retirements"]], ["Kimi Antonelli"])
        self.assertEqual(data["fastest_lap"]["driver"], "Oscar Piastri")

    def test_positions_gained_is_precomputed(self):
        data = self.assertBundle(run(season.get_session_result(2026, 13, "R", db=full_db())))

        piastri = next(c for c in data["classification"] if c["driver"] == "Oscar Piastri")
        self.assertEqual(piastri["positions_gained"], 2)

    def test_a_qualifying_bundle_resolves_which_segment_each_driver_fell_in(self):
        data = self.assertBundle(
            run(season.get_session_result(2026, 13, "Q", db=full_db())),
            "mongo:qualifying_results/2026-13",
        )

        self.assertEqual(data["pole"]["driver"], "Max Verstappen")
        self.assertEqual(data["pole"]["margin_to_second"], "0.291s")
        self.assertEqual([d["driver"] for d in data["q2_eliminated"]], ["Oscar Piastri"])
        self.assertEqual([d["driver"] for d in data["q1_eliminated"]], ["Kimi Antonelli"])

    def test_a_plain_word_session_name_is_accepted(self):
        self.assertBundle(run(season.get_session_result(2026, 13, "qualifying", db=full_db())))
        self.assertBundle(run(season.get_session_result(2026, 13, "race", db=full_db())))

    def test_an_unknown_session_is_named_in_the_reason(self):
        result = self.assertUnavailable(
            run(season.get_session_result(2026, 13, "warmup", db=full_db()))
        )

        self.assertIn("warmup", result["reason"])

    def test_an_unsynced_round_is_unavailable(self):
        self.assertUnavailable(run(season.get_session_result(2026, 14, "R", db=full_db())))


class StandingsTests(BundleAssertions):
    def test_the_stored_driver_table_is_served_with_gaps_precomputed(self):
        data = self.assertBundle(
            run(season.get_standings(2026, db=full_db())), "mongo:driver_standings/2026"
        )

        self.assertEqual(data["standings"][0]["driver"], "Lando Norris")
        self.assertEqual(data["standings"][1]["points_behind_leader"], 43.0)

    def test_the_constructor_table_is_a_different_shape(self):
        data = self.assertBundle(run(season.get_standings(2026, "constructor", db=full_db())))

        self.assertEqual(data["standings"][0]["constructor"], "McLaren")

    def test_a_plural_kind_is_accepted(self):
        self.assertBundle(run(season.get_standings(2026, "constructors", db=full_db())))

    def test_an_unknown_kind_is_unavailable(self):
        self.assertUnavailable(run(season.get_standings(2026, "teams", db=full_db())))

    def test_after_round_is_retallied_from_results_including_sprint_points(self):
        data = self.assertBundle(
            run(season.get_standings(2026, "driver", after_round=6, db=full_db()))
        )

        by_id = {row["driver_id"]: row for row in data["standings"]}
        # Round 6: Verstappen 25 (race win), Norris 18 + 7 (sprint P2) = 25,
        # Piastri 8 (sprint win only).
        self.assertEqual(by_id["max_verstappen"]["points"], 25.0)
        self.assertEqual(by_id["norris"]["points"], 25.0)
        self.assertEqual(by_id["piastri"]["points"], 8.0)

    def test_a_sprint_victory_is_not_counted_as_a_win(self):
        data = self.assertBundle(
            run(season.get_standings(2026, "driver", after_round=6, db=full_db()))
        )

        by_id = {row["driver_id"]: row for row in data["standings"]}
        self.assertEqual(by_id["piastri"]["wins"], 0)
        self.assertEqual(by_id["max_verstappen"]["wins"], 1)

    def test_after_round_excludes_later_rounds(self):
        data = self.assertBundle(
            run(season.get_standings(2026, "driver", after_round=6, db=full_db()))
        )

        # Round 13's 25 points for Norris must not appear in a round-6 table.
        by_id = {row["driver_id"]: row for row in data["standings"]}
        self.assertNotIn("antonelli", by_id)

    def test_an_unsynced_season_is_unavailable(self):
        self.assertUnavailable(run(season.get_standings(1999, db=full_db())))


class WeatherTests(BundleAssertions):
    def test_rainfall_is_surfaced_as_a_boolean(self):
        data = self.assertBundle(
            run(season.get_weather(2026, 13, db=full_db())), "mongo:weather_cache/2026-13"
        )

        self.assertIs(data["raining"], False)
        self.assertEqual(data["air_temperature_c"], 31.4)

    def test_an_uncaptured_round_is_unavailable(self):
        self.assertUnavailable(run(season.get_weather(2026, 14, db=full_db())))


# --------------------------------------------------------------------------
# race tools
# --------------------------------------------------------------------------


class NarrativeFactsTests(BundleAssertions):
    def test_it_returns_session_recaps_own_fact_bundle(self):
        data = self.assertBundle(
            run(race.get_race_narrative_facts(2026, 13, db=full_db())),
            "mongo:race_results/2026-13",
        )

        self.assertEqual(data["race_name"], "Hungarian Grand Prix")
        self.assertEqual(data["teammates"], [{"team": "McLaren", "drivers": ["Lando Norris", "Oscar Piastri"]}])
        self.assertEqual(len(data["podium"]), 3)

    def test_race_control_comes_from_the_cached_replay(self):
        data = self.assertBundle(run(race.get_race_narrative_facts(2026, 13, db=full_db())))

        kinds = [e["kind"] for e in data["race_control"]["events"]]
        self.assertEqual(kinds, ["safety_car_deployed", "penalty"])
        self.assertIs(data["race_control"]["complete"], True)

    def test_missing_race_control_is_flagged_rather_than_read_as_a_clean_race(self):
        data = self.assertBundle(
            run(race.get_race_narrative_facts(2026, 13, db=full_db(race_replay=[])))
        )

        self.assertEqual(data["race_control"]["events"], [])
        self.assertIs(data["race_control"]["complete"], False)

    def test_as_of_is_the_older_of_the_two_documents(self):
        result = run(race.get_race_narrative_facts(2026, 13, db=full_db()))

        self.assertEqual(result["as_of"], SYNCED_RESULTS)

    def test_an_unsynced_round_is_unavailable(self):
        self.assertUnavailable(run(race.get_race_narrative_facts(2026, 14, db=full_db())))


class RaceControlTests(BundleAssertions):
    def test_events_are_flattened_with_their_lap_and_kind(self):
        data = self.assertBundle(
            run(race.get_race_control(2026, 13, db=full_db())), "mongo:race_replay/2026-13"
        )

        self.assertEqual(data["event_count"], 2)
        self.assertEqual(data["counts_by_kind"], {"safety_car_deployed": 1, "penalty": 1})
        self.assertEqual(data["events"][0]["lap"], 5)
        self.assertEqual(data["events"][1]["drivers"], ["Max Verstappen"])

    def test_what_the_replay_cache_drops_is_stated_on_the_bundle(self):
        data = self.assertBundle(run(race.get_race_control(2026, 13, db=full_db())))

        self.assertIn("track-limit", data["excludes"])

    def test_an_uncached_round_is_unavailable(self):
        self.assertUnavailable(run(race.get_race_control(2026, 14, db=full_db())))


class StrategyTests(BundleAssertions):
    def test_an_undercut_is_resolved_in_python_not_left_to_the_model(self):
        data = self.assertBundle(
            run(race.get_race_strategy(2026, 13, db=full_db())), "mongo:race_stints/2026-13"
        )

        events = data["undercut_overcut_events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["outcome"], "undercut")
        self.assertEqual(events[0]["gainer"], "Lando Norris")
        self.assertEqual(events[0]["loser"], "Max Verstappen")

    def test_a_strategy_outlier_is_flagged_against_the_field(self):
        data = self.assertBundle(run(race.get_race_strategy(2026, 13, db=full_db())))

        self.assertEqual(data["field_common_stops"], 1)
        self.assertEqual([o["driver"] for o in data["strategy_outliers"]], ["Oscar Piastri"])

    def test_a_missing_dependency_is_named_specifically(self):
        result = self.assertUnavailable(
            run(race.get_race_strategy(2026, 13, db=full_db(race_stints=[])))
        )

        self.assertIn("race_stints", result["reason"])

    def test_all_three_missing_dependencies_are_listed(self):
        result = self.assertUnavailable(run(race.get_race_strategy(2026, 14, db=full_db())))

        for name in ("race_results", "race_stints", "race_laps"):
            self.assertIn(name, result["reason"])


class PitStopTests(BundleAssertions):
    def test_a_red_flag_stop_is_excluded_from_the_fastest_stop(self):
        """It is minutes long, and it is true and useless as "the slowest stop"."""
        data = self.assertBundle(
            run(race.get_pit_stops(2026, 13, db=full_db())), "mongo:pit_stops/2026-13"
        )

        self.assertEqual(data["fastest_stop"]["driver_id"], "piastri")
        self.assertEqual(data["fastest_stop"]["duration_seconds"], 20.5)

    def test_the_red_flag_stop_is_still_reported_in_the_per_driver_table(self):
        data = self.assertBundle(run(race.get_pit_stops(2026, 13, db=full_db())))

        piastri = data["stops_by_driver"]["piastri"]
        self.assertEqual(len(piastri), 2)
        self.assertEqual(piastri[1]["duration"], "16:12.356")

    def test_the_pit_lane_caveat_travels_with_the_data(self):
        data = self.assertBundle(run(race.get_pit_stops(2026, 13, db=full_db())))

        self.assertIn("pit-lane time", data["duration_note"])

    def test_totals_are_precomputed(self):
        data = self.assertBundle(run(race.get_pit_stops(2026, 13, db=full_db())))

        self.assertEqual(data["total_stops"], 4)
        self.assertEqual(data["drivers_who_stopped"], 3)

    def test_an_unsynced_round_is_unavailable(self):
        self.assertUnavailable(run(race.get_pit_stops(2026, 14, db=full_db())))


class LapSummaryTests(BundleAssertions):
    def test_the_raw_rows_never_reach_the_bundle(self):
        """The context-budget rule: 60 lap rows in, at most 10 samples out."""
        data = self.assertBundle(
            run(race.get_lap_summary(2026, 13, db=full_db())), "mongo:race_laps/2026-13"
        )

        self.assertEqual(data["total_lap_rows"], 60)
        for driver in data["drivers"]:
            with self.subTest(driver=driver["driver"]):
                self.assertLessEqual(len(driver["trace"]), race.TRACE_SAMPLES)
                self.assertEqual(driver["laps_recorded"], 30)

    def test_a_trace_always_keeps_the_first_and_last_lap(self):
        data = self.assertBundle(run(race.get_lap_summary(2026, 13, db=full_db())))

        trace = data["drivers"][0]["trace"]
        self.assertEqual(trace[0]["lap"], 1)
        self.assertEqual(trace[-1]["lap"], 30)

    def test_the_relational_summary_is_computed_rather_than_traced(self):
        data = self.assertBundle(run(race.get_lap_summary(2026, 13, db=full_db())))

        norris = next(d for d in data["drivers"] if d["driver_id"] == "norris")
        self.assertEqual(norris["start_position"], 2)
        self.assertEqual(norris["end_position"], 1)
        self.assertEqual(norris["net_positions_gained"], 1)
        self.assertEqual(norris["position_changes"], 1)
        self.assertEqual(norris["best_position"], 1)

    def test_drivers_can_be_named_by_id_code_or_car_number(self):
        for token in ("norris", "NOR", "4"):
            with self.subTest(token=token):
                data = self.assertBundle(
                    run(race.get_lap_summary(2026, 13, [token], db=full_db()))
                )
                self.assertEqual([d["driver_id"] for d in data["drivers"]], ["norris"])

    def test_an_unrecognised_driver_is_reported_not_silently_dropped(self):
        data = self.assertBundle(
            run(race.get_lap_summary(2026, 13, ["norris", "hamilton"], db=full_db()))
        )

        self.assertEqual(data["unmatched_requests"], ["hamilton"])
        self.assertEqual(data["drivers_in_summary"], 1)

    def test_asking_only_for_drivers_with_no_lap_data_is_unavailable(self):
        result = self.assertUnavailable(
            run(race.get_lap_summary(2026, 13, ["hamilton"], db=full_db()))
        )

        self.assertEqual(result["unmatched"], ["hamilton"])

    def test_the_default_selection_is_capped(self):
        data = self.assertBundle(run(race.get_lap_summary(2026, 13, db=full_db())))

        self.assertLessEqual(data["drivers_in_summary"], race.MAX_TRACE_DRIVERS)

    def test_the_sampling_caveat_travels_with_the_data(self):
        data = self.assertBundle(run(race.get_lap_summary(2026, 13, db=full_db())))

        self.assertIn("not a complete record", data["sampling"])

    def test_an_unsynced_round_is_unavailable(self):
        self.assertUnavailable(run(race.get_lap_summary(2026, 14, db=full_db())))


class DownsampleTests(unittest.TestCase):
    def test_a_short_series_is_returned_whole(self):
        rows = [{"lap": i} for i in range(5)]

        self.assertEqual(race._downsample(rows, 10), rows)

    def test_a_long_series_keeps_both_ends(self):
        rows = [{"lap": i} for i in range(78)]

        picked = race._downsample(rows, 10)

        self.assertLessEqual(len(picked), 10)
        self.assertEqual(picked[0]["lap"], 0)
        self.assertEqual(picked[-1]["lap"], 77)

    def test_the_sample_count_is_independent_of_race_length(self):
        short = race._downsample([{"lap": i} for i in range(44)], 10)
        long = race._downsample([{"lap": i} for i in range(78)], 10)

        self.assertEqual(len(short), len(long))


# --------------------------------------------------------------------------
# driver tools
# --------------------------------------------------------------------------


class DriverProfileTests(BundleAssertions):
    def test_a_cached_bio_is_reshaped_not_forwarded(self):
        data = self.assertBundle(
            run(drivers.get_driver_profile("max_verstappen", db=full_db())),
            "mongo:driver_bios/max_verstappen",
        )

        self.assertEqual(data["name"], "Max Verstappen")
        self.assertEqual(data["championships"], 4)
        self.assertNotIn("driverId", data)
        self.assertNotIn("synced_at", data)

    def test_an_absent_count_is_reported_rather_than_defaulted_to_zero(self):
        thin = dict(DRIVER_BIO_DOC)
        thin.pop("poles")

        data = self.assertBundle(
            run(drivers.get_driver_profile("max_verstappen", db=full_db(driver_bios=[thin])))
        )

        self.assertIsNone(data["poles"])
        self.assertEqual(data["missing_fields"], ["poles"])

    def test_an_uncached_driver_is_unavailable(self):
        self.assertUnavailable(run(drivers.get_driver_profile("senna", db=full_db())))

    def test_an_empty_id_is_unavailable(self):
        self.assertUnavailable(run(drivers.get_driver_profile("", db=full_db())))


class DriverSeasonSummaryTests(BundleAssertions):
    def test_it_counts_wins_podiums_and_points(self):
        data = self.assertBundle(
            run(drivers.get_driver_season_summary("norris", 2026, db=full_db())),
            "mongo:race_results/2026-norris",
        )

        self.assertEqual(data["wins"], 1)
        # P1 in round 13 and P2 in round 6 — both podiums.
        self.assertEqual(data["podiums"], 2)
        self.assertEqual(data["points"], 43.0)
        self.assertEqual(data["rounds_entered"], 2)

    def test_a_retirement_is_counted_separately_and_not_averaged_in(self):
        data = self.assertBundle(
            run(drivers.get_driver_season_summary("antonelli", 2026, db=full_db()))
        )

        self.assertEqual(data["retirements"], 1)
        self.assertEqual(data["classified_finishes"], 0)
        self.assertIsNone(data["average_finish"])

    def test_average_finish_uses_classified_finishes_only(self):
        data = self.assertBundle(
            run(drivers.get_driver_season_summary("norris", 2026, db=full_db()))
        )

        self.assertEqual(data["average_finish"], 1.5)
        self.assertIn("classified finishes only", data["average_finish_basis"])

    def test_the_teammate_is_resolved_from_the_constructor_not_assumed(self):
        data = self.assertBundle(
            run(drivers.get_driver_season_summary("norris", 2026, db=full_db()))
        )

        battles = {b["teammate_id"]: b for b in data["qualifying_teammate_battles"]}
        self.assertEqual(set(battles), {"piastri"})
        self.assertEqual(battles["piastri"]["out_qualified_them"], 1)
        self.assertEqual(battles["piastri"]["out_qualified_by_them"], 0)

    def test_a_driver_with_no_synced_rounds_is_unavailable(self):
        self.assertUnavailable(
            run(drivers.get_driver_season_summary("hamilton", 2026, db=full_db()))
        )


class HeadToHeadTests(BundleAssertions):
    def test_the_tallies_come_from_the_shared_fact_builder(self):
        data = self.assertBundle(
            run(drivers.get_head_to_head("norris", "max_verstappen", 2026, db=full_db()))
        )

        # Sorted canonically, so driver1 is max_verstappen either way round.
        self.assertEqual(data["driver1"]["id"], "max_verstappen")
        self.assertEqual(data["driver2"]["id"], "norris")
        self.assertEqual(data["race_head_to_head"]["shared_rounds"], 2)
        self.assertEqual(data["race_head_to_head"]["driver1_finished_ahead_count"], 1)
        self.assertEqual(data["race_head_to_head"]["driver2_finished_ahead_count"], 1)

    def test_argument_order_does_not_change_the_bundle(self):
        one = run(drivers.get_head_to_head("norris", "max_verstappen", 2026, db=full_db()))
        two = run(drivers.get_head_to_head("max_verstappen", "norris", 2026, db=full_db()))

        self.assertEqual(one["data"], two["data"])

    def test_the_per_round_tables_are_trimmed_off(self):
        data = self.assertBundle(
            run(drivers.get_head_to_head("norris", "max_verstappen", 2026, db=full_db()))
        )

        self.assertNotIn("rounds", data["race_head_to_head"])
        self.assertNotIn("rounds", data["qualifying_head_to_head"])

    def test_the_scope_is_stated_because_only_a_season_is_supported(self):
        data = self.assertBundle(
            run(drivers.get_head_to_head("norris", "max_verstappen", 2026, db=full_db()))
        )

        self.assertEqual(data["scope"], "season 2026")

    def test_comparing_a_driver_with_themselves_is_refused(self):
        self.assertUnavailable(run(drivers.get_head_to_head("norris", "norris", 2026, db=full_db())))

    def test_drivers_with_no_shared_rounds_are_unavailable(self):
        self.assertUnavailable(
            run(drivers.get_head_to_head("norris", "hamilton", 2026, db=full_db()))
        )


# --------------------------------------------------------------------------
# circuit tools
# --------------------------------------------------------------------------


class CircuitProfileTests(BundleAssertions):
    def test_it_joins_the_calendar_and_the_track_details(self):
        data = self.assertBundle(
            run(circuits.get_circuit_profile("hungaroring", db=full_db())),
            "mongo:circuit_details/hungaroring",
        )

        self.assertEqual(data["circuit_name"], "Hungaroring")
        self.assertEqual(data["locality"], "Budapest")
        self.assertEqual(data["corners"], 14)
        self.assertEqual(data["race_laps"], 70)
        self.assertEqual(data["first_grand_prix"], 1986)

    def test_fields_this_app_does_not_hold_are_null_and_explained(self):
        data = self.assertBundle(run(circuits.get_circuit_profile("hungaroring", db=full_db())))

        self.assertIsNone(data["length_km"])
        self.assertIsNone(data["elevation_change_m"])
        self.assertIn("elevation", data["not_held"])

    def test_the_3d_geometry_build_state_is_reported(self):
        data = self.assertBundle(run(circuits.get_circuit_profile("hungaroring", db=full_db())))

        self.assertIs(data["track_geometry_built"], True)

        unbuilt = self.assertBundle(
            run(circuits.get_circuit_profile("spa", db=full_db()))
        )
        self.assertIs(unbuilt["track_geometry_built"], False)

    def test_an_unknown_circuit_is_unavailable(self):
        self.assertUnavailable(run(circuits.get_circuit_profile("nurburgring", db=full_db())))


class CircuitHistoryTests(BundleAssertions):
    def test_wins_are_tallied_rather_than_left_to_the_model(self):
        data = self.assertBundle(
            run(circuits.get_circuit_history("monza", db=full_db())),
            "mongo:historical_race_index/monza",
        )

        self.assertEqual(data["races_held"], 6)
        self.assertEqual(data["first_season"], 1963)
        self.assertEqual(data["last_season"], 1978)
        by_constructor = {t["name"]: t["wins"] for t in data["grand_prix_wins_by_constructor"]}
        self.assertEqual(by_constructor["Lotus"], 2)

    def test_the_indy_500_is_tallied_apart_from_grand_prix_wins(self):
        data = self.assertBundle(run(circuits.get_circuit_history("indianapolis", db=full_db())))

        self.assertEqual(data["races_held"], 2)
        self.assertEqual(data["indy500_rounds"], 1)
        self.assertEqual(
            [t["name"] for t in data["grand_prix_wins_by_driver"]], ["Michael Schumacher"]
        )
        self.assertEqual([t["name"] for t in data["indy500_wins_by_driver"]], ["Bob Sweikert"])
        self.assertIn("never be presented as Grand Prix wins", data["indy500_note"])

    def test_the_closest_finish_is_enriched_from_the_ergast_cache(self):
        data = self.assertBundle(run(circuits.get_circuit_history("hungaroring", db=full_db(
            historical_race_index=[
                {"season": 2020, "round": 3, "race_name": "Hungarian Grand Prix",
                 "circuit_id": "hungaroring", "driver": "Lewis Hamilton",
                 "constructor_key": "mercedes", "constructor_name": "Mercedes",
                 "indy500": False}
            ]
        ))))

        self.assertEqual(data["closest_finish"]["gap_seconds"], 0.288)

    def test_a_circuit_absent_from_the_index_is_unavailable(self):
        self.assertUnavailable(run(circuits.get_circuit_history("spa", db=full_db())))


# --------------------------------------------------------------------------
# history tools
# --------------------------------------------------------------------------


class HistoricalIndexTests(BundleAssertions):
    def test_it_tallies_rather_than_returning_the_index(self):
        data = self.assertBundle(
            run(history.get_historical_race_index(db=full_db())),
            "mongo:historical_race_index",
        )

        self.assertEqual(data["races_matched"], 8)
        self.assertLessEqual(len(data["sample"]), history.SAMPLE_LIMIT)
        self.assertEqual(data["wins_by_constructor"][0]["name"], "Ferrari")

    def test_a_season_range_filters(self):
        data = self.assertBundle(
            run(history.get_historical_race_index(season_from=1960, season_to=1969, db=full_db()))
        )

        self.assertEqual(data["races_matched"], 4)
        self.assertEqual(data["season_range"], [1963, 1968])

    def test_a_circuit_filter_combines_with_a_season_range(self):
        data = self.assertBundle(
            run(history.get_historical_race_index(
                circuit_id="monza", season_from=1966, db=full_db()
            ))
        )

        self.assertEqual(data["races_matched"], 4)

    def test_a_raw_chassis_era_constructor_id_is_normalised_to_its_lineage(self):
        """`team_lotus` and `lotus-ford` are the same team; two small wrong
        numbers is exactly what querying Ergast directly would produce."""
        merged = self.assertBundle(
            run(history.get_historical_race_index(constructor_key="team_lotus", db=full_db()))
        )
        canonical = self.assertBundle(
            run(history.get_historical_race_index(constructor_key="lotus", db=full_db()))
        )

        self.assertEqual(merged["races_matched"], 2)
        self.assertEqual(merged["races_matched"], canonical["races_matched"])

    def test_a_driver_filter_is_a_case_insensitive_substring(self):
        data = self.assertBundle(
            run(history.get_historical_race_index(driver="clark", db=full_db()))
        )

        self.assertEqual(data["races_matched"], 1)

    def test_the_indy_500_count_is_stated_alongside_the_tally(self):
        data = self.assertBundle(run(history.get_historical_race_index(db=full_db())))

        self.assertEqual(data["indy500_races_included"], 1)

    def test_filters_that_match_nothing_are_unavailable_and_echo_the_filters(self):
        result = self.assertUnavailable(
            run(history.get_historical_race_index(circuit_id="suzuka", db=full_db()))
        )

        self.assertEqual(result["filters"]["circuit_id"], "suzuka")


class ConstructorSeasonsTests(BundleAssertions):
    def test_active_seasons_and_winning_seasons_are_reported_separately(self):
        data = self.assertBundle(
            run(history.get_constructor_seasons("team_lotus", db=full_db())),
            "mongo:constructor_seasons_cache/team_lotus",
        )

        self.assertEqual(data["canonical_key"], "lotus")
        self.assertEqual(data["active_seasons"], [1958, 1959, 1960, 1961, 1962, 1963])
        self.assertEqual(data["winning_seasons"], [1963, 1967])
        self.assertEqual(data["wins"], 2)

    def test_an_uncached_season_list_is_flagged_without_claiming_the_team_never_raced(self):
        data = self.assertBundle(
            run(history.get_constructor_seasons("ferrari", db=full_db()))
        )

        self.assertEqual(data["active_seasons"], [])
        self.assertIs(data["active_seasons_available"], False)
        self.assertEqual(data["wins"], 2)

    def test_the_lotus_f1_trap_is_stated_on_the_bundle(self):
        data = self.assertBundle(run(history.get_constructor_seasons("team_lotus", db=full_db())))

        self.assertIn("lotus_f1 is NOT", data["genealogy_note"])

    def test_an_unknown_constructor_is_unavailable(self):
        self.assertUnavailable(run(history.get_constructor_seasons("delage", db=full_db())))


# --------------------------------------------------------------------------
# context tools
# --------------------------------------------------------------------------


class ResolveContextToolTests(BundleAssertions):
    def test_it_resolves_the_last_race_against_the_synced_calendar(self):
        data = self.assertBundle(
            run(context.resolve_context("the last race", today="2026-08-05", db=full_db()))
        )

        self.assertEqual(data["race"]["value"]["round"], 13)
        self.assertFalse(data["ambiguous"])

    def test_the_roster_is_scoped_to_the_season_the_hint_points_at(self):
        data = self.assertBundle(
            run(context.resolve_context("how did Max do in the last race",
                                        today="2026-08-05", db=full_db()))
        )

        self.assertEqual(data["roster_season"], 2026)
        self.assertEqual(data["driver"]["value"], "max_verstappen")

    def test_an_ambiguity_is_reported_with_candidates(self):
        data = self.assertBundle(
            run(context.resolve_context("how did Kimi do", today="2026-08-05", db=full_db()))
        )

        # Antonelli is the only Kimi on this roster, so this must NOT be a tie —
        # era-scoping the roster is what makes that true.
        self.assertTrue(data["driver"]["resolved"])
        self.assertEqual(data["driver"]["value"], "antonelli")

    def test_a_bad_date_is_reported_rather_than_ignored(self):
        self.assertUnavailable(
            run(context.resolve_context("the last race", today="not-a-date", db=full_db()))
        )

    def test_an_empty_hint_is_unavailable(self):
        self.assertUnavailable(run(context.resolve_context("  ", db=full_db())))

    def test_an_unsynced_calendar_is_unavailable(self):
        self.assertUnavailable(
            run(context.resolve_context("the last race", db=full_db(races=[])))
        )


class SeasonStateToolTests(BundleAssertions):
    def test_it_returns_the_clock_beside_the_calendar(self):
        data = self.assertBundle(
            run(context.get_season_state(today="2026-08-05", db=full_db()))
        )

        self.assertEqual(data["today"], "2026-08-05")
        self.assertEqual(data["last_race"]["round"], 13)
        self.assertEqual(data["next_race"]["round"], 14)

    def test_a_bad_date_is_unavailable(self):
        self.assertUnavailable(run(context.get_season_state(today="2026-13-45", db=full_db())))


if __name__ == "__main__":
    unittest.main()
