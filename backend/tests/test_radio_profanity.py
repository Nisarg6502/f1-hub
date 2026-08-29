import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.radio_profanity import MASK, mask, mask_utterances


class MaskingTests(unittest.TestCase):
    def test_a_strong_word_becomes_exactly_three_asterisks(self):
        masked, found = mask("that was fucking dangerous")

        self.assertEqual(masked, "that was *** dangerous")
        self.assertTrue(found)

    def test_the_mask_length_does_not_leak_the_word_length(self):
        short, _ = mask("shit")
        long, _ = mask("motherfucker")

        self.assertEqual(short, MASK)
        self.assertEqual(long, MASK)

    def test_inflections_of_a_stem_are_caught(self):
        for phrase in ("he fucked me", "fucking hell", "what a wanker", "pissed off"):
            with self.subTest(phrase=phrase):
                _, found = mask(phrase)
                self.assertTrue(found, phrase)

    def test_clean_text_is_returned_unchanged_and_unflagged(self):
        text = "box this lap, box box box"

        masked, found = mask(text)

        self.assertEqual(masked, text)
        self.assertFalse(found)

    def test_none_and_empty_do_not_raise(self):
        self.assertEqual(mask(None), ("", False))
        self.assertEqual(mask(""), ("", False))


class ScunthorpeTests(unittest.TestCase):
    """The words that break substring-matching filters.

    Every one of these appears, or plausibly appears, in real race radio. A
    filter that masks "assist" is worse than no filter — it corrupts the pit
    wall's actual instructions.
    """

    def test_words_containing_a_stem_are_not_masked(self):
        for word in (
            "Scunthorpe",
            "assist",
            "assists",
            "class",
            "pass",
            "grass",
            "compass",
            "analysis",
            "cockpit",
            "massive",
            "title",
            "assembly",
        ):
            with self.subTest(word=word):
                masked, found = mask(f"the {word} is fine")
                self.assertEqual(masked, f"the {word} is fine")
                self.assertFalse(found)

    def test_a_real_pit_instruction_survives_intact(self):
        text = "we need you to assist with the pass, keep the delta positive"

        masked, found = mask(text)

        self.assertEqual(masked, text)
        self.assertFalse(found)


class MildLanguageTests(unittest.TestCase):
    """Mild words are deliberately left alone — see the module docstring."""

    def test_mild_frustration_is_not_masked(self):
        for word in ("damn", "hell", "bloody", "crap"):
            with self.subTest(word=word):
                masked, found = mask(f"oh {word}")
                self.assertEqual(masked, f"oh {word}")
                self.assertFalse(found)

    def test_goddamn_is_masked_even_though_damn_is_not(self):
        masked, found = mask("goddamn tyres")

        self.assertEqual(masked, "*** tyres")
        self.assertTrue(found)


class NonEnglishTests(unittest.TestCase):
    def test_common_non_english_expletives_are_masked(self):
        for phrase in ("porca merda", "putain de merde", "joder tio", "cazzo"):
            with self.subTest(phrase=phrase):
                _, found = mask(phrase)
                self.assertTrue(found, phrase)


class SelfCensoredAsrTests(unittest.TestCase):
    def test_asterisked_output_from_the_asr_is_normalised(self):
        masked, found = mask("what the f*** was that")

        self.assertEqual(masked, "what the *** was that")
        self.assertTrue(found)

    def test_partially_masked_words_are_fully_masked(self):
        masked, found = mask("sh*t, the tyres")

        self.assertTrue(masked.startswith(MASK))
        self.assertTrue(found)

    def test_an_already_masked_caption_is_stable_under_a_second_pass(self):
        once, _ = mask("fucking hell")
        twice, _ = mask(once)

        self.assertEqual(once, twice)


class CollapseTests(unittest.TestCase):
    def test_consecutive_masks_collapse_into_one(self):
        masked, _ = mask("fucking bullshit")

        self.assertEqual(masked, MASK)

    def test_masks_separated_by_words_do_not_collapse(self):
        masked, _ = mask("shit, that was shit")

        self.assertEqual(masked, "***, that was ***")


class UtteranceTests(unittest.TestCase):
    def test_raw_text_is_preserved_alongside_the_mask(self):
        utterances = [{"speaker": "driver", "text_raw": "fucking hell"}]

        out, any_profanity = mask_utterances(utterances)

        self.assertEqual(out[0]["text_raw"], "fucking hell")
        self.assertEqual(out[0]["text_masked"], f"{MASK} hell")
        self.assertTrue(any_profanity)

    def test_the_clip_flag_is_true_when_any_utterance_offends(self):
        utterances = [
            {"speaker": "pit", "text_raw": "box this lap"},
            {"speaker": "driver", "text_raw": "the tyres are shit"},
        ]

        out, any_profanity = mask_utterances(utterances)

        self.assertEqual(out[0]["text_masked"], "box this lap")
        self.assertTrue(any_profanity)

    def test_a_clip_with_no_utterances_is_clean(self):
        out, any_profanity = mask_utterances([])

        self.assertEqual(out, [])
        self.assertFalse(any_profanity)


if __name__ == "__main__":
    unittest.main()
