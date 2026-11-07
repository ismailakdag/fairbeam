"""Fairbeam as an MCP server: AI assistants (Claude Desktop, Claude Code and other MCP clients)
design, check, simulate and read antennas through the run server.

``fairbeam mcp`` speaks the Model Context Protocol over stdio (JSON-RPC 2.0, one message per line;
logs go to stderr). It needs nothing beyond the standard library. Every tool calls the run server's
HTTP API (docs/RUN-SERVER.md):

- the desktop app's server when the app is open (its ``server.json`` record, appstate.py), so the
  runs an assistant starts wait in the app's queue and show under Recent runs, and designs it
  creates appear under Start › Your designs;
- otherwise a server this process starts on a free port, on the app's workspace folders (its own
  jobs folder, so a later app start is not blocked);
- or ``--server URL`` / ``FAIRBEAM_SERVER``.

Values are Fairbeam's canonical units: lengths in mm, frequencies in GHz. See docs/MCP.md.
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from pathlib import Path

from ._meta import __version__

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
TERMINAL = ("done", "failed", "cancelled", "interrupted")
SERVER_INSTRUCTIONS = """Fairbeam designs and simulates antennas and RF circuits with openEMS (FDTD).
Units: lengths in mm, frequencies in GHz (7.1 MHz is 0.0071). Typical flow: list_designs or
create_design → get_design → set_parameters / update_design → check_design (fix errors first) →
run_simulation (waits for the result) → get_results. Runs queue one at a time on the user's machine;
prefer coarse settings for quick looks and tell the user how long a run is expected to take.
Results are simulations, not measurements; say so when reporting numbers. design_format_guide
explains the design file format."""


class ToolError(Exception):
    """A tool failed in a way the assistant should see (returned as a tool result with isError)."""


# ------------------------------------------------------------------ the run server

def default_workspace() -> dict:
    """The folders a server started here works on: ``FAIRBEAM_WORKSPACE`` or ~/Documents/Fairbeam
    (the desktop app's default workspace), also from a source checkout, so what an assistant makes
    appears in the app. Its jobs folder is its own: a later app start is not blocked."""
    from .appstate import state_dir

    root = Path(os.environ.get("FAIRBEAM_WORKSPACE") or Path.home() / "Documents" / "Fairbeam")
    return {"models": root / "models", "projects": root / "projects",
            "jobs": state_dir() / "mcp-jobs", "sim": root / ".sim"}


class Backend:
    """Finds (or starts) the run server and sends it JSON requests."""

    def __init__(self, server: str | None = None, embedded: bool = True, log=None):
        self.explicit = server or os.environ.get("FAIRBEAM_SERVER") or None
        self.embedded_allowed = embedded
        self.log = log or (lambda msg: print(f"fairbeam mcp: {msg}", file=sys.stderr, flush=True))
        self._embedded = None  # (base, httpd, owner)
        self._lock = threading.Lock()
        self.source = None

    def base(self) -> str:
        from .appstate import read_server_record, resolve_server, server_alive

        if self.explicit:
            self.source = "explicit"
            return resolve_server(self.explicit)
        rec = read_server_record()
        if rec is not None and rec.get("checkout") is not True and server_alive(rec):
            self.source = "app"
            return rec["url"].rstrip("/")
        if not self.embedded_allowed:
            raise ToolError("no running Fairbeam app found; open Fairbeam, or start `fairbeam mcp` without --no-embedded")
        self.source = "embedded"
        return self._start_embedded()

    def _start_embedded(self) -> str:
        with self._lock:
            if self._embedded is not None:
                return self._embedded[0]
            from .jobs_owner import JobsOwner
            from .server import App, make_server

            ws = default_workspace()
            for key in ("models", "projects", "sim"):
                ws[key].mkdir(parents=True, exist_ok=True)
            owner = JobsOwner(ws["jobs"])
            owner.__enter__()
            app = App(models_dir=ws["models"], projects_dir=ws["projects"], jobs_dir=owner.root, port=0,
                      python=None, ui_dir=None, sim_root=ws["sim"])
            httpd = make_server(app, "127.0.0.1", 0, quiet=True)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            threading.Thread(target=httpd.serve_forever, name="fairbeam-mcp-server", daemon=True).start()
            self._embedded = (base, httpd, owner)
            self.log(f"started a run server at {base} (models {ws['models']}, projects {ws['projects']})")
            return base

    def close(self):
        if self._embedded is not None:
            _, httpd, owner = self._embedded
            try:
                httpd.shutdown()
            finally:
                owner.__exit__(None, None, None)
            self._embedded = None

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 60.0):
        from .cli import _http

        try:
            return _http(method, f"{self.base()}{path}", body, timeout=timeout)
        except ValueError as e:
            raise ToolError(str(e)) from None


# ------------------------------------------------------------------ result summaries

def _db(re_, im):
    return 20 * math.log10(max(math.hypot(re_, im), 1e-12))


def _ghz(hz: float) -> float:
    return round(hz / 1e9, 9)


def _freq_text(hz: float) -> str:
    if hz < 1e9:
        return f"{hz / 1e6:.4g} MHz"
    return f"{hz / 1e9:.4g} GHz"


def summarize_bundle(b: dict, include_curves: bool = False, max_points: int = 101) -> dict:
    """What an assistant needs from a result bundle: the band, resonances, matching, input
    impedance, far-field figures and how the run ended. Frequencies in GHz (plus a readable text)."""
    r = b.get("results") or {}
    out: dict = {"name": b.get("name"), "model": (b.get("model") or {}).get("id") if isinstance(b.get("model"), dict) else b.get("model"),
                 "created": b.get("created")}
    run = b.get("run") or {}
    out["run"] = {k: run.get(k) for k in ("converged", "timesteps", "hit_timestep_limit", "solver_time_s", "wall_time_total_s",
                                          "threads", "engine", "final_energy_db", "final_energy_bound_db") if run.get(k) is not None}
    mesh = b.get("mesh") or {}
    cells = mesh.get("cells")
    if isinstance(cells, list) and cells:
        out["mesh"] = {"lines": cells, "cells": math.prod(int(c) for c in cells)}
    f = r.get("frequency") or []
    if f:
        out["band_ghz"] = [_ghz(f[0]), _ghz(f[-1])]
        out["band_text"] = f"{_freq_text(f[0])} – {_freq_text(f[-1])}"
    ports = r.get("ports") or {}
    port_items = list(ports.items()) if isinstance(ports, dict) else [(str(i + 1), p) for i, p in enumerate(ports)]
    summaries = []
    for key, p in port_items:
        if not isinstance(p, dict) or "s11_re" not in p or not f:
            continue
        s11 = [_db(a, c) for a, c in zip(p["s11_re"], p["s11_im"])]
        k = min(range(len(s11)), key=lambda i: s11[i])
        mag = math.hypot(p["s11_re"][k], p["s11_im"][k])
        port = {"port": key, "z_ref_ohm": p.get("z_ref"), "min_s11_db": round(s11[k], 2),
                "f_min_s11_ghz": _ghz(f[k]), "f_min_s11_text": _freq_text(f[k]),
                "vswr_at_min": round((1 + mag) / (1 - mag), 3) if mag < 1 else None}
        if "zin_re" in p:
            port["zin_at_min_ohm"] = [round(p["zin_re"][k], 2), round(p["zin_im"][k], 2)]
        below = [i for i, v in enumerate(s11) if v <= -10]
        if below:
            port["below_minus10db_ghz"] = [_ghz(f[below[0]]), _ghz(f[below[-1]])]
        if include_curves:
            step = max(1, math.ceil(len(f) / max(2, max_points)))
            idx = list(range(0, len(f), step))
            if idx[-1] != len(f) - 1:
                idx.append(len(f) - 1)
            port["curve"] = {"f_ghz": [_ghz(f[i]) for i in idx], "s11_db": [round(s11[i], 3) for i in idx]}
            if "zin_re" in p:
                port["curve"]["zin_re_ohm"] = [round(p["zin_re"][i], 3) for i in idx]
                port["curve"]["zin_im_ohm"] = [round(p["zin_im"][i], 3) for i in idx]
        summaries.append(port)
    if summaries:
        out["ports"] = summaries
    bands = r.get("bands") or []
    if bands:
        out["matched_bands"] = [{"f_lo_ghz": _ghz(x["f_lo"]), "f_hi_ghz": _ghz(x["f_hi"]), "f_center_ghz": _ghz(x["f_center"]),
                                 "text": f"{_freq_text(x['f_lo'])} – {_freq_text(x['f_hi'])}", "s11_min_db": x.get("s11_min_db"),
                                 "fractional_bw": x.get("fractional_bw"), "touches_band_edge": bool(x.get("edge_lo") or x.get("edge_hi"))}
                                for x in bands if isinstance(x, dict) and "f_lo" in x]
    ff = []
    for x in r.get("farfield") or []:
        if not isinstance(x, dict) or "f" not in x:
            continue
        item = {"f_ghz": _ghz(x["f"]), "text": _freq_text(x["f"])}
        for k in ("dmax_dbi", "gain_dbi", "realized_gain_dbi", "rad_efficiency", "port"):
            if isinstance(x.get(k), (int, float)) and not isinstance(x.get(k), bool):
                item[k] = round(x[k], 4)
        ff.append(item)
    if ff:
        out["far_field"] = ff
    out["note"] = "Simulated with openEMS (FDTD); not a measurement. Check mesh convergence before relying on exact numbers."
    return out


def summarize_checks(checks: list) -> dict:
    by = {"error": [], "warning": [], "info": []}
    for c in checks or []:
        if isinstance(c, dict):
            by.setdefault(c.get("severity", "info"), []).append(
                {k: c[k] for k in ("code", "path", "message", "explain") if c.get(k)})
    return {"ok_to_run": not by["error"], "errors": by["error"], "warnings": by["warning"], "notes": by["info"]}


DESIGN_GUIDE = """# Fairbeam design files (fairbeam.design/1), in short

A design is JSON. Lengths are mm, frequencies GHz; any value may be a number or an expression over
the parameters (`W/2`, `wavelength(f0)/4`, `f0*0.6`; functions sqrt, sin, cos, min, max, ...).

{
  "schema": "fairbeam.design/1",
  "model": {"id": "my-dipole", "name": "My dipole", "description": "..."},
  "units": {"length": "mm", "frequency": "GHz"},          # optional: how the app SHOWS values
  "params": [{"key": "f0", "default": 2.45, "unit": "GHz", "label": "Design frequency"},
             {"key": "L", "expr": "0.95*wavelength(f0)/2", "unit": "mm"}],
  "simulation": {"f_min": "f0*0.6", "f_max": "f0*1.4", "boundaries": "PML_8", "end_criteria_db": -50},
  "materials": [{"name": "copper", "kind": "metal", "library": "pec"},
                {"name": "FR4", "kind": "dielectric", "eps_r": 4.3, "tan_d": 0.02, "tan_d_freq": "f0"}],
  "parts": [{"name": "arm_top", "material": "copper",
             "primitives": [{"kind": "box", "start": ["-w/2", "g/2", 0], "stop": ["w/2", "L/2", 0]}]}],
  "ports": [{"type": "lumped", "number": 1, "R": 50, "start": ["-w/2", "-g/2", 0], "stop": ["w/2", "g/2", 0],
             "direction": "y", "excite": true}],
  "resistors": [],
  "mesh": {"mode": "design", "overrides": {}, "refine_features": false},
  "far_field": {"enabled": true, "frequencies": ["f0"]}
}

Primitives: box {start, stop}; cylinder {axis, center[2], radius, range[2]} or {start, stop, radius};
sphere {center, radius}; polygon {normal, elevation, points[[u,v]...]}; linpoly (polygon + length);
cone; torus; wire {points, radius}; polyhedron. A box with zero thickness along one axis is a sheet
(thin metal). Part "transforms": move {offset}, rotate {axis, center, angle, copies}, mirror {plane, keep}.

Rules of thumb: put the antenna at the origin; a lumped port bridges a small feed gap between two
conductors, its direction along the gap; FDTD time grows with fine cells and low frequencies (below
~100 MHz keep millimeter details out); run check_design and fix every error before run_simulation.
The examples (list_designs, readonly ones) are good starting points: create_design with from_design
copies one. docs/DESIGNER.md in the Fairbeam repository is the full reference."""


# ------------------------------------------------------------------ tools

def _obj(props: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


DESIGN_ID = {"type": "string", "description": "design id (file name without .design.json), from list_designs"}

TOOLS = [
    {"name": "status", "title": "Fairbeam status",
     "description": "Fairbeam version, the run server in use (the open app or one started here), solver engines, CPU, workspace folders and the run queue.",
     "inputSchema": _obj({}), "annotations": {"readOnlyHint": True}},
    {"name": "list_designs", "title": "List designs",
     "description": "The designs and models in the workspace: the user's editable designs and the read-only bundled examples. Optional text filter.",
     "inputSchema": _obj({"query": {"type": "string", "description": "case-insensitive filter on id or name"},
                          "include_examples": {"type": "boolean", "default": True}}),
     "annotations": {"readOnlyHint": True}},
    {"name": "get_design", "title": "Read a design",
     "description": "The full design JSON of a design (lengths mm, frequencies GHz) and its hash (pass it to update_design to avoid overwriting newer edits).",
     "inputSchema": _obj({"id": DESIGN_ID}, ["id"]), "annotations": {"readOnlyHint": True}},
    {"name": "design_format_guide", "title": "Design format guide",
     "description": "A short guide to the design file format (parameters, materials, parts and primitives, ports, mesh, far field) for writing or editing designs.",
     "inputSchema": _obj({}), "annotations": {"readOnlyHint": True}},
    {"name": "create_design", "title": "Create a design",
     "description": "Create a new editable design: from a starter template (empty, patch, dipole, monopole, sleeve-dipole, open-waveguide, microstrip, inset-patch), as a copy of another design or example (from_design), or from a full design JSON you wrote (design). Returns its id.",
     "inputSchema": _obj({"name": {"type": "string", "description": "display name, one line"},
                          "template": {"type": "string", "enum": ["empty", "patch", "dipole", "monopole", "sleeve-dipole", "open-waveguide", "microstrip", "inset-patch"]},
                          "from_design": {"type": "string", "description": "id of a design or example to copy"},
                          "design": {"type": "object", "description": "a complete fairbeam.design/1 object"}}, ["name"]),
     "annotations": {"destructiveHint": False}},
    {"name": "update_design", "title": "Save a design",
     "description": "Replace a design with an edited version (the whole design JSON). Pass the hash from get_design so newer edits made in the app are not overwritten. Returns the new hash and the design checks.",
     "inputSchema": _obj({"id": DESIGN_ID, "design": {"type": "object"}, "base_hash": {"type": "string"}}, ["id", "design"]),
     "annotations": {"destructiveHint": True, "idempotentHint": True}},
    {"name": "set_parameters", "title": "Set parameters",
     "description": "Change parameter values of a design and save it: {\"f0\": 0.0071, \"L\": \"0.95*wavelength(f0)/2\"}. Numbers in the parameter's canonical unit (mm, GHz); strings are expressions. Returns the checks.",
     "inputSchema": _obj({"id": DESIGN_ID, "values": {"type": "object", "additionalProperties": {"type": ["number", "string"]}}}, ["id", "values"]),
     "annotations": {"destructiveHint": True, "idempotentHint": True}},
    {"name": "check_design", "title": "Check a design",
     "description": "Build the design without simulating: errors (must be fixed before running), warnings and notes, plus the mesh size. Give a design id, or an unsaved design JSON. Optional parameter overrides.",
     "inputSchema": _obj({"id": DESIGN_ID, "design": {"type": "object"},
                          "params": {"type": "object", "description": "parameter overrides for this check"}}),
     "annotations": {"readOnlyHint": True}},
    {"name": "run_simulation", "title": "Run a simulation",
     "description": "Queue an openEMS simulation of a design on the user's machine (runs go one at a time) and, by default, wait for it and return the results summary. Use check_design first. Optional parameter overrides, thread count, frequency points and energy end criterion.",
     "inputSchema": _obj({"id": DESIGN_ID, "params": {"type": "object"},
                          "threads": {"type": "integer", "minimum": 1}, "engine": {"type": "string", "enum": ["cpu", "gpu"]},
                          "points": {"type": "integer", "minimum": 11, "maximum": 4001, "description": "frequency points (default 801)"},
                          "end_criteria_db": {"type": "number", "maximum": -10, "description": "stop when the field energy falls this far, e.g. -40 for a quick look"},
                          "name": {"type": "string", "description": "result name shown in the app"},
                          "wait": {"type": "boolean", "default": True},
                          "timeout_s": {"type": "number", "default": 900, "description": "how long to wait before returning the run id (the run goes on)"}},
                         ["id"]),
     "annotations": {"destructiveHint": False, "openWorldHint": False}},
    {"name": "run_status", "title": "Run status",
     "description": "Status of a run: queued, running (timestep, field energy, estimated time left), done (result name) or failed (error).",
     "inputSchema": _obj({"run_id": {"type": "string"}}, ["run_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "list_runs", "title": "Recent runs",
     "description": "The most recent runs on the run server, newest first.",
     "inputSchema": _obj({"limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10}}),
     "annotations": {"readOnlyHint": True}},
    {"name": "cancel_run", "title": "Cancel a run",
     "description": "Stop a queued or running simulation.",
     "inputSchema": _obj({"run_id": {"type": "string"}}, ["run_id"]), "annotations": {"destructiveHint": True}},
    {"name": "parameter_sweep", "title": "Parameter sweep",
     "description": "Queue one run per value of one or two numeric parameters (cartesian), e.g. {\"key\": \"L\", \"values\": [140, 145, 150]}. Returns the run ids; follow them with run_status and compare with get_results.",
     "inputSchema": _obj({"id": DESIGN_ID,
                          "axes": {"type": "array", "minItems": 1, "maxItems": 2, "items": _obj(
                              {"key": {"type": "string"}, "values": {"type": "array", "items": {"type": "number"}},
                               "start": {"type": "number"}, "stop": {"type": "number"}, "steps": {"type": "integer"}}, ["key"])},
                          "params": {"type": "object"}, "threads": {"type": "integer", "minimum": 1},
                          "end_criteria_db": {"type": "number", "maximum": -10}}, ["id", "axes"]),
     "annotations": {"destructiveHint": False}},
    {"name": "list_results", "title": "List results",
     "description": "The result bundles in the workspace (simulations and examples), newest first, with band and mesh size.",
     "inputSchema": _obj({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20}}),
     "annotations": {"readOnlyHint": True}},
    {"name": "get_results", "title": "Read results",
     "description": "Summary of a result: band, frequency of minimum S11, matched (-10 dB) bands and fractional bandwidth, input impedance, VSWR, directivity/gain/efficiency and how the run ended. Give a run id or a result file name. include_curves adds downsampled S11 and Zin curves.",
     "inputSchema": _obj({"run_id": {"type": "string"}, "result": {"type": "string", "description": "result file name, e.g. hf-dipole-7mhz.json"},
                          "include_curves": {"type": "boolean", "default": False},
                          "max_points": {"type": "integer", "minimum": 11, "maximum": 801, "default": 101}}),
     "annotations": {"readOnlyHint": True}},
    {"name": "export_touchstone", "title": "Export Touchstone",
     "description": "Write a result's S-parameters as a Touchstone file (.s1p, .s2p, ...) next to the result, or to a given path, and return the path.",
     "inputSchema": _obj({"result": {"type": "string"}, "run_id": {"type": "string"}, "path": {"type": "string"},
                          "z_ref_ohm": {"type": ["number", "null"], "default": 50, "description": "renormalize to this impedance; 0 or null keeps the ports' own"}}),
     "annotations": {"destructiveHint": False}},
]


class Tools:
    def __init__(self, backend: Backend):
        self.b = backend

    # -- helpers
    def _health(self) -> dict:
        h = self.b.request("GET", "/api/health")
        return h if isinstance(h, dict) else {}

    def _projects_dir(self) -> Path:
        d = self._health().get("projects_dir")
        if not d:
            raise ToolError("the run server did not say where its results are")
        return Path(d)

    def _read_design(self, design_id: str) -> dict:
        return self.b.request("GET", f"/api/designs/{design_id}")

    def _job(self, run_id: str) -> dict:
        return self.b.request("GET", f"/api/runs/{run_id}")

    def _bundle_path(self, result: str | None, run_id: str | None) -> Path:
        if run_id:
            job = self._job(run_id)
            if job.get("status") != "done" or not job.get("bundle"):
                raise ToolError(f"run {run_id} is {job.get('status')}; it has no result yet")
            result = job["bundle"]
        if not result:
            raise ToolError("give run_id or result")
        name = Path(result).name
        if not name.endswith(".json"):
            name += ".json"
        path = self._projects_dir() / name
        if not path.is_file():
            raise ToolError(f"no result {name} in {path.parent}")
        return path

    # -- tools
    def status(self, _):
        h = self._health()
        q = h.get("queue") if isinstance(h.get("queue"), dict) else {}
        return {"fairbeam": h.get("version"), "server": self.b.base(), "server_source": self.b.source,
                "engines": h.get("engines"), "cpu_count": h.get("cpu_count"), "host_cpu": h.get("host_cpu"),
                "models_dir": h.get("models_dir"), "projects_dir": h.get("projects_dir"),
                "queue": {"running": q.get("running"), "queued": q.get("queued")},
                "units": "lengths mm, frequencies GHz", "mcp_server": __version__}

    def list_designs(self, a):
        models = (self.b.request("GET", "/api/models") or {}).get("models") or []
        query = (a.get("query") or "").lower()
        out = []
        for m in models:
            if not isinstance(m, dict):
                continue
            readonly = bool(m.get("readonly"))
            if readonly and a.get("include_examples") is False:
                continue
            model = m.get("model") if isinstance(m.get("model"), dict) else {}
            item = {"id": m.get("key"), "name": model.get("name") or m.get("name"), "kind": m.get("kind"),
                    "example": readonly, "file": m.get("file")}
            if query and query not in f"{item['id']} {item['name']}".lower():
                continue
            if m.get("error"):
                item["error"] = m["error"] if isinstance(m["error"], str) else json.dumps(m["error"])[:300]
            out.append(item)
        return {"designs": out, "count": len(out),
                "hint": "examples are read-only: copy one with create_design(from_design=...) to edit it"}

    def get_design(self, a):
        rec = self._read_design(a["id"])
        return {"id": a["id"], "hash": rec.get("hash"), "readonly": rec.get("readonly"), "design": rec.get("design")}

    def design_format_guide(self, _):
        return {"guide": DESIGN_GUIDE}

    def create_design(self, a):
        body: dict = {"name": a["name"]}
        if a.get("design") is not None:
            body["design"] = a["design"]
        elif a.get("from_design"):
            body["from"] = a["from_design"]
            body["id"] = self._free_id(a["name"])
        else:
            body["template"] = a.get("template") or "empty"
            body["id"] = self._free_id(a["name"])
        if "from" in body and self._is_example(body["from"]):
            # an example's source is read-only and copies through its own route
            res = self.b.request("POST", "/api/examples/copy", {"id": body["id"], "name": a["name"], "from": body["from"]})
        else:
            res = self.b.request("POST", "/api/designs", body)
        out = {"id": res.get("id"), "kind": res.get("kind", "design")}
        if res.get("validation"):
            out["validation"] = res["validation"]
        return out

    def _is_example(self, design_id: str) -> bool:
        models = (self.b.request("GET", "/api/models") or {}).get("models") or []
        return any(isinstance(m, dict) and m.get("key") == design_id and m.get("readonly") for m in models)

    def _free_id(self, name: str) -> str:
        import re

        base = re.sub(r"[^a-z0-9]+", "_", name.lower().replace("ı", "i")).strip("_")
        base = re.sub(r"^[^a-z]+", "", base)[:36] or "design"
        if len(base) < 2:
            base = f"{base}_design"
        keys = {m.get("key") for m in (self.b.request("GET", "/api/models") or {}).get("models") or [] if isinstance(m, dict)}
        if base not in keys:
            return base
        for n in range(2, 1000):
            if f"{base}_{n}" not in keys:
                return f"{base}_{n}"
        raise ToolError("no free design id")

    def update_design(self, a):
        body = {"design": a["design"]}
        if a.get("base_hash"):
            body["base_hash"] = a["base_hash"]
        res = self.b.request("PUT", f"/api/designs/{a['id']}", body)
        out = {"id": a["id"], "hash": res.get("hash")}
        out["checks"] = self.check_design({"id": a["id"]})
        return out

    def set_parameters(self, a):
        rec = self._read_design(a["id"])
        if rec.get("readonly"):
            raise ToolError(f"{a['id']} is a read-only example; copy it with create_design(from_design=...) first")
        design = rec["design"]
        params = {p.get("key"): p for p in design.get("params") or [] if isinstance(p, dict)}
        unknown = [k for k in a["values"] if k not in params]
        if unknown:
            raise ToolError(f"unknown parameter(s) {', '.join(unknown)}; the design has {', '.join(params)}")
        changed = {}
        for key, value in a["values"].items():
            p = params[key]
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                raise ToolError(f"{key}: give a number or an expression string")
            if isinstance(value, str):
                p["expr"] = value
                p.pop("default", None)
            else:
                p["default"] = value
                p.pop("expr", None)
            changed[key] = value
        res = self.b.request("PUT", f"/api/designs/{a['id']}", {"design": design, "base_hash": rec.get("hash")})
        return {"id": a["id"], "changed": changed, "hash": res.get("hash"), "checks": self.check_design({"id": a["id"]})}

    def check_design(self, a):
        design = a.get("design")
        if design is None:
            if not a.get("id"):
                raise ToolError("give id or design")
            design = self._read_design(a["id"])["design"]
        body = {"design": design}
        if a.get("params"):
            body["params"] = a["params"]
        try:
            res = self.b.request("POST", "/api/preview", body, timeout=180)
        except ToolError as e:
            return {"ok_to_run": False, "build_error": str(e)}
        out = summarize_checks(res.get("checks"))
        mesh = (res.get("bundle") or {}).get("mesh") or {}
        cells = mesh.get("cells")
        if isinstance(cells, list) and cells:
            out["mesh"] = {"lines": cells, "cells": math.prod(int(c) for c in cells)}
        out["build_s"] = res.get("build_s")
        return out

    def _run_body(self, a) -> dict:
        body: dict = {"model": a["id"], "params": a.get("params") or {}}
        for k in ("threads", "engine", "points", "end_criteria_db"):
            if a.get(k) is not None:
                body[k] = a[k]
        if a.get("name"):
            body["name"] = a["name"]
        return body

    def run_simulation(self, a):
        job = self.b.request("POST", "/api/runs", self._run_body(a), timeout=120)
        run_id = job["id"]
        out = {"run_id": run_id, "status": job.get("status"), "server": self.b.base()}
        pre = job.get("preflight")
        if isinstance(pre, dict) and pre.get("estimate"):
            out["estimate"] = pre["estimate"]
        if a.get("wait") is False:
            out["hint"] = "follow it with run_status; read it with get_results when done"
            return out
        deadline = time.time() + float(a.get("timeout_s") or 900)
        while time.time() < deadline:
            job = self._job(run_id)
            if job.get("status") in TERMINAL:
                break
            time.sleep(2.0)
        out.update(self._job_summary(job))
        if job.get("status") == "done" and job.get("bundle"):
            out["results"] = self.get_results({"result": job["bundle"]})
        elif job.get("status") not in TERMINAL:
            out["hint"] = f"still {job.get('status')} after {a.get('timeout_s') or 900:g} s; it goes on; follow it with run_status"
        return out

    def _job_summary(self, job: dict) -> dict:
        out = {k: job.get(k) for k in ("id", "status", "phase", "model", "bundle", "error", "duration_s") if job.get(k) is not None}
        out["run_id"] = out.pop("id", None)
        p = job.get("last_progress") if isinstance(job.get("last_progress"), dict) else None
        if p:
            prog = {k: p.get(k) for k in ("timestep", "energy_db", "timestep_fraction") if p.get(k) is not None}
            eta = p.get("eta") if isinstance(p.get("eta"), dict) else {}
            if eta.get("eta_s") is not None:
                prog["eta_s"] = eta["eta_s"]
            out["progress"] = prog
        stats = job.get("stats") if isinstance(job.get("stats"), dict) else {}
        if stats:
            out["stats"] = {k: stats.get(k) for k in ("timesteps", "solver_time_s", "converged", "hit_timestep_limit") if stats.get(k) is not None}
        return out

    def run_status(self, a):
        return self._job_summary(self._job(a["run_id"]))

    def list_runs(self, a):
        runs = (self.b.request("GET", "/api/runs?summary=1") or {}).get("runs") or []
        runs = sorted((r for r in runs if isinstance(r, dict)), key=lambda r: r.get("created") or 0, reverse=True)
        return {"runs": [self._job_summary(r) for r in runs[: int(a.get("limit") or 10)]]}

    def cancel_run(self, a):
        self.b.request("POST", f"/api/runs/{a['run_id']}/cancel", {})
        return self._job_summary(self._job(a["run_id"]))

    def parameter_sweep(self, a):
        body: dict = {"model": a["id"], "params": a.get("params") or {}, "sweep": a["axes"]}
        for k in ("threads", "end_criteria_db"):
            if a.get(k) is not None:
                body[k] = a[k]
        res = self.b.request("POST", "/api/sweeps", body, timeout=120)
        jobs = res.get("jobs") or []
        return {"sweep_id": res.get("id") or res.get("sweep_id"), "runs": [j.get("id") for j in jobs if isinstance(j, dict)],
                "count": len(jobs), "hint": "runs go one at a time; follow them with run_status and compare get_results"}

    def list_results(self, a):
        folder = self._projects_dir()
        query = (a.get("query") or "").lower()
        items = []
        for path in sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            if path.name == "index.json":
                continue
            try:
                b = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(b, dict) or "results" not in b:
                continue
            name = b.get("name") or path.stem
            if query and query not in f"{path.name} {name}".lower():
                continue
            f = (b.get("results") or {}).get("frequency") or []
            items.append({"result": path.name, "name": name, "created": b.get("created"),
                          "band": f"{_freq_text(f[0])} – {_freq_text(f[-1])}" if f else None})
            if len(items) >= int(a.get("limit") or 20):
                break
        return {"results": items, "folder": str(folder)}

    def get_results(self, a):
        path = self._bundle_path(a.get("result"), a.get("run_id"))
        b = json.loads(path.read_text(encoding="utf-8"))
        out = summarize_bundle(b, bool(a.get("include_curves")), int(a.get("max_points") or 101))
        out["result"] = path.name
        return out

    def export_touchstone(self, a):
        from .touchstone import write_s1p, write_snp

        path = self._bundle_path(a.get("result"), a.get("run_id"))
        b = json.loads(path.read_text(encoding="utf-8"))
        sp = (b.get("results") or {}).get("sparams")
        n = len(sp["ports"]) if isinstance(sp, dict) and sp.get("ports") else 1
        z = a.get("z_ref_ohm", 50.0)
        z = None if z in (None, 0) else float(z)
        target = Path(a["path"]).expanduser() if a.get("path") else path.with_suffix(f".s{n}p")
        if n == 1:
            write_s1p(b, target, z_ref=z)
        else:
            write_snp(b, target, z_ref=z)
        return {"path": str(target), "ports": n, "z_ref_ohm": z if z is not None else "the ports' own impedance"}


# ------------------------------------------------------------------ resources and prompts

RESOURCES = [
    {"uri": "fairbeam://guide/design-format", "name": "design-format", "title": "Fairbeam design format",
     "description": "How a fairbeam.design/1 file is written", "mimeType": "text/markdown"},
]

PROMPTS = [
    {"name": "design_antenna", "title": "Design an antenna",
     "description": "Create, check, simulate and tune an antenna for a frequency",
     "arguments": [{"name": "antenna", "description": "e.g. half-wave dipole, patch on FR-4", "required": True},
                   {"name": "frequency", "description": "e.g. 2.45 GHz or 7.1 MHz", "required": True}]},
    {"name": "review_result", "title": "Review a result",
     "description": "Explain a simulation result: matching, bandwidth, impedance, pattern and caveats",
     "arguments": [{"name": "result", "description": "result file name or run id", "required": True}]},
]


def prompt_messages(name: str, args: dict) -> list:
    if name == "design_antenna":
        text = (f"Design a {args.get('antenna', 'antenna')} for {args.get('frequency', 'the target frequency')} with Fairbeam. "
                "Start from the closest starter template or example (list_designs, create_design), convert the frequency to GHz, "
                "set the parameters, run check_design and fix every error, then run_simulation with a quick end criterion "
                "(-40 dB) first. Report the frequency of minimum S11, the -10 dB bandwidth and the input impedance, adjust the "
                "length or size to move the resonance onto the target, and rerun. Keep the user informed of run times.")
    elif name == "review_result":
        text = (f"Read the Fairbeam result {args.get('result', '')} with get_results (include_curves) and explain it for an RF "
                "engineer: where it resonates, how well it is matched and over what bandwidth, the input impedance, the far-field "
                "figures if present, and whether the run converged. Point out what would make the numbers more trustworthy "
                "(mesh convergence, boundary distance).")
    else:
        raise KeyError(name)
    return [{"role": "user", "content": {"type": "text", "text": text}}]


# ------------------------------------------------------------------ the protocol

class Server:
    def __init__(self, backend: Backend):
        self.backend = backend
        self.tools = Tools(backend)
        self.by_name = {t["name"]: t for t in TOOLS}

    def handle(self, msg: dict) -> dict | None:
        """One JSON-RPC message in, its answer out (None for notifications)."""
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            return _error(msg.get("id") if isinstance(msg, dict) else None, -32600, "invalid request")
        method, mid, params = msg["method"], msg.get("id"), msg.get("params") or {}
        if "id" not in msg:
            return None  # notifications: initialized, cancelled, ...
        try:
            result = self._dispatch(method, params)
        except _RpcError as e:
            return _error(mid, e.code, e.message)
        except Exception as e:  # never let one request take the server down
            return _error(mid, -32603, f"internal error: {e}")
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def _dispatch(self, method: str, params: dict):
        if method == "initialize":
            asked = params.get("protocolVersion")
            return {"protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                    "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False},
                                     "prompts": {"listChanged": False}},
                    "serverInfo": {"name": "fairbeam", "title": "Fairbeam", "version": __version__},
                    "instructions": SERVER_INSTRUCTIONS}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            return self._call(params.get("name"), params.get("arguments") or {})
        if method == "resources/list":
            return {"resources": RESOURCES}
        if method == "resources/templates/list":
            return {"resourceTemplates": []}
        if method == "resources/read":
            if params.get("uri") != "fairbeam://guide/design-format":
                raise _RpcError(-32002, f"resource not found: {params.get('uri')}")
            return {"contents": [{"uri": params["uri"], "mimeType": "text/markdown", "text": DESIGN_GUIDE}]}
        if method == "prompts/list":
            return {"prompts": PROMPTS}
        if method == "prompts/get":
            try:
                return {"messages": prompt_messages(params.get("name"), params.get("arguments") or {})}
            except KeyError:
                raise _RpcError(-32602, f"unknown prompt {params.get('name')!r}") from None
        if method == "logging/setLevel":
            return {}
        raise _RpcError(-32601, f"method not found: {method}")

    def _call(self, name, args):
        tool = self.by_name.get(name)
        if tool is None:
            raise _RpcError(-32602, f"unknown tool {name!r}")
        if not isinstance(args, dict):
            raise _RpcError(-32602, "arguments must be an object")
        missing = [k for k in tool["inputSchema"].get("required", []) if k not in args]
        if missing:
            return _tool_error(f"missing argument(s): {', '.join(missing)}")
        try:
            data = getattr(self.tools, name)(args)
        except ToolError as e:
            return _tool_error(str(e))
        text = json.dumps(data, ensure_ascii=False, indent=1, default=str)
        return {"content": [{"type": "text", "text": text}], "structuredContent": data, "isError": False}


class _RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _error(mid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def _tool_error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def serve_stdio(server: Server, stdin=None, stdout=None) -> None:
    """Read JSON-RPC messages line by line until stdin closes; answer each on one line."""
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    write_lock = threading.Lock()

    def send(obj):
        data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str) + "\n").encode("utf-8")
        with write_lock:
            stdout.write(data)
            stdout.flush()

    for raw in stdin:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send(_error(None, -32700, "parse error"))
            continue
        if isinstance(msg, list):  # batches (older protocol versions)
            answers = [a for a in (server.handle(m) for m in msg) if a is not None]
            if answers:
                send(answers)
            continue
        answer = server.handle(msg)
        if answer is not None:
            send(answer)


def client_config(python: str | None = None) -> dict:
    """How an MCP client starts this server: the Python running now, the folder of this package and
    the openEMS install the run server uses (the desktop app sets both for its own server)."""
    python = python or sys.executable
    env = {"PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    for key in ("OPENEMS_INSTALL_PATH", "CSXCAD_INSTALL_PATH"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    entry = {"command": python, "args": ["-m", "fairbeam", "mcp"], "env": env}
    flags = " ".join(f"--env {k}={json.dumps(v)}" for k, v in env.items())
    return {"mcpServers": {"fairbeam": entry},
            "claude_code": f"claude mcp add fairbeam --scope user {flags} -- {json.dumps(python)} -m fairbeam mcp"}


def main(server_url: str | None = None, embedded: bool = True) -> int:
    backend = Backend(server_url, embedded=embedded)
    print(f"fairbeam mcp {__version__}: ready on stdio", file=sys.stderr, flush=True)
    try:
        serve_stdio(Server(backend))
    except KeyboardInterrupt:
        pass
    finally:
        backend.close()
    return 0
