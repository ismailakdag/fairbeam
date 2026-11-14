"""A quick picture of a design's geometry from its preview bundle, for assistants (fairbeam mcp,
render_design) that cannot open the 3D viewer: an isometric view and the top, front and side
views in one PNG, with the ports and optionally the mesh lines. Drawing only; it changes nothing.

Every primitive of the bundle ("fairbeam.project/1" parts, docs/BUNDLE.md) is turned into flat 3D
faces (curved surfaces as facets) and projected orthographically, back to front. Needs matplotlib,
which the managed runtime installs (runtime/requirements.in)."""

from __future__ import annotations

import io
import math

import numpy as np

METAL = "#c8812f"
SHEET = "#d9a441"
VOID = "#888888"
PORT = "#d62728"
DIELECTRICS = ["#4c9be8", "#59b37a", "#a77fd6", "#e07b9b", "#3fb3b3", "#b3a03f"]
SEGMENTS = 24

# (horizontal axis, vertical axis, axis toward the viewer, its sign), as in the designer's views
ORTHO = {
    "top": (0, 1, 2, 1, "top (looking down −z)"),
    "front": (0, 2, 1, -1, "front (looking along +y)"),
    "side": (1, 2, 0, 1, "side (looking along −x)"),
}
VIEWS = ("iso", "top", "front", "side")


class RenderError(ValueError):
    pass


# ------------------------------------------------------------------ primitives → faces

def _poly3(normal: int, elevation: float, uv) -> np.ndarray:
    pts = np.zeros((len(uv), 3))
    pts[:, normal] = elevation
    pts[:, (normal + 1) % 3] = [q[0] for q in uv]
    pts[:, (normal + 2) % 3] = [q[1] for q in uv]
    return pts


def _prism(ring: np.ndarray, offset: np.ndarray) -> list[np.ndarray]:
    top = ring + offset
    faces = [ring, top]
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        faces.append(np.array([ring[i], ring[j], top[j], top[i]]))
    return faces


def _box(a, b) -> list[np.ndarray]:
    a, b = np.minimum(a, b), np.maximum(a, b)
    ring = np.array([[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]]])
    return _prism(ring, np.array([0.0, 0.0, b[2] - a[2]]))


def _basis(axis: np.ndarray):
    axis = axis / (np.linalg.norm(axis) or 1.0)
    helper = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(axis, helper)
    u /= np.linalg.norm(u)
    return u, np.cross(axis, u)


def _cylinder(start, stop, r: float) -> list[np.ndarray]:
    start, stop = np.asarray(start, float), np.asarray(stop, float)
    u, v = _basis(stop - start)
    t = np.linspace(0, 2 * math.pi, SEGMENTS, endpoint=False)
    ring = start + r * (np.outer(np.cos(t), u) + np.outer(np.sin(t), v))
    return _prism(ring, stop - start)


def _revolve(origin, axis: int, profile) -> list[np.ndarray]:
    origin = np.asarray(origin, float)
    a, b = (axis + 1) % 3, (axis + 2) % 3
    t = np.linspace(0, 2 * math.pi, SEGMENTS + 1)
    faces = []
    prof = list(profile) + [profile[0]]
    for (r0, h0), (r1, h1) in zip(prof, prof[1:]):
        for k in range(SEGMENTS):
            quad = []
            for r, h, ang in ((r0, h0, t[k]), (r1, h1, t[k]), (r1, h1, t[k + 1]), (r0, h0, t[k + 1])):
                p = origin.copy()
                p[axis] += h
                p[a] += r * math.cos(ang)
                p[b] += r * math.sin(ang)
                quad.append(p)
            faces.append(np.array(quad))
    return faces


def _sphere(center, r: float) -> list[np.ndarray]:
    lat = np.linspace(-math.pi / 2, math.pi / 2, 9)
    return _revolve(np.asarray(center, float), 2, [(r * math.cos(x), r * math.sin(x)) for x in lat])


