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


class FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _http_error(code: int):
    from urllib.error import HTTPError

    return HTTPError("http://example.test", code, "boom", {}, None)


class FetchRetryTests(unittest.TestCase):
    """Jolpica rate-limits bursts; a 429 must not read as 'no data'."""

    def test_retries_a_rate_limited_request_until_it_succeeds(self):
        attempts = [_http_error(429), _http_error(429), FakeResponse({"MRData": {"total": "7"}})]

        def urlopen(request, timeout=None):
            result = attempts.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with patch.object(driver_bio, "urlopen", side_effect=urlopen), \
             patch.object(driver_bio.time, "sleep"):
            data = driver_bio._fetch_json("http://example.test")

        self.assertEqual(data["MRData"]["total"], "7")
        self.assertEqual(attempts, [])

    def test_raises_rather_than_returning_none_when_rate_limiting_persists(self):
        with patch.object(driver_bio, "urlopen", side_effect=lambda *a, **k: (_ for _ in ()).throw(_http_error(429))), \
             patch.object(driver_bio.time, "sleep"):
            with self.assertRaises(driver_bio.FetchError):
                driver_bio._fetch_json("http://example.test")

    def test_does_not_retry_a_client_error(self):
        calls = []

        def urlopen(request, timeout=None):
            calls.append(request)
            raise _http_error(404)

        with patch.object(driver_bio, "urlopen", side_effect=urlopen), \
             patch.object(driver_bio.time, "sleep"):
            with self.assertRaises(driver_bio.FetchError):
                driver_bio._fetch_json("http://example.test")

        self.assertEqual(len(calls), 1)


class PartialFailureTests(unittest.TestCase):
    """Regression: Hamilton's 7 titles were served (and cached) as 3.

    Every stat here is a count, so a request that fails is indistinguishable
    from a season the driver didn't win unless the failure propagates.
    """

    def _fetch_with_one_failing_season(self, url, timeout=15):
        if "/2023/drivers/max_verstappen/driverstandings.json" in url:
            raise driver_bio.FetchError("HTTP 429")
        return _fake_fetch_json(url, timeout)

    def test_a_rate_limited_season_never_undercounts_a_cached_championship_total(self):
        stale_time = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)
        stale = FakeCollection({
            "driverId": "max_verstappen",
            "givenName": "Max",
            "championships": 2,
            "wins": 71,
            "synced_at": stale_time.isoformat(),
        })
        fake_db = FakeDb(driver_bios=stale)

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=self._fetch_with_one_failing_season):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="max_verstappen"))

        body = json.loads(response.body)
        # The whole point: 2, not the 1 a partial count would have produced.
        self.assertEqual(body["championships"], 2)
        self.assertIsNone(stale.update, "a partial rebuild must never be cached")

    def test_reports_unavailable_rather_than_inventing_totals_with_no_cache(self):
        fake_db = FakeDb()

        with patch.object(driver_bio, "get_db", return_value=fake_db), \
             patch.object(driver_bio, "_fetch_json", side_effect=self._fetch_with_one_failing_season):
            response = asyncio.run(driver_bio.get_driver_bio(driver_id="max_verstappen"))

        self.assertEqual(response.status_code, 503)
        self.assertIsNone(fake_db.driver_bios.update)

    def test_concurrency_is_capped_below_jolpicas_burst_limit(self):
        # 20+ simultaneous season lookups are what triggered the 429s.
        self.assertLessEqual(driver_bio.MAX_CONCURRENT_REQUESTS, 5)


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
