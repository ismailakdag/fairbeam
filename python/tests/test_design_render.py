"""fairbeam/design_render.py: every bundle primitive kind becomes finite faces or wires, the z-buffer
keeps a metal on its substrate visible, and the picture is a PNG."""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import design_render as dr  # noqa: E402

BOX = {"kind": "box", "start": [-10, -5, 0], "stop": [10, 5, 1.6], "priority": 0}
PRIMS = [
    BOX,
    {"kind": "polygon", "normal": 2, "elevation": 1.6, "points": [[-4, -4], [4, -4], [4, 0], [0, 0], [0, 4], [-4, 4]]},
    {"kind": "linpoly", "normal": 1, "elevation": 0, "points": [[0, 0], [1, 0], [1, 1]], "length": 2},
    {"kind": "cylinder", "start": [0, 0, 0], "stop": [0, 0, 5], "radius": 0.5},
    {"kind": "cylindricalshell", "start": [0, 0, 0], "stop": [3, 4, 0], "radius": 1, "shell_width": 0.2},
    {"kind": "sphere", "center": [1, 2, 3], "radius": 0.7},
    {"kind": "rotpoly", "axis": 2, "origin": [0, 0, 1], "points": [[0, 0], [2, 0], [0, 3]]},
    {"kind": "polyhedron", "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
     "faces": [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]},
    {"kind": "wire", "points": [[0, 0, 0], [0, 0, 10], [5, 0, 10]], "radius": 0.1},
    {"kind": "curve", "points": [[0, 0, 0], [1, 1, 1]]},
    {"kind": "transformed", "primitive": BOX,
     "matrix": [[0, -1, 0, 100], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]},
    {"kind": "bbox", "source_kind": "unknown", "bbox": [[0, 0, 0], [1, 1, 1]]},
]


def bundle():
    return {
        "name": "board", "model": {"name": "Test board"},
        "parts": [
            {"name": "substrate", "type": "Material", "primitives": [BOX]},
            {"name": "patch", "type": "Metal",
             "primitives": [{"kind": "box", "start": [-4, -3, 1.6], "stop": [4, 3, 1.6]}]},
            {"name": "ground", "type": "Metal",
             "primitives": [{"kind": "box", "start": [-10, -5, 0], "stop": [10, 5, 0]}]},
        ],
        "ports": [{"number": 1, "type": "lumped", "start": [0, -5, 0], "stop": [0, -5, 1.6]}],
        "mesh": {"x": [-10, 0, 10], "y": [-5, 0, 5], "z": [0, 1.6]},
    }


class Geometry(unittest.TestCase):
    def test_every_kind(self):
        for prim in PRIMS:
            with self.subTest(prim["kind"]):
                faces, lines = dr.primitive_geometry(prim)
                self.assertTrue(faces or lines)
                for g in faces + lines:
                    self.assertEqual(g.shape[1], 3)
                    self.assertTrue(np.all(np.isfinite(g)))

    def test_transformed_moves_the_box(self):
        faces, _ = dr.primitive_geometry(PRIMS[10])
        pts = np.vstack(faces)
        self.assertAlmostEqual(pts[:, 0].min(), 95)  # x' = -y + 100
        self.assertAlmostEqual(pts[:, 1].max(), 10)  # y' = x

    def test_extent_and_no_geometry(self):
        sc = dr.scene(bundle())
        self.assertEqual(list(sc["lo"]), [-10, -5, 0])
        self.assertEqual(list(sc["hi"]), [10, 5, 1.6])
        with self.assertRaises(dr.RenderError):
            dr.scene({"parts": [], "ports": []})


class Picture(unittest.TestCase):
    def test_patch_on_substrate_is_seen_from_above(self):
        sc = dr.scene(bundle())
        m = dr._projection("top")
        lo2, hi2, _ = dr._view_box(sc, "top")
        r = dr._Raster(lo2, hi2, 200)
        for k, it in enumerate(sc["items"]):
            layer = "metal" if it["alpha"] >= 0.9 else "dielectric"
            for f in it["faces"]:
                r.face(layer, f @ m.T, np.array([1.0, 0.0, 0.0]) if it["name"] == "patch" else np.array([0.0, 0.0, 1.0]), k)
        img = r.image(np.array([it["alpha"] for it in sc["items"]]))
        cx, cy = r._px(np.array([[0.0, 0.0]]))[0].astype(int)
        self.assertGreater(img[cy, cx, 0], 0.9, "the patch is not tinted by the substrate under it")
        ex, ey = r._px(np.array([[8.0, 4.0]]))[0].astype(int)
        self.assertLess(img[ey, ex, 0], 0.5, "beside the patch the substrate covers the ground")

    def test_png(self):
        png, summary = dr.render_png(bundle(), views=["iso", "side"], show_mesh=True, size_px=400)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(summary["views"], ["iso", "side"])
        self.assertEqual(summary["extent_mm"]["size"], [20.0, 10.0, 1.6])
        self.assertEqual([p["name"] for p in summary["parts"]], ["substrate", "patch", "ground"])
        self.assertTrue(summary["mesh_lines_drawn"])
        everything = {"parts": [{"name": "all", "type": "Metal", "primitives": PRIMS}], "ports": []}
        png, _ = dr.render_png(everything, size_px=400)
        self.assertTrue(png.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
