import asyncio
import datetime
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# driver_bio imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import driver_bio


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, driver_bios=None):
        self.driver_bios = driver_bios or FakeCollection()


def _fake_fetch_json(url: str, timeout: int = 15):
    if url == f"{driver_bio.ERGAST_BASE}/drivers/max_verstappen.json":
        return {"MRData": {"DriverTable": {"Drivers": [{
            "driverId": "max_verstappen",
            "code": "VER",
            "permanentNumber": "3",
            "givenName": "Max",
            "familyName": "Verstappen",
            "dateOfBirth": "1997-09-30",
            "nationality": "Dutch",
            "url": "http://en.wikipedia.org/wiki/Max_Verstappen",
        }]}}}
    if "/drivers/max_verstappen/results/1.json" in url:
        return {"MRData": {"total": "71"}}
    if "/drivers/max_verstappen/results/2.json" in url:
        return {"MRData": {"total": "38"}}
    if "/drivers/max_verstappen/results/3.json" in url:
        return {"MRData": {"total": "21"}}
    if "/drivers/max_verstappen/qualifying/1.json" in url:
        return {"MRData": {"total": "64"}}
    if "/drivers/max_verstappen/seasons.json" in url:
        return {"MRData": {"SeasonTable": {"Seasons": [{"season": "2022"}, {"season": "2023"}]}}}
    if "/2022/drivers/max_verstappen/driverstandings.json" in url:
        return {"MRData": {"StandingsTable": {"StandingsLists": [
            {"DriverStandings": [{"position": "1"}]}
        ]}}}
    if "/2023/drivers/max_verstappen/driverstandings.json" in url:
        return {"MRData": {"StandingsTable": {"StandingsLists": [
            {"DriverStandings": [{"position": "1"}]}
        ]}}}
    # An id Ergast has never heard of.
    if "unknown_driver" in url:
        return {"MRData": {"DriverTable": {"Drivers": []}, "total": "0"}}
    return None


class DriverBioCacheHitTests(unittest.TestCase):
    def test_serves_a_fresh_cache_without_calling_ergast(self):
        fresh = FakeCollection({
            "driverId": "max_verstappen",
            "givenName": "Max",
            "familyName": "Verstappen",
            "wins": 71,
            "podiums": 130,
            "poles": 64,
            "championships": 2,
            "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        fake_db = FakeDb(driver_bios=fresh)

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json") as fetch:
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="max_verstappen"))

        fetch.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["championships"], 2)
        self.assertNotIn("synced_at", body)

    def test_refetches_a_stale_cache(self):
        stale_time = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)
        stale = FakeCollection({
            "driverId": "max_verstappen",
            "wins": 1,
            "synced_at": stale_time.isoformat(),
        })
        fake_db = FakeDb(driver_bios=stale)

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=_fake_fetch_json):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="max_verstappen"))

        body = json.loads(response.body)
        self.assertEqual(body["wins"], 71)
        self.assertTrue(stale.update["upsert"])


class DriverBioCacheMissTests(unittest.TestCase):
    def test_builds_and_caches_full_career_stats(self):
        fake_db = FakeDb()

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=_fake_fetch_json):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="max_verstappen"))

        body = json.loads(response.body)
        self.assertEqual(body["wins"], 71)
        self.assertEqual(body["podiums"], 71 + 38 + 21)
        self.assertEqual(body["poles"], 64)
        self.assertEqual(body["championships"], 2)
        self.assertEqual(body["nationality"], "Dutch")
        self.assertEqual(body["wikiUrl"], "http://en.wikipedia.org/wiki/Max_Verstappen")
        self.assertNotIn("synced_at", body)

        self.assertTrue(fake_db.driver_bios.update["upsert"])
        written = fake_db.driver_bios.update["update"]["$set"]
        self.assertEqual(written["driverId"], "max_verstappen")
        self.assertEqual(written["championships"], 2)
        self.assertIn("synced_at", written)

    def test_unknown_driver_returns_a_near_empty_shape_without_caching(self):
        fake_db = FakeDb()

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=_fake_fetch_json):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="unknown_driver"))

        body = json.loads(response.body)
        self.assertEqual(body["driverId"], "unknown_driver")
        self.assertEqual(body["wins"], 0)
        self.assertIsNone(fake_db.driver_bios.update)

    def test_falls_back_to_a_stale_cache_when_ergast_has_nothing_this_time(self):
        stale_time = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)
        stale = FakeCollection({
            "driverId": "unknown_driver",
            "givenName": "Cached",
            "wins": 5,
            "synced_at": stale_time.isoformat(),
        })
        fake_db = FakeDb(driver_bios=stale)

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=_fake_fetch_json):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="unknown_driver"))

        body = json.loads(response.body)
        self.assertEqual(body["givenName"], "Cached")
        self.assertEqual(body["wins"], 5)
        self.assertIsNone(stale.update)


class MrdataTotalTests(unittest.TestCase):
    def test_reads_the_total_field(self):
        self.assertEqual(driver_bio._mrdata_total({"MRData": {"total": "71"}}), 71)

    def test_missing_data_is_zero(self):
        self.assertEqual(driver_bio._mrdata_total(None), 0)

    def test_malformed_total_is_zero(self):
        self.assertEqual(driver_bio._mrdata_total({"MRData": {"total": "not-a-number"}}), 0)


class IsStaleTests(unittest.TestCase):
    def test_missing_synced_at_is_stale(self):
        self.assertTrue(driver_bio._is_stale({}))

    def test_recent_doc_is_fresh(self):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.assertFalse(driver_bio._is_stale({"synced_at": now}))

    def test_old_doc_is_stale(self):
        old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)).isoformat()
        self.assertTrue(driver_bio._is_stale({"synced_at": old}))


if __name__ == "__main__":
    unittest.main()
