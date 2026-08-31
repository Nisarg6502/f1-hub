import sys
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.radio_clips import (
    RadioSourceUnavailable,
    annotate_durations,
    clip_id,
    fetch_clips,
    livetiming_session_base,
)

SESSION_KEY = 11353
MEETING_BASE = "https://livetiming.formula1.com/static/2026/2026-08-23_Dutch_Grand_Prix"
SESSION_BASE = f"{MEETING_BASE}/2026-08-23_Race"

OPENF1_ROWS = [
    {
        "meeting_key": 1292,
        "session_key": SESSION_KEY,
        "driver_number": 63,
        "date": "2026-08-23T13:34:31.961000+00:00",
        "recording_url": f"{SESSION_BASE}/TeamRadio/RUS_63_20260823_153426.mp3",
    },
    {
        "meeting_key": 1292,
        "session_key": SESSION_KEY,
        "driver_number": 87,
        "date": "2026-08-23T12:19:56.920000+00:00",
        "recording_url": f"{SESSION_BASE}/TeamRadio/BEA_87_20260823_141940.mp3",
    },
]

LIVETIMING_BODY = {
    "Captures": [
        {
            "Utc": "2026-08-23T12:19:56.92Z",
            "RacingNumber": "87",
            "Path": "TeamRadio/BEA_87_20260823_141940.mp3",
        },
        {
            "Utc": "2026-08-23T12:22:28.7046889Z",
            "RacingNumber": "87",
            "Path": "TeamRadio/BEA_87_20260823_142210.mp3",
        },
    ]
}


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def json_response(payload, *, bom=False):
    body = httpx.Response(200, json=payload).content
    if bom:
        return httpx.Response(200, content=b"\xef\xbb\xbf" + body)
    return httpx.Response(200, content=body)


class OpenF1Tests(unittest.TestCase):
    def test_clips_come_back_sorted_by_time_with_stable_ids(self):
        def handler(request):
            return json_response(OPENF1_ROWS)

        result = fetch_clips(SESSION_KEY, client=client_for(handler))

        self.assertEqual(result["source"], "openf1")
        self.assertEqual([c["driver_number"] for c in result["clips"]], [87, 63])
        self.assertEqual(
            result["clips"][0]["id"],
            clip_id(SESSION_KEY, 87, "2026-08-23T12:19:56.920000+00:00"),
        )

    def test_rows_missing_a_required_field_are_dropped_not_fatal(self):
        def handler(request):
            return json_response([{"driver_number": 63, "date": None, "recording_url": None}])

        result = fetch_clips(SESSION_KEY, client=client_for(handler))

        self.assertEqual(result["clips"], [])
        self.assertIsNone(result["source"])


class AbsenceTests(unittest.TestCase):
    """F1 published nothing for the first eight 2026 race/sprint sessions.

    That has to cache as a real answer, or every view of those rounds retries an
    upstream that will keep saying no.
    """

    def test_a_404_is_no_radio_not_an_error(self):
        def handler(request):
            return httpx.Response(404, json={"detail": "No results found."})

        result = fetch_clips(SESSION_KEY, client=client_for(handler))

        self.assertEqual(result["clips"], [])
        self.assertIsNone(result["source"])

    def test_an_empty_200_is_also_no_radio(self):
        def handler(request):
            return json_response([])

        result = fetch_clips(SESSION_KEY, client=client_for(handler))

        self.assertEqual(result["clips"], [])
        self.assertIsNone(result["source"])

    def test_a_403_from_the_f1_origin_counts_as_absent(self):
        """F1's CloudFront answers a missing key with 403, not 404.

        Measured: the 2026 Australian GP race session serves `Index.json` with
        200 and `TeamRadio.json` with 403.
        """

        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(404, json={"detail": "No results found."})
            return httpx.Response(403, text="<Error>AccessDenied</Error>")

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))

        self.assertEqual(result["clips"], [])
        self.assertIsNone(result["source"])


class TransportFailureTests(unittest.TestCase):
    """A rate-limit must never be cached as "this race had no radio".

    Measured: the 2026 British GP read as zero clips on one scan and 20 on the
    next, purely from OpenF1 rate-limiting.
    """

    def test_an_unreachable_upstream_raises_rather_than_returning_empty(self):
        def handler(request):
            raise httpx.ConnectError("boom", request=request)

        with self.assertRaises(RadioSourceUnavailable):
            fetch_clips(SESSION_KEY, client=client_for(handler))

    def test_a_500_raises_rather_than_returning_empty(self):
        def handler(request):
            return httpx.Response(500, text="upstream is unwell")

        with self.assertRaises(RadioSourceUnavailable):
            fetch_clips(SESSION_KEY, client=client_for(handler))

    def test_a_failed_primary_with_a_working_fallback_does_not_raise(self):
        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(429, text="slow down")
            return json_response(LIVETIMING_BODY, bom=True)

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))

        self.assertEqual(result["source"], "livetiming")
        self.assertEqual(len(result["clips"]), 2)


