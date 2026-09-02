import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.radio_segments import WORD_GAP_S, split_segments


def word(text, start, end):
    return {"word": text, "start": start, "end": end}


def segment(start, end, text):
    return {"start": start, "end": end, "text": text}


class SharedSpanTests(unittest.TestCase):
    """Both attribution approaches must be handed the SAME spans.

    Approach B re-split at word gaps and gained from it; approach A read
    Whisper's raw segments. Any margin between them therefore mixed "reasons
    better" with "was given better input", which `TEAM-RADIO-PLAN.md` §5.5's
    decision rule cannot survive.
    """

    def test_a_handover_pause_inside_one_segment_becomes_two_spans(self):
        transcript = {
            "segments": [segment(0.0, 6.0, "Lando how are the tyres I'm pace zero")],
            "words": [
                word(" Lando", 0.0, 0.5),
                word(" how", 0.5, 0.8),
                word(" are", 0.8, 1.0),
                word(" the", 1.0, 1.2),
                word(" tyres", 1.2, 1.6),
                word(" I'm", 3.0, 3.3),
                word(" pace", 3.3, 3.6),
                word(" zero", 3.6, 4.0),
            ],
        }

        pieces = split_segments(transcript)

        self.assertEqual(len(pieces), 2)
        self.assertIn("Lando", pieces[0]["text"])
        self.assertIn("pace", pieces[1]["text"])

    def test_the_first_word_of_every_span_survives(self):
        """The word that decides the label is the one most easily lost.

        The pairwise walk over word timings starts at the second word, so the
        first piece has to be seeded with the first. "Lando," is a vocative and
        means the pit wall is speaking; "I" is first person and means the driver
        is. Dropping either inverts the answer.
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

        pieces = split_segments(transcript)

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

        self.assertEqual(len(split_segments(transcript)), 1)

    def test_no_word_timings_falls_back_to_raw_segments(self):
        transcript = {"segments": [segment(0, 3, "one"), segment(3, 6, "two")], "words": []}

        self.assertEqual([p["text"] for p in split_segments(transcript)], ["one", "two"])

    def test_a_segment_without_timings_passes_through(self):
        transcript = {
            "segments": [{"start": None, "end": None, "text": "no timings"}],
            "words": [word(" no", 0.0, 0.4)],
        }

        self.assertEqual(split_segments(transcript)[0]["text"], "no timings")


if __name__ == "__main__":
    unittest.main()
