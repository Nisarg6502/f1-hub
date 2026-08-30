import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import radio_diarize
from app.radio_diarize import (
    SPLIT_DISTANCE,
    WORD_GAP_S,
    _segments_for_diarization,
    _split,
    summarise,
)


def word(text, start, end):
    return {"word": text, "start": start, "end": end}


def segment(start, end, text):
    return {"start": start, "end": end, "text": text}


class SegmentSplittingTests(unittest.TestCase):
    """Whisper under-segments, and diarization can only separate what it is given.

    Measured on the 2026 Dutch GP: clips carrying an obvious two-way exchange
    arrived as one segment, so approach B reported "single voice" for reasons
    that had nothing to do with the audio.
    """

    def test_a_long_pause_inside_one_segment_becomes_two(self):
        transcript = {
            "segments": [segment(0.0, 6.0, "Lando how are the tyres I'm pace zero")],
            "words": [
                word(" Lando", 0.0, 0.5),
                word(" how", 0.5, 0.8),
                word(" are", 0.8, 1.0),
                word(" the", 1.0, 1.2),
                word(" tyres", 1.2, 1.6),
                # The handover.
                word(" I'm", 3.0, 3.3),
                word(" pace", 3.3, 3.6),
                word(" zero", 3.6, 4.0),
            ],
        }

        pieces = _segments_for_diarization(transcript)

        self.assertEqual(len(pieces), 2)
        self.assertIn("Lando", pieces[0]["text"])
        self.assertIn("pace", pieces[1]["text"])

    def test_the_first_word_of_every_turn_survives(self):
        """The bug this test exists for.

        The pairwise walk over words starts at the second one, so seeding the
        first piece with the first word is what stops the opening word being
        dropped. On this material that word decides the label: "Lando," is a
        vocative (so the speaker is the pit wall) and "I" is first person (so it
        is the driver). Losing it inverts the answer.
        """
        transcript = {
            "segments": [segment(0.0, 4.0, "Lando box this lap I copy that")],
            "words": [
                word(" Lando", 0.0, 0.4),
                word(" box", 0.4, 0.7),
                word(" this", 0.7, 0.9),
                word(" lap", 0.9, 1.2),
                word(" I", 2.5, 2.7),
                word(" copy", 2.7, 3.0),
                word(" that", 3.0, 3.3),
            ],
        }

        pieces = _segments_for_diarization(transcript)

        self.assertTrue(pieces[0]["text"].startswith("Lando"), pieces[0]["text"])
        self.assertTrue(pieces[1]["text"].startswith("I"), pieces[1]["text"])

    def test_short_gaps_are_breaths_and_do_not_split(self):
        gap = WORD_GAP_S / 2
        transcript = {
            "segments": [segment(0.0, 3.0, "box box box")],
            "words": [
                word(" box", 0.0, 0.4),
                word(" box", 0.4 + gap, 0.9),
                word(" box", 0.9 + gap, 1.4),
            ],
        }

        self.assertEqual(len(_segments_for_diarization(transcript)), 1)

    def test_a_transcript_with_no_word_timings_falls_back_to_raw_segments(self):
        """A lower ceiling on what diarization can find — not a failure."""
        transcript = {"segments": [segment(0.0, 3.0, "one"), segment(3.0, 6.0, "two")], "words": []}

        pieces = _segments_for_diarization(transcript)

        self.assertEqual([p["text"] for p in pieces], ["one", "two"])

    def test_a_segment_with_no_timings_is_passed_through_untouched(self):
        transcript = {
            "segments": [{"start": None, "end": None, "text": "no timings"}],
            "words": [word(" no", 0.0, 0.4)],
        }

        self.assertEqual(_segments_for_diarization(transcript)[0]["text"], "no timings")

    def test_empty_pieces_are_dropped_rather_than_emitted(self):
        transcript = {
            "segments": [segment(0.0, 2.0, "hello")],
            "words": [word(" hello", 0.0, 0.5)],
        }

        pieces = _segments_for_diarization(transcript)

        self.assertTrue(all(p["text"].strip() for p in pieces))