class LivetimingFallbackTests(unittest.TestCase):
    def test_the_bom_prefixed_body_f1_serves_is_parsed(self):
        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(404, json={"detail": "No results found."})
            return json_response(LIVETIMING_BODY, bom=True)

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))

        self.assertEqual(result["source"], "livetiming")
        self.assertEqual(result["clips"][0]["driver_number"], 87)

    def test_livetiming_timestamps_are_normalised_to_the_openf1_form(self):
        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(404, json={"detail": "No results found."})
            return json_response(LIVETIMING_BODY, bom=True)

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))
        dates = [clip["date"] for clip in result["clips"]]

        self.assertTrue(all(date.endswith("+00:00") for date in dates), dates)

    def test_seven_fractional_digits_do_not_break_parsing(self):
        """Livetiming emits `.7046889`; Python's ISO parser accepts six."""

        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(404, json={"detail": "No results found."})
            return json_response(LIVETIMING_BODY, bom=True)

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))

        self.assertIn("2026-08-23T12:22:28", result["clips"][1]["date"])

    def test_the_capture_dict_shape_from_the_stream_file_is_handled(self):
        body = {"Captures": {"0": LIVETIMING_BODY["Captures"][0]}}

        def handler(request):
            if "openf1" in str(request.url):
                return httpx.Response(404, json={"detail": "No results found."})
            return json_response(body)

        result = fetch_clips(SESSION_KEY, livetiming_base=SESSION_BASE, client=client_for(handler))

        self.assertEqual(len(result["clips"]), 1)


class SessionBaseTests(unittest.TestCase):
    def test_a_sibling_sessions_url_yields_this_sessions_folder(self):
        sibling = f"{MEETING_BASE}/2026-03-06_Practice_2/TeamRadio/HAM_44_x.mp3"

        base = livetiming_session_base(sibling, "2026-03-08", "Race")

        self.assertEqual(base, f"{MEETING_BASE}/2026-03-08_Race")

    def test_multiword_session_names_become_underscored(self):
        sibling = f"{MEETING_BASE}/2026-03-06_Practice_2/TeamRadio/HAM_44_x.mp3"

        base = livetiming_session_base(sibling, "2026-03-07", "Sprint Qualifying")

        self.assertTrue(base.endswith("2026-03-07_Sprint_Qualifying"))

    def test_an_unexpected_url_shape_returns_none_rather_than_guessing(self):
        self.assertIsNone(livetiming_session_base("https://example.com/x.mp3", "2026-03-08", "Race"))
        self.assertIsNone(livetiming_session_base("", "2026-03-08", "Race"))


class DurationTests(unittest.TestCase):
    def test_content_length_becomes_seconds_at_128kbps(self):
        def handler(request):
            return httpx.Response(200, headers={"Content-Length": "144000"})

        clips = annotate_durations([{"url": "https://livetiming.formula1.com/a.mp3", "duration_s": None}], client_for(handler))

        # ffprobe reports 8.976s for this exact file.
        self.assertEqual(clips[0]["duration_s"], 9.0)

    def test_a_clip_with_no_content_length_keeps_a_null_duration(self):
        def handler(request):
            return httpx.Response(200)

        clips = annotate_durations([{"url": "https://livetiming.formula1.com/a.mp3", "duration_s": None}], client_for(handler))

        self.assertIsNone(clips[0]["duration_s"])

    def test_a_head_failure_does_not_abort_the_remaining_clips(self):
        def handler(request):
            if request.url.path.endswith("bad"):
                raise httpx.ConnectError("boom", request=request)
            return httpx.Response(200, headers={"Content-Length": "32000"})

        clips = annotate_durations(
            [
                {"url": "https://x/bad", "duration_s": None},
                {"url": "https://x/good", "duration_s": None},
            ],
            client_for(handler),
        )

        self.assertIsNone(clips[0]["duration_s"])
        self.assertEqual(clips[1]["duration_s"], 2.0)

    def test_an_already_measured_clip_is_not_re_fetched(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(200, headers={"Content-Length": "16000"})

        annotate_durations([{"url": "https://livetiming.formula1.com/a.mp3", "duration_s": 4.2}], client_for(handler))

        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
