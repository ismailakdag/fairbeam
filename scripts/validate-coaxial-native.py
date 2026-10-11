"""Bounded synthetic coax controls. Run sequentially with a native openEMS Python environment.

Independent reference: lossless TEM line Z0=eta0/(2*pi)*ln(b/a), beta=2*pi*f/c.
These controls assess the Cartesian port implementation, not arbitrary cylindrical sources.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import time

import numpy as np
import openEMS
from fairbeam.simulation import Simulation

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--case", choices=["through", "open", "short"], default="through")
parser.add_argument("--step", type=float, default=0.25)
parser.add_argument("--reuse-solve", help="Reprocess retained raw probes without starting another solve")
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=False)
start_time = time.time()
manifest = dict(case=args.case, transverse_step_mm=args.step, domain_mm=[[-3.5, -3.5, -50], [3.5, 3.5, 50]],
                radii_mm=[1, 3, 3.5], band_hz=[1e9, 2e9], source="synthetic analytical control",
                openems_version=openEMS.__version__, runtime=openEMS.__file__, python=platform.python_version(),
                generator_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), status="started")
(out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
try:
    boundary = "PML_8" if args.case == "through" else "PMC" if args.case == "open" else "PEC"
    sim = Simulation(1e9, 2e9, excitation="gauss", boundaries=["PEC"] * 4 + ["PML_8", boundary], end_criteria_db=-50, max_timesteps=30000)
    metal = sim.metal("Analytical coax PEC")
    metal.AddCylinder([0, 0, -50], [0, 0, 50], 1, priority=5)
    metal.AddCylindricalShell([0, 0, -50], [0, 0, 50], 3.25, .5, priority=5)
    sim.coaxial_port(1, [0, 0, -50], [0, 0, -10], "z", 1, 3, 3.5, feed_shift=12, measurement_shift=25)
    if args.case == "through":
        sim.coaxial_port(2, [0, 0, 50], [0, 0, 10], "z", 1, 3, 3.5, excite=False, measurement_shift=25)
    for axis in "xy":
        sim.mesh.AddLine(axis, np.linspace(-3.5, 3.5, int(round(7 / args.step)) + 1))
    sim.mesh.AddLine("z", np.arange(-50, 50.01, 1))
    sim.finalize_coaxial_ports()
    manifest.update(status="model_built", cells=int(np.prod([len(sim.mesh.GetLines(a)) - 1 for a in "xyz"])), ports=sim.ports)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    solve = Path(args.reuse_solve).resolve() if args.reuse_solve else out / "solve"
    stats = {"reused_probe_directory": str(solve)} if args.reuse_solve else sim.run(str(solve), threads=2, engine="cpu")
    freq = np.linspace(1e9, 2e9, 51)
    for port in sim._port_objs:
        port.CalcPort(str(solve), freq)
    native_z = np.asarray(sim._port_objs[0].Z_ref).copy()
    for port, metadata in zip(sim._port_objs, sim.ports):
        port.CalcPort(str(solve), freq, ref_impedance=metadata["R"])
    first = sim._port_objs[0]
    s11 = first.uf_ref / first.uf_inc
    response = sim._port_objs[1].uf_ref / first.uf_inc if args.case == "through" else s11
    length_m = .05 if args.case == "through" else .15
    reference = np.exp(-1j * 2 * np.pi * freq / 299792458 * length_m) * (-1 if args.case == "short" else 1)
    np.savetxt(out / "complex.csv", np.c_[freq, s11.real, s11.imag, response.real, response.imag, reference.real, reference.imag], delimiter=",", header="frequency_hz,s11_re,s11_im,response_re,response_im,reference_re,reference_im", comments="")
    manifest.update(status="results_exported", stats=stats, elapsed_s=time.time()-start_time,
                    finite=bool(np.isfinite(response).all()), max_complex_error=float(max(abs(response-reference))),
                    max_magnitude_error=float(max(abs(abs(response)-1))), max_s11=float(max(abs(s11))),
                    nominal_z0_ohm=376.730313668/(2*np.pi)*np.log(3), measured_z_real_range=[float(min(native_z.real)), float(max(native_z.real))])
finally:
    manifest["elapsed_s"] = time.time()-start_time
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps(manifest, indent=2))