def primitive_geometry(prim: dict) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """(faces, polylines) of one bundle primitive in mm; a bbox-only primitive becomes its box."""
    kind = prim.get("kind")
    if kind == "transformed":
        faces, lines = primitive_geometry(prim["primitive"])
        m = np.asarray(prim["matrix"], float)

        def tf(p):
            h = np.c_[p, np.ones(len(p))] @ m.T
            return h[:, :3]
        return [tf(f) for f in faces], [tf(ln) for ln in lines]
    if kind == "box":
        return _box(np.asarray(prim["start"], float), np.asarray(prim["stop"], float)), []
    if kind in ("polygon", "linpoly"):
        ring = _poly3(int(prim["normal"]), float(prim["elevation"]), prim["points"])
        length = float(prim.get("length") or 0.0) if kind == "linpoly" else 0.0
        if abs(length) > 0:
            off = np.zeros(3)
            off[int(prim["normal"])] = length
            return _prism(ring, off), []
        return [ring], []
    if kind == "cylinder":
        return _cylinder(prim["start"], prim["stop"], float(prim["radius"])), []
    if kind == "cylindricalshell":
        return _cylinder(prim["start"], prim["stop"], float(prim["radius"]) + float(prim.get("shell_width") or 0) / 2), []
    if kind == "sphere":
        return _sphere(prim["center"], float(prim["radius"])), []
    if kind == "rotpoly":
        return _revolve(prim["origin"], int(prim["axis"]), prim["points"]), []
    if kind == "polyhedron":
        v = np.asarray(prim["vertices"], float)
        return [v[list(f)] for f in prim["faces"] if len(f) >= 3], []
    if kind in ("curve", "wire"):
        return [], [np.asarray(prim["points"], float)]
    bb = prim.get("bbox")
    if bb:
        return _box(np.asarray(bb[0], float), np.asarray(bb[1], float)), []
    return [], []


# ------------------------------------------------------------------ scene

def _part_color(part: dict, dielectric_index: dict) -> tuple[str, float]:
    if part.get("void"):
        return VOID, 0.15
    color = part.get("color")
    kind = part.get("type")
    if kind == "ConductingSheet":
        base, alpha = SHEET, 0.95
    elif kind == "Metal" or (part.get("conductor") and not part.get("material")):
        base, alpha = METAL, 0.95
    else:
        key = part.get("name")
        if key not in dielectric_index:
            dielectric_index[key] = len(dielectric_index)
        base, alpha = DIELECTRICS[dielectric_index[key] % len(DIELECTRICS)], 0.55
    if isinstance(color, str) and color.startswith("#") and len(color) in (4, 7):
        base = color
    if isinstance(part.get("opacity"), (int, float)):
        alpha = min(alpha, max(0.05, float(part["opacity"])))
    return base, alpha


def scene(bundle: dict) -> dict:
    """Faces, wires, ports and the extent (mm) of a preview bundle."""
    items = []
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    dielectric_index: dict = {}
    for part in bundle.get("parts") or []:
        color, alpha = _part_color(part, dielectric_index)
        faces, lines = [], []
        for prim in part.get("primitives") or []:
            f, ln = primitive_geometry(prim)
            faces += f
            lines += ln
        for g in faces + lines:
            if len(g):
                lo, hi = np.minimum(lo, g.min(0)), np.maximum(hi, g.max(0))
        items.append({"name": part.get("label") or part.get("name"), "type": part.get("type"),
                      "color": color, "alpha": alpha, "faces": faces, "lines": lines,
                      "metal": color in (METAL, SHEET) or part.get("type") in ("Metal", "ConductingSheet")})
    ports = []
    for p in bundle.get("ports") or []:
        if "start" in p and "stop" in p:
            a, b = np.asarray(p["start"], float), np.asarray(p["stop"], float)
            ports.append({"number": p.get("number"), "start": a, "stop": b, "type": p.get("type")})
            lo, hi = np.minimum(lo, np.minimum(a, b)), np.maximum(hi, np.maximum(a, b))
    if not np.all(np.isfinite(lo)):
        raise RenderError("the design has no geometry to draw")
    return {"items": items, "ports": ports, "lo": lo, "hi": hi}


# ------------------------------------------------------------------ drawing

RASTER_PX = 900  # pixels across the larger side of a view's picture


def _iso_axes():
    az, el = math.radians(-55), math.radians(28)
    cam = np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])
    u = np.cross(np.array([0.0, 0.0, 1.0]), cam)
    u /= np.linalg.norm(u)
    v = np.cross(cam, u)
    return u, v, cam


