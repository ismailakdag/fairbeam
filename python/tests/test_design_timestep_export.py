"""Generated Python preserves the design's resolved automatic solver step budget."""

import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from fairbeam.design import blank_design, module_for, to_python


class ExportTimesteps(unittest.TestCase):
    def test_automatic_and_explicit_limits_match_all_mesh_modes(self):
        for mode in ("auto", "design", "manual"):
            for limit in (None, "auto", 12345):
                with self.subTest(mode=mode, limit=limit):
                    d = blank_design("step-export", "Step export")
                    d["far_field"] = {"enabled": False}
                    d["mesh"] = {"mode": mode}
                    if mode == "manual":
                        d["mesh"]["lines"] = {
                            "x": ["-G/2", "feed", "G/2"],
                            "y": ["-G/2", 0, "G/2"],
                            "z": [0, "h"],
                        }
                    if limit is not None:
                        d["simulation"]["max_timesteps"] = limit
                    ns = {}
                    exec(to_python(d), ns)
                    # A changed input must resolve at build time, not freeze the export defaults.
                    params = {p["key"]: p["default"] for p in d["params"]}
                    params["f0"] = 1.7
                    params["h"] = 0.6
                    direct = module_for(d).build(params)
                    exported = ns["build"](params)
                    for axis in "xyz":
                        np.testing.assert_array_equal(direct.mesh.GetLines(axis), exported.mesh.GetLines(axis))
                    self.assertEqual(direct.max_timesteps, exported.max_timesteps)
                    with tempfile.TemporaryDirectory() as tmp:
                        for name, sim in (("direct", direct), ("exported", exported)):
                            path = Path(tmp) / f"{name}.xml"
                            sim.fdtd.Write2XML(str(path))
                            self.assertEqual(int(ET.parse(path).find("FDTD").get("NumberOfTimesteps")), sim.max_timesteps)
                    if limit == 12345:
                        self.assertEqual(exported.max_timesteps, limit)
                        self.assertFalse(hasattr(exported, "auto_timesteps"))
                    else:
                        self.assertEqual(direct.auto_timesteps, exported.auto_timesteps)
                        self.assertGreater(exported.max_timesteps, 60000)


if __name__ == "__main__":
    unittest.main()
