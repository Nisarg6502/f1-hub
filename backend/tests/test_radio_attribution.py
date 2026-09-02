import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import radio_attribution
from app.radio_attribution import (
    DRIVER,
    PIT,
    UNKNOWN,
    attribute,
    attribute_diarized_llm,
    attribute_keyword,
    attribute_transcript_llm,
)


def transcript(text, segments=None, turns=None):
    doc = {"text": text, "segments": segments or [], "words": []}
    if turns is not None:
        doc["turns"] = turns
    return doc


def segment(start, end, text):
    return {"start": start, "end": end, "text": text}


def ollama_client(payload):
    """A client that answers any POST with one Ollama chat response."""

    def handler(request):
        return httpx.Response(
            200, json={"message": {"content": json.dumps(payload)}, "done": True}
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


class KeywordBaselineTests(unittest.TestCase):
    """Approach C. The bar the models have to clear to justify their cost."""

    def test_a_pit_instruction_reads_as_the_pit_wall(self):
        result = attribute_keyword(transcript("Box box box, box this lap."))

        self.assertEqual(result[0]["speaker"], PIT)

    def test_a_first_person_complaint_reads_as_the_driver(self):
        result = attribute_keyword(transcript("I've got no grip, the tyres are gone."))

        self.assertEqual(result[0]["speaker"], DRIVER)

    def test_a_bare_acknowledgement_abstains(self):
        for text in ("Copy that.", "Understood.", "Okay.", "Yes."):
            with self.subTest(text=text):
                result = attribute_keyword(transcript(text))
                self.assertEqual(result[0]["speaker"], UNKNOWN)

    def test_swearing_counts_as_driver_evidence_on_the_raw_text(self):
        """Masking happens later, so the raw word is still available as a signal."""
        result = attribute_keyword(transcript("That was fucking dangerous."))

        self.assertEqual(result[0]["speaker"], DRIVER)

    def test_asr_segments_are_preferred_over_punctuation_splitting(self):
        doc = transcript(
            "Box this lap. I have no grip.",
            segments=[segment(0.0, 1.5, "Box this lap."), segment(1.6, 3.0, "I have no grip.")],
        )

        result = attribute_keyword(doc)

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["start"], 0.0)
        self.assertEqual(result[1]["speaker"], DRIVER)

    def test_punctuation_splitting_is_the_fallback_when_there_are_no_segments(self):
        result = attribute_keyword(transcript("Box box box. I have no grip."))

        self.assertEqual(len(result), 2)
        self.assertIsNone(result[0]["start"])

    def test_an_empty_transcript_yields_no_utterances(self):
        self.assertEqual(attribute_keyword(transcript("")), [])


class VocativeTests(unittest.TestCase):
    """Being addressed by name means the pit wall is talking.

    TEAM-RADIO-PLAN.md 5.3 named this the baseline's strongest deterministic
    cue. It was specified and never implemented — attribute_keyword swallowed
    driver_name in **_ — so the bake-off was judging the one free approach with
    its best signal switched off.
    """

    def _label(self, name, line):
        doc = transcript(line, segments=[segment(0.0, 2.0, line)])
        return attribute_keyword(doc, driver_name=name)[0]["speaker"]

    def test_the_driver_being_named_marks_the_line_as_the_pit_wall(self):
        for line in (
            "Lando, how are the tyres?",
            "Okay Lando, box this lap.",
            "Box this lap, Lando.",
        ):
            with self.subTest(line=line):
                self.assertEqual(self._label("Lando Norris", line), PIT)

    def test_it_still_fires_when_the_asr_drops_the_comma(self):
        """Punctuation is unreliable on clipped radio, so it cannot be required."""
        self.assertEqual(self._label("Lando Norris", "Lando how are the tyres"), PIT)

    def test_reference_is_not_address(self):
        """The failure this rule could most easily cause, if written loosely.

        A copula straight after the name turns address into reference. Scoring
        "Carlos is closing on us" as the pit wall would invert exactly the lines
        the cue exists to fix.
        """
        for line in (
            "Carlos is closing on us.",
            "Carlos was quicker there.",
            "I think Carlos is quicker.",
        ):
            with self.subTest(line=line):
                self.assertEqual(self._label("Carlos Sainz", line), UNKNOWN)

    def test_another_drivers_surname_is_not_a_vocative(self):
        """Surnames are how drivers refer to rivals; only the forename counts."""
        self.assertEqual(self._label("Lando Norris", "Verstappen is on the softs."), UNKNOWN)

    def test_no_driver_name_leaves_the_baseline_as_it_was(self):
        self.assertEqual(self._label(None, "Lando, how are the tyres?"), UNKNOWN)