def _projection(view: str) -> np.ndarray:
    """3 x 3 matrix: rows are the picture's u (right), v (up) and the depth toward the viewer."""
    if view == "iso":
        return np.array(_iso_axes())
    h, vv, d, sign, _ = ORTHO[view]
    m = np.zeros((3, 3))
    m[0, h] = m[1, vv] = 1.0
    m[2, d] = sign
    return m


LIGHT = np.array([0.35, -0.55, 0.76]) / np.linalg.norm([0.35, -0.55, 0.76])


def _shade(face: np.ndarray, view: str) -> float:
    if view != "iso" or len(face) < 3:
        return 1.0
    n = np.zeros(3)
    for a, b in zip(face, np.roll(face, -1, axis=0)):  # Newell's normal: robust for any planar polygon
        n += np.cross(a, b)
    norm = np.linalg.norm(n)
    return 1.0 if norm == 0 else 0.6 + 0.4 * abs(float(n @ LIGHT) / norm)


def _rgb(color: str) -> np.ndarray:
    from matplotlib.colors import to_rgb
    return np.array(to_rgb(color))


class _Raster:
    """A z-buffer picture of flat faces: one buffer for metal (opaque) and one for dielectrics
    (see-through, the nearest one blended over what is behind it)."""

    def __init__(self, lo2, hi2, px: int):
        span = np.maximum(hi2 - lo2, 1e-12)
        self.scale = float(max(span) / px)  # mm per pixel
        self.w = max(2, int(math.ceil(span[0] / self.scale)) + 1)
        self.h = max(2, int(math.ceil(span[1] / self.scale)) + 1)
        self.lo2, self.hi2 = lo2, hi2
        self.buf = {k: (np.full((self.h, self.w), -np.inf), np.ones((self.h, self.w, 3)), np.full((self.h, self.w), -1))
                    for k in ("metal", "dielectric")}

    def _px(self, uv):
        return np.c_[(uv[:, 0] - self.lo2[0]) / self.scale, (self.hi2[1] - uv[:, 1]) / self.scale]

    def face(self, layer: str, uvd: np.ndarray, rgb, part: int) -> None:
        from matplotlib.path import Path

        pts = self._px(uvd[:, :2])
        x, y = pts[:, 0], pts[:, 1]
        area = 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))
        if area < 1.0:  # seen edge on: a line one or two pixels wide
            d = ((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1)
            i, j = np.unravel_index(int(np.argmax(d)), d.shape)
            a, b = pts[i], pts[j]
            t = b - a
            ln = float(np.hypot(*t))
            nrm = np.array([-t[1], t[0]]) / ln * 0.8 if ln > 0 else np.array([0.8, 0.0])
            ext = t / ln * 0.5 if ln > 0 else np.array([0.0, 0.8])
            pts = np.array([a - ext + nrm, b + ext + nrm, b + ext - nrm, a - ext - nrm])
            coef = None
            depth_const = float(uvd[:, 2].mean())
        else:
            # depth is linear over a flat face: fit depth = a x + b y + c in pixel coordinates
            coef, *_ = np.linalg.lstsq(np.c_[pts, np.ones(len(pts))], uvd[:, 2], rcond=None)
            depth_const = None
        x0, y0 = np.floor(pts.min(0)).astype(int)
        x1, y1 = np.ceil(pts.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, self.w - 1), min(y1, self.h - 1)
        if x1 < x0 or y1 < y0:
            return
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        cells = np.c_[gx.ravel(), gy.ravel()]
        inside = Path(pts).contains_points(cells, radius=0.01).reshape(gx.shape)
        if not inside.any():
            return
        depth = np.full(gx.shape, depth_const) if coef is None else coef[0] * gx + coef[1] * gy + coef[2]
        zb, col, ids = self.buf[layer]
        sub = (slice(y0, y1 + 1), slice(x0, x1 + 1))
        nearer = inside & (depth > zb[sub] + 1e-9)
        zb[sub][nearer] = depth[nearer]
        col[sub][nearer] = rgb
        ids[sub][nearer] = part

    def image(self, dielectric_alpha: np.ndarray) -> np.ndarray:
        zm, cm, im = self.buf["metal"]
        zd, cd, idd = self.buf["dielectric"]
        out = cm.copy()
        alpha = np.where(idd >= 0, dielectric_alpha[np.maximum(idd, 0)], 0.0)
        # a metal on a dielectric's surface (a patch on its substrate) is seen, not tinted: the depths
        # are equal up to rounding, so the dielectric is in front only beyond a small tolerance
        tol = 1e-6 * max(1.0, float(np.nanmax(np.abs(np.where(np.isfinite(zd), zd, 0)))),
                         float(np.nanmax(np.abs(np.where(np.isfinite(zm), zm, 0))))) + 1e-9 * self.scale
        front = (idd >= 0) & (zd > zm + max(tol, 1e-4 * self.scale))
        a = np.where(front, alpha, 0.0)[..., None]
        out = out * (1 - a) + cd * a
        behind = (idd >= 0) & ~front & (im < 0)
        out[behind] = cd[behind]
        # outlines where the part changes (metal everywhere, dielectrics where seen)
        top_id = np.where(front | (im < 0), np.where(idd >= 0, idd + 10_000, im), im)
        edge = np.zeros(top_id.shape, bool)
        edge[:, 1:] |= top_id[:, 1:] != top_id[:, :-1]
        edge[1:, :] |= top_id[1:, :] != top_id[:-1, :]
        out[edge] *= 0.45
        return np.clip(out, 0, 1)


def _view_box(sc: dict, view: str):
    """The picture rectangle (lower left, upper right, padding) of a view, in mm."""
    m = _projection(view)
    lo, hi = sc["lo"], sc["hi"]
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) @ m.T
    a, b = corners[:, :2].min(0), corners[:, :2].max(0)
    span = max(float((b - a).max()), 1e-9)
    pad = 0.06 * span
    return a - pad, b + pad, pad


