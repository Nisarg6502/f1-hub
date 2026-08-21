"""Guards on an experimental module that is committed but must not ship.

`app/strategy_whatif.py` fails its own acceptance gate (see that file's "How
well it works"). It is committed so the design survives and the defect is not
rediscovered from scratch, NOT because it is ready. These tests pin the two
properties that make committing it safe rather than dangerous:

  1. it stays out of the running app, and
  2. it keeps saying so about itself.

Neither is a test of the model. There are deliberately none of those yet —
writing them is part of the 3-5 day repair estimate, and a passing unit test
on a helper would give this module a green tick it has not earned.
"""

import ast
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

WHATIF = BACKEND / "app" / "strategy_whatif.py"
MAIN = BACKEND / "app" / "main.py"


class NotWiredInTests(unittest.TestCase):
    """The module must remain unreachable from the API.

    It defines an `APIRouter` and would work the moment someone added the two
    conventional lines to `main.py`. That is exactly the accident this guards
    against: the file looks finished, its docstring is long and confident, and
    nothing about importing it would fail.
    """

    def test_main_neither_imports_nor_includes_it(self):
        source = MAIN.read_text(encoding="utf-8")
        self.assertNotIn(
            "strategy_whatif",
            source,
            "strategy_whatif was wired into main.py. It fails its own no-op "
            "acceptance gate — it moves a race winner to P13 when asked to "
            "change nothing. Read the module docstring before routing it.",
        )

    def test_it_is_not_imported_anywhere_in_the_app(self):
        offenders = [
            path.relative_to(BACKEND).as_posix()
            for path in (BACKEND / "app").rglob("*.py")
            if path != WHATIF and "strategy_whatif" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual([], offenders)


class DeclaresItselfExperimentalTests(unittest.TestCase):
    """The docstring is the liability, so the docstring is what is pinned.

    The version of this file that was written but never run asserted "76.1%
    exact, 96.9% inside the reported window" as measured fact. When the gate
    was finally run those numbers did not reproduce — 51.1% exact on clean
    finishers. Left standing, that paragraph was a long, persuasive argument
    that would convince the next reader the module was measurement-grade.
    """

    @staticmethod
    def _docstring() -> str:
        tree = ast.parse(WHATIF.read_text(encoding="utf-8"))
        return ast.get_docstring(tree) or ""

    def test_the_banner_is_the_first_thing_a_reader_sees(self):
        first_line = self._docstring().splitlines()[0]
        self.assertIn("EXPERIMENTAL", first_line)
        self.assertIn("FAILS ITS OWN ACCEPTANCE GATE", first_line)

    def test_the_discredited_accuracy_claims_are_gone(self):
        doc = self._docstring()
        for claim in ("76.1%", "96.9%"):
            self.assertNotIn(
                claim,
                doc,
                f"{claim} was the unreproducible accuracy claim. If the gate "
                "has genuinely been re-run and now passes, replace this test "
                "with the real measurement rather than deleting the guard.",
            )

    def test_the_measured_failure_is_recorded_with_its_cause(self):
        doc = self._docstring()
        # The number that matters and the mechanism behind it. A future reader
        # who removes either has removed the reason not to ship this.
        self.assertIn("51.1%", doc)
        self.assertIn("fitted-for-measured pit-cost substitution", doc)


class RouterShapeTests(unittest.TestCase):
    """It still has to be importable — a committed module that cannot be
    imported is worse than one that can, because nobody notices it rotted."""

    def test_the_module_parses_and_defines_exactly_one_route(self):
        tree = ast.parse(WHATIF.read_text(encoding="utf-8"))
        routes = [
            decorator
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            for decorator in node.decorator_list
            if isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and isinstance(decorator.func.value, ast.Name)
            and decorator.func.value.id == "router"
        ]
        self.assertEqual(
            1, len(routes), "Expected exactly one unrouted endpoint definition."
        )


if __name__ == "__main__":
    unittest.main()