class ConfidenceFloorTests(unittest.TestCase):
    """A weak decision must become an abstention, not a coin flip on screen."""

    def test_a_label_below_the_floor_is_demoted_to_unknown(self):
        payload = {"utterances": [{"text": "Copy.", "speaker": PIT, "confidence": 0.2}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(
                transcript("Copy."), client=ollama_client(payload)
            )

        self.assertEqual(result[0]["speaker"], UNKNOWN)

    def test_a_confident_label_survives(self):
        payload = {"utterances": [{"text": "Box this lap.", "speaker": PIT, "confidence": 0.95}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(
                transcript("Box this lap."), client=ollama_client(payload)
            )

        self.assertEqual(result[0]["speaker"], PIT)

    def test_an_out_of_range_confidence_is_clamped_not_trusted(self):
        payload = {"utterances": [{"text": "Box.", "speaker": PIT, "confidence": 7}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(transcript("Box."), client=ollama_client(payload))

        self.assertEqual(result[0]["confidence"], 1.0)

    def test_a_nonsense_role_becomes_unknown_rather_than_being_stored(self):
        payload = {"utterances": [{"text": "Box.", "speaker": "engineer", "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(transcript("Box."), client=ollama_client(payload))

        self.assertEqual(result[0]["speaker"], UNKNOWN)


class TranscriptLlmTests(unittest.TestCase):
    def test_timings_are_borrowed_from_the_asr_not_invented_by_the_model(self):
        doc = transcript(
            "Box this lap. I have no grip.",
            segments=[segment(0.0, 1.5, "Box this lap."), segment(1.6, 3.0, "I have no grip.")],
        )
        payload = {
            "utterances": [
                {"text": "Box this lap.", "speaker": PIT, "confidence": 0.9},
                {"text": "I have no grip.", "speaker": DRIVER, "confidence": 0.9},
            ]
        }

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(doc, client=ollama_client(payload))

        self.assertEqual(result[0]["start"], 0.0)
        self.assertEqual(result[1]["end"], 3.0)

    def test_an_utterance_the_asr_never_produced_gets_no_timing(self):
        doc = transcript("Box this lap.", segments=[segment(0.0, 1.5, "Box this lap.")])
        payload = {"utterances": [{"text": "Something else entirely", "speaker": PIT, "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(doc, client=ollama_client(payload))

        self.assertIsNone(result[0].get("start"))

    def test_driver_identity_is_sent_as_fact_rather_than_left_to_inference(self):
        sent = {}

        def handler(request):
            sent.update(json.loads(request.content))
            return httpx.Response(200, json={"message": {"content": json.dumps({"utterances": []})}})

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            attribute_transcript_llm(
                transcript("Box."),
                driver_name="George Russell",
                driver_code="RUS",
                team="Mercedes",
                client=httpx.Client(transport=httpx.MockTransport(handler)),
            )

        user_message = json.loads(sent["messages"][1]["content"])
        self.assertEqual(user_message["driver_name"], "George Russell")
        self.assertEqual(user_message["team"], "Mercedes")

    def test_an_empty_transcript_never_reaches_the_model(self):
        def handler(request):
            raise AssertionError("the model must not be called for an empty clip")

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_transcript_llm(
                transcript("  "), client=httpx.Client(transport=httpx.MockTransport(handler))
            )

        self.assertEqual(result, [])


class DiarizedLlmTests(unittest.TestCase):
    def test_one_mapping_decision_labels_every_turn_of_that_speaker(self):
        doc = transcript(
            "Box this lap. Copy. Understood.",
            turns=[
                {"speaker": 0, "start": 0.0, "end": 1.5, "text": "Box this lap."},
                {"speaker": 1, "start": 1.6, "end": 2.1, "text": "Copy."},
                {"speaker": 0, "start": 2.2, "end": 3.0, "text": "Understood."},
            ],
        )
        payload = {
            "speakers": [
                {"speaker_index": 0, "role": PIT, "confidence": 0.9},
                {"speaker_index": 1, "role": DRIVER, "confidence": 0.9},
            ]
        }

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_diarized_llm(doc, client=ollama_client(payload))

        self.assertEqual([u["speaker"] for u in result], [PIT, DRIVER, PIT])

    def test_acoustic_turn_boundaries_are_kept_verbatim(self):
        doc = transcript(
            "Box.",
            turns=[{"speaker": 0, "start": 0.4, "end": 1.9, "text": "Box."}],
        )
        payload = {"speakers": [{"speaker_index": 0, "role": PIT, "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_diarized_llm(doc, client=ollama_client(payload))

        self.assertEqual((result[0]["start"], result[0]["end"]), (0.4, 1.9))

    def test_a_speaker_the_model_did_not_map_abstains(self):
        doc = transcript(
            "Box. Copy.",
            turns=[
                {"speaker": 0, "start": 0.0, "end": 1.0, "text": "Box."},
                {"speaker": 9, "start": 1.1, "end": 2.0, "text": "Copy."},
            ],
        )
        payload = {"speakers": [{"speaker_index": 0, "role": PIT, "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_diarized_llm(doc, client=ollama_client(payload))

        self.assertEqual(result[1]["speaker"], UNKNOWN)

    def test_a_clip_that_diarized_to_nothing_falls_back_to_the_transcript_path(self):
        """A single continuous voice yields no turns; refusing to label it would
        make B look worse for a reason unrelated to its accuracy."""
        doc = transcript("Box this lap.", turns=[])
        payload = {"utterances": [{"text": "Box this lap.", "speaker": PIT, "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute_diarized_llm(doc, client=ollama_client(payload))

        self.assertEqual(result[0]["speaker"], PIT)


class DispatchTests(unittest.TestCase):
    def test_an_unknown_approach_falls_back_to_the_default(self):
        payload = {"utterances": [{"text": "Box.", "speaker": PIT, "confidence": 0.9}]}

        with patch.dict("os.environ", {"OLLAMA_API_KEY": "test"}):
            result = attribute(
                transcript("Box."), approach="telepathy", client=ollama_client(payload)
            )

        self.assertEqual(result[0]["speaker"], PIT)

    def test_a_missing_model_key_degrades_to_the_keyword_baseline(self):
        """Storing nothing because a key was missing is worse than storing the
        baseline's answer — the caption is the point, the label is a bonus."""
        with patch.dict("os.environ", {}, clear=True):
            result = attribute(transcript("Box box box."), approach="transcript_llm")

        self.assertEqual(result[0]["speaker"], PIT)


if __name__ == "__main__":
    unittest.main()