def _draw_view(ax, sc: dict, view: str, mesh: dict | None) -> None:
    from matplotlib.collections import LineCollection

    m = _projection(view)
    lo, hi = sc["lo"], sc["hi"]
    lo2, hi2, pad = _view_box(sc, view)
    span = float((hi2 - lo2).max()) / 1.12
    r = _Raster(lo2, hi2, RASTER_PX)
    alphas = []
    for k, it in enumerate(sc["items"]):
        layer = "metal" if it["alpha"] >= 0.9 else "dielectric"
        alphas.append(it["alpha"])
        base = _rgb(it["color"])
        for f in it["faces"]:
            if len(f) >= 2:
                r.face(layer, f @ m.T, np.clip(base * _shade(f, view), 0, 1), k)
    img = r.image(np.array(alphas or [0.0]))
    ax.imshow(img, extent=(lo2[0], lo2[0] + r.w * r.scale, hi2[1] - r.h * r.scale, hi2[1]),
              interpolation="antialiased", zorder=0)
    wires = [(ln @ m.T)[:, :2] for it in sc["items"] for ln in it["lines"]]
    if wires:
        ax.add_collection(LineCollection(wires, colors=METAL, linewidths=1.6, zorder=2))
    if view != "iso" and mesh:
        h, vv = ORTHO[view][0], ORTHO[view][1]
        segs = []
        span_h, span_v = (lo[h], hi[h]), (lo[vv], hi[vv])
        for x in mesh.get("xyz"[h]) or []:
            if span_h[0] <= x <= span_h[1]:
                segs.append([(x, span_v[0]), (x, span_v[1])])
        for y in mesh.get("xyz"[vv]) or []:
            if span_v[0] <= y <= span_v[1]:
                segs.append([(span_h[0], y), (span_h[1], y)])
        if segs:
            ax.add_collection(LineCollection(segs, colors=(0.15, 0.15, 0.15, 0.4), linewidths=0.25, zorder=3))
    for p in sc["ports"]:
        seg = (np.array([p["start"], p["stop"]]) @ m.T)[:, :2]
        ax.plot(seg[:, 0], seg[:, 1], color=PORT, linewidth=2.2, solid_capstyle="round", zorder=5)
        ax.annotate(f"P{p['number']}", seg.mean(0), xytext=(4, 4), textcoords="offset points", color=PORT,
                    fontsize=8, fontweight="bold", zorder=6)
    ax.set_xlim(lo2[0], hi2[0])
    ax.set_ylim(lo2[1], hi2[1])
    ax.set_aspect("equal")
    if view == "iso":
        ax.set_axis_off()
        origin = np.array([lo2[0] + pad * 0.6, lo2[1] + pad * 0.6])
        length = 0.12 * span
        for axis, name in enumerate("xyz"):
            d = m[:2, axis]
            ax.annotate("", origin + d * length, origin, arrowprops={"arrowstyle": "->", "color": "#444", "lw": 1})
            ax.text(*(origin + d * length * 1.2), name, fontsize=8, color="#444", ha="center", va="center")
        ax.set_title("isometric", fontsize=9)
    else:
        h, vv, _, _, title = ORTHO[view]
        ax.set_xlabel(f"{'xyz'[h]} (mm)", fontsize=8)
        ax.set_ylabel(f"{'xyz'[vv]} (mm)", fontsize=8)
        ax.tick_params(labelsize=7)
        ax.set_title(title, fontsize=9)


