"""Parity and preview checks for Start-screen Antenna Calculator 3D drafts (releases #7)."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam.design import check_design  # noqa: E402
from fairbeam.design_checks import lint, run_blockers  # noqa: E402
from fairbeam.preview import build_preview  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


class CalculatorDrafts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node is required to generate TypeScript calculator drafts")
        script = """
import { antennaDraft } from './src/home/antennaDraft.ts';
const kinds = ['dipole', 'folded_dipole', 'monopole', 'ground_plane', 'yagi', 'patch'];
const out = [];
for (const kind of kinds) {
  for (const frequencyGHz of [0.0071, 0.145, 2.45]) {
    if (kind === 'patch' && frequencyGHz === 0.0071) continue;
    const input = { kind, frequencyGHz, shortening: 0.95, epsilonR: 4.3, heightMm: 1.6 };
    out.push({ kind, frequencyGHz, draft: antennaDraft(input, `${kind}_test`, `${kind} test`) });
  }
}
process.stdout.write(JSON.stringify(out));
"""
        proc = subprocess.run(
            [node, "--experimental-strip-types", "-e", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        cls.cases = json.loads(proc.stdout)

    def test_drafts_pass_lint_preview_and_unit_policy(self):
        self.assertGreaterEqual(len(self.cases), 17)
        for case in self.cases:
            kind, freq, draft = case["kind"], case["frequencyGHz"], case["draft"]
            with self.subTest(kind=kind, frequencyGHz=freq):
                check_design(draft)
                expected_units = {"length": "m", "frequency": "MHz"} if freq < 0.1 else {"length": "mm", "frequency": "GHz"}
                self.assertEqual(draft.get("units"), expected_units)
                if kind == "folded_dipole":
                    self.assertEqual(draft["ports"][0]["R"], 300)
                else:
                    self.assertEqual(draft["ports"][0]["R"], 50)
                contacts: list[dict] = []
                static_checks = lint(draft, endpoint_contacts=contacts)
                self.assertEqual(static_checks, [])
                self.assertEqual(run_blockers(static_checks), [])
                self.assertEqual([c["status"] for c in contacts], ["touching", "touching"])

                preview = build_preview(None, {}, design=draft)
                pv_contacts: list[dict] = []
                pv_checks = lint(draft, None, preview["bundle"], endpoint_contacts=pv_contacts)
                self.assertEqual(run_blockers(pv_checks), [])
                self.assertEqual([c["status"] for c in pv_contacts], ["touching", "touching"])


if __name__ == "__main__":
    unittest.main()