class ClusterTests(unittest.TestCase):
    """`_split` decides between one voice and two — never more, never zero."""

    @staticmethod
    def unit(*values):
        import math

        norm = math.sqrt(sum(v * v for v in values))
        return _Vec([v / norm for v in values])

    def test_similar_voices_stay_one_speaker(self):
        a = self.unit(1.0, 0.02)
        b = self.unit(1.0, 0.04)

        self.assertEqual(_split([a, b]), [0, 0])

    def test_distant_voices_become_two_speakers(self):
        a = self.unit(1.0, 0.0)
        b = self.unit(-1.0, 0.05)

        self.assertEqual(sorted(set(_split([a, b]))), [0, 1])

    def test_the_split_does_not_depend_on_who_speaks_first(self):
        """Seeded from the furthest-apart pair, not from the first two."""
        a = self.unit(1.0, 0.0)
        b = self.unit(-1.0, 0.05)
        forward = _split([a, a, b, b])
        backward = _split([b, b, a, a])

        self.assertEqual(len(set(forward)), 2)
        self.assertEqual(len(set(backward)), 2)
        # Same grouping, whichever order the voices arrive in.
        self.assertEqual(forward[0] == forward[2], backward[0] == backward[2])

    def test_a_segment_too_short_to_embed_inherits_its_neighbour(self):
        """A noisy embedding is worse than none — it drags a cluster with it."""
        a = self.unit(1.0, 0.0)
        b = self.unit(-1.0, 0.05)

        speakers = _split([a, None, b])

        self.assertEqual(speakers[1], speakers[0])

    def test_fewer_than_two_usable_embeddings_is_one_speaker(self):
        self.assertEqual(_split([None, None]), [0, 0])
        self.assertEqual(_split([self.unit(1.0, 0.0), None]), [0, 0])

    def test_the_threshold_is_the_documented_one(self):
        """A guard on the calibrated value, so a casual edit is visible."""
        self.assertAlmostEqual(SPLIT_DISTANCE, 0.85)


class _Vec(list):
    """A minimal stand-in for the numpy vectors `_split` multiplies.

    `_distance` only needs elementwise multiply and `.sum()`, so the tests avoid
    importing numpy — which matters here, because this module's whole reason for
    living in its own process is that its numerical stack conflicts with
    CTranslate2's.
    """

    def __mul__(self, other):
        return _Vec(a * b for a, b in zip(self, other))

    def sum(self):
        return sum(self)


class TurnMergingTests(unittest.TestCase):
    def test_consecutive_segments_from_one_voice_merge_into_a_turn(self):
        transcript = {
            "segments": [segment(0.0, 1.0, "box"), segment(1.0, 2.0, "box box"), segment(2.5, 4.0, "copy")],
            "words": [],
        }

        with patch.object(radio_diarize, "_load_model", return_value=object()), patch.object(
            radio_diarize, "_decode", return_value=[0.0]
        ), patch.object(radio_diarize, "_embed", return_value=[None, None, None]), patch.object(
            radio_diarize, "_split", return_value=[0, 0, 1]
        ), patch.object(
            radio_diarize.httpx, "get", return_value=_Response()
        ):
            turns = radio_diarize.diarize("https://x/a.mp3", transcript)

        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["text"], "box box box")
        self.assertEqual(turns[0]["end"], 2.0)

    def test_one_turn_returns_nothing_so_approach_a_takes_over_honestly(self):
        """Returning a single turn would make approach B look like it worked."""
        transcript = {"segments": [segment(0.0, 1.0, "a"), segment(1.0, 2.0, "b")], "words": []}

        with patch.object(radio_diarize, "_load_model", return_value=object()), patch.object(
            radio_diarize, "_decode", return_value=[0.0]
        ), patch.object(radio_diarize, "_embed", return_value=[None, None]), patch.object(
            radio_diarize, "_split", return_value=[0, 0]
        ), patch.object(
            radio_diarize.httpx, "get", return_value=_Response()
        ):
            self.assertEqual(radio_diarize.diarize("https://x/a.mp3", transcript), [])

    def test_a_single_segment_clip_never_reaches_the_model(self):
        def explode(*args, **kwargs):
            raise AssertionError("the model must not load for a one-segment clip")

        with patch.object(radio_diarize, "_load_model", side_effect=explode):
            self.assertEqual(
                radio_diarize.diarize("https://x/a.mp3", {"segments": [segment(0, 1, "a")], "words": []}),
                [],
            )


class _Response:
    status_code = 200
    content = b"audio"


class SummaryTests(unittest.TestCase):
    def test_no_turns_reads_as_a_single_voice(self):
        self.assertEqual(summarise([]), "single voice")

    def test_two_voices_are_counted_not_assumed(self):
        turns = [{"speaker": 0}, {"speaker": 1}, {"speaker": 0}]

        self.assertEqual(summarise(turns), "2 voices, 3 turns")


if __name__ == "__main__":
    unittest.main()
