"""The `--rgb-*` triples must agree with their `--color-*` hex counterparts.

`globals.css` deliberately declares each of six palette colours twice: once as
a hex, which Tailwind turns into utilities (`bg-veil`, `bg-veil/5`), and once as
space-separated channels, which the places a Tailwind class cannot reach use
instead -- inline `style` objects, gradient stops, `box-shadow` colours and SVG
presentation attributes, written `rgb(var(--rgb-veil) / 0.07)`.

That duplication is the one real cost of the approach, and this file is the
reason it is affordable. Drift here is invisible: the page keeps rendering, and
one surface simply stops matching the others by a few units of red. Nothing
would catch it by eye.

It lives in the BACKEND test suite purely because that is where this project
runs tests. It touches no backend code; it reads a stylesheet.
"""

import re
import unittest
from pathlib import Path

GLOBALS_CSS = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "app" / "globals.css"
)

# Each `--rgb-<name>` must equal the channels of `--color-<name>`.
PAIRS = (
    "veil",
    "flame-bright",
    "primary",
    "primary-container",
    "flame",
    "ember",
)


def _read_css() -> str:
    return GLOBALS_CSS.read_text(encoding="utf-8", errors="replace")


def _hex_token(css: str, name: str) -> tuple[int, int, int] | None:
    m = re.search(r"--color-" + re.escape(name) + r":\s*#([0-9a-fA-F]{6})\s*;", css)
    if not m:
        return None
    h = m.group(1)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_token(css: str, name: str) -> tuple[int, int, int] | None:
    m = re.search(
        r"--rgb-" + re.escape(name) + r":\s*(\d+)\s+(\d+)\s+(\d+)\s*;", css
    )
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


class DesignTokenPairsTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(GLOBALS_CSS.exists(), f"missing {GLOBALS_CSS}")
        self.css = _read_css()

    def test_every_rgb_triple_matches_its_hex_token(self):
        for name in PAIRS:
            with self.subTest(token=name):
                hex_value = _hex_token(self.css, name)
                rgb_value = _rgb_token(self.css, name)
                self.assertIsNotNone(hex_value, f"--color-{name} not found")
                self.assertIsNotNone(rgb_value, f"--rgb-{name} not found")
                self.assertEqual(
                    rgb_value,
                    hex_value,
                    f"--rgb-{name} is {rgb_value} but --color-{name} is "
                    f"{hex_value}; change one, change the other",
                )

    def test_no_rgb_triple_lacks_a_hex_counterpart(self):
        # Catches a triple added for a colour that has no token, which would be
        # a new undeclared colour wearing a token's clothes.
        declared = set(re.findall(r"--rgb-([a-z0-9-]+):", self.css))
        self.assertEqual(
            declared - set(PAIRS),
            set(),
            "a --rgb-* token exists that this test does not know about; add it "
            "to PAIRS so it is checked too",
        )
