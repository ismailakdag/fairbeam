"""A design's saved display units (`units`): accepted when valid, never used to scale values."""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import DISPLAY_FREQUENCY_UNITS, DISPLAY_LENGTH_UNITS, DesignError, check_design  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DIPOLE = ROOT / "examples" / "designs" / "hf_dipole_7mhz.design.json"


class DesignUnits(unittest.TestCase):
    def setUp(self):
        self.d = json.loads(DIPOLE.read_text(encoding="utf-8"))

    def test_valid_units_are_accepted(self):
        self.d["units"] = {"length": "m", "frequency": "MHz"}
        check_design(self.d)
        self.d["units"] = {}
        check_design(self.d)

    def test_invalid_units_are_rejected(self):
        for bad, path in (({"length": "km"}, "units.length"), ({"frequency": "THz"}, "units.frequency"),
                          ({"length": "mm", "time": "s"}, "units"), ("mm", "units")):
            d = copy.deepcopy(self.d)
            d["units"] = bad
            with self.subTest(bad=bad), self.assertRaises(DesignError) as e:
                check_design(d)
            self.assertEqual(e.exception.where, path)

    def test_units_do_not_scale_the_model(self):
        plain = build_preview(None, {}, design=self.d)["bundle"]
        d = copy.deepcopy(self.d)
        d["units"] = {"length": "m", "frequency": "kHz"}
        shown = build_preview(None, {}, design=d)["bundle"]
        self.assertEqual(plain["mesh"]["cells"], shown["mesh"]["cells"])
        self.assertEqual(json.dumps(plain["parts"], sort_keys=True), json.dumps(shown["parts"], sort_keys=True))

    def test_lists_match_the_designer(self):
        ts = (ROOT / "src" / "lib" / "displayUnits.ts").read_text(encoding="utf-8")
        self.assertIn("LENGTH_UNITS = { " + ", ".join(f"{u}: " for u in DISPLAY_LENGTH_UNITS)[:2], ts)
        for u in DISPLAY_LENGTH_UNITS + DISPLAY_FREQUENCY_UNITS:
            self.assertRegex(ts, rf"\b{u}: ")


if __name__ == "__main__":
    unittest.main()