def render_png(bundle: dict, views=VIEWS, show_mesh: bool = False, size_px: int = 1100) -> tuple[bytes, dict]:
    """PNG bytes and a short text summary of the drawn design."""
    try:
        import matplotlib
        matplotlib.use("Agg", force=True)
        import matplotlib.pyplot as plt
    except ImportError as e:  # pragma: no cover - the managed runtime has it
        raise RenderError("drawing needs matplotlib in the Python that runs Fairbeam") from e
    views = [v for v in views if v in VIEWS] or list(VIEWS)
    sc = scene(bundle)
    mesh = bundle.get("mesh") if show_mesh else None
    n = len(views)
    cols = 1 if n == 1 else 2
    rows = math.ceil(n / cols)
    size_px = int(min(max(size_px, 400), 2000))
    dpi = 110
    # each row as tall as its tallest view needs (a flat board's side views take a thin strip)
    ratios = []
    for r0 in range(rows):
        row = views[r0 * cols:(r0 + 1) * cols]
        boxes = [_view_box(sc, v) for v in row]
        ratios.append(min(1.2, max(0.22, max(float((hi - lo)[1] / max((hi - lo)[0], 1e-12)) for lo, hi, _ in boxes))))
    width_in = size_px / dpi
    height_in = width_in / cols * sum(ratios) * 1.12 + 0.9
    fig, axes = plt.subplots(rows, cols, figsize=(width_in, height_in), dpi=dpi, squeeze=False,
                             gridspec_kw={"height_ratios": ratios})
    try:
        for ax, view in zip(axes.flat, views):
            _draw_view(ax, sc, view, mesh)
        for ax in list(axes.flat)[n:]:
            ax.set_axis_off()
        size = sc["hi"] - sc["lo"]
        name = (bundle.get("model") or {}).get("name") if isinstance(bundle.get("model"), dict) else None
        dims = " × ".join(f"{x:.4g}" if abs(x) < 1e4 else f"{x:.0f}" for x in size)
        fig.suptitle(f"{name or bundle.get('name') or 'design'} — {dims} mm",
                     fontsize=10)
        handles = []
        from matplotlib.patches import Patch
        seen = set()
        for it in sc["items"]:
            if it["name"] in seen:
                continue
            seen.add(it["name"])
            handles.append(Patch(facecolor=it["color"], alpha=max(it["alpha"], 0.5), label=f"{it['name']} ({it['type']})"))
            if len(handles) >= 10:
                break
        if handles:
            fig.legend(handles=handles, loc="lower center", ncol=min(4, len(handles)), fontsize=7, frameon=False)
        fig.tight_layout(rect=(0, 0.06 if handles else 0, 1, 0.96))
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi)
    finally:
        plt.close(fig)
    summary = {
        "views": views,
        "extent_mm": {"min": [round(float(x), 4) for x in sc["lo"]], "max": [round(float(x), 4) for x in sc["hi"]],
                      "size": [round(float(x), 4) for x in sc["hi"] - sc["lo"]]},
        "parts": [{"name": it["name"], "type": it["type"]} for it in sc["items"]],
        "ports": [{"number": p["number"], "type": p["type"], "start_mm": [round(float(x), 4) for x in p["start"]],
                   "stop_mm": [round(float(x), 4) for x in p["stop"]]} for p in sc["ports"]],
        "mesh_lines_drawn": bool(mesh),
    }
    return buf.getvalue(), summary
