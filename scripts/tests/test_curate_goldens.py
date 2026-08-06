"""Unit tests for the pure candidate-formatting logic in curate_goldens.py.

Run from the repo root:

    python -m unittest discover scripts/tests

Follows scripts/tests' own convention (test_trackgeo.py): plain unittest, no
network, no LangSmith credentials required. Only `format_candidate` is tested
here — it is the one pure function in curate_goldens.py. Everything else
(`fetch_thumbs_down_runs`, the argparse CLI) is I/O against LangSmith and is
verified by a manual `--dry-run` per this repo's own established pattern for
CLI scripts (see scripts/README.md), not by a unit test.
"""

from __future__ import annotations

import ast
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from curate_goldens import format_candidate  # noqa: E402


def _base_run_data(**overrides) -> dict:
    data = {
        "run_id": "abc123-run-id",
        "question": "How many podiums has Norris had this season?",
        "answer": "Norris has had 3 podiums this season.",
        "tier": 1,
        "verification": "passed",
        "verification_violations": None,
        "evidence_count": 0,
    }
    data.update(overrides)
    return data


class TestFormatCandidate(unittest.TestCase):
    def test_output_is_syntactically_valid_python(self):
        """The printed block must contain at least one statement ast.parse
        accepts — a human is going to paste this into golden_set.py verbatim,
        so a stray unclosed paren or bad quote is a real failure, not cosmetic.
        """
        text = format_candidate(_base_run_data())
        # Strip the leading "# ..." commentary lines: only the literal itself
        # needs to be valid Python, the human-readable header is prose.
        code_lines = [
            line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")
        ]
        code = "\n".join(code_lines)
        ast.parse(code)  # raises SyntaxError if malformed

    def test_includes_source_run_id_in_notes(self):
        text = format_candidate(_base_run_data(run_id="run-xyz-789"))
        self.assertIn("run-xyz-789", text)
        # Specifically inside a notes= field, not just anywhere in the header.
        notes_start = text.index("notes=")
        self.assertIn("run-xyz-789", text[notes_start:])

    def test_empty_evidence_proposes_known_hard_case(self):
        """Empty evidence ledger + a checkable-fact-shaped answer -> KnownHardCase,
        per the heuristic documented in curate_goldens.py's own docstring.
        """
        text = format_candidate(_base_run_data(evidence_count=0))
        self.assertIn("KnownHardCase(", text)

    def test_nonempty_evidence_proposes_golden_case(self):
        text = format_candidate(_base_run_data(evidence_count=3))
        self.assertIn("GoldenCase(", text)

    def test_never_writes_to_golden_set_file(self):
        """Structural guarantee: format_candidate is pure (str in, str out) and
        curate_goldens.py must have no code path that opens golden_set.py for
        writing. Checked here by asserting the module source contains no
        write-mode file open of golden_set.py.
        """
        import curate_goldens

        source = pathlib.Path(curate_goldens.__file__).read_text(encoding="utf-8")
        for line in source.splitlines():
            if "golden_set" in line and "open(" in line:
                self.fail(f"found an open() call referencing golden_set.py: {line!r}")


if __name__ == "__main__":
    unittest.main()
