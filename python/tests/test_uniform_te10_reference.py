"""Opt-in raw TE10 probe reference; ordinary discovery never starts FDTD.

Native controls, using the bundled environment and fresh output outside Git:
python -m tests.test_uniform_te10_reference --preflight --out C:\\study\\te10-plan
python -m tests.test_uniform_te10_reference --fdtd --rate-mcps <conservative-host-rate> --out C:\\study\\te10-fresh

Runtime identity v2 also records installed Python processing helpers and CSXCAD
bindings. Earlier records stay in their original source/runtime epoch and are
rejected here; do not rewrite their hashes. This does not complete the previously
failed stricter-energy control or establish a new numerical validation result.
"""
import unittest
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tempfile
from unittest.mock import patch

import numpy as np
from openEMS.physical_constants import C0, Z0

from fairbeam.wgport import probe_power_factor, uniform_te10_probe_reference
from fairbeam import Simulation, multiport, wgport
from fairbeam.procutil import popen_group, release_group, terminate_group
from tests.coax_resonator_fixture import save, sha
from tests.te10_runtime_identity import runtime_identity


A, B = 22.86, 10.16
F = np.linspace(7e9, 11e9, 201)


def grid(n=32, length=65., pml=8, padding=0):
    ny = int(np.ceil(B/(A/n)))
    dz = 2.5/int(np.ceil(2.5/(A/n)))
    q = int(round(length/dz))
    xp, yp = np.linspace(0, A, n+1), np.linspace(0, B, ny+1)
    if padding:
        xp = np.r_[-np.arange(padding, 0, -1)*(A/n), xp, A+np.arange(1, padding+1)*(A/n)]
        yp = np.r_[-np.arange(padding, 0, -1)*(B/ny), yp, B+np.arange(1, padding+1)*(B/ny)]
    axes = (xp, yp,
            dz*np.arange(-q-6-pml, q+7+pml))
    dt = .5/(C0*np.sqrt(sum((np.min(np.diff(v))*1e-3)**-2 for v in axes)))
    return axes, dt


def reference(n=32, **options):
    axes, dt = grid(n)
    values = dict(timestep_s=dt, unit=1e-3, inset_cells=1)
    values.update(options)
    return uniform_te10_probe_reference(*axes, (0, 0), (A, B), A, B, F, **values)


def bandpass_pulse(dt):
    """Test-only, odd pulse centered on the actual native timestep lattice."""
    f0, fc = (F[0]+F[-1])/2, (F[-1]-F[0])/2
    tau = np.sqrt(np.log(10))/(np.pi*fc)
    center = int(round(5*tau/dt))*dt
    expression = (f"exp(-((t-{center:.17g})/{tau:.17g})^2)"
                  f"*sin({2*np.pi*f0:.17g}*(t-{center:.17g}))*(t<={2*center:.17g})")
    return dict(type="odd-gaussian-bandpass", f0=float(f0), fc=float(fc), tau_s=float(tau),
                center_s=float(center), duration_s=float(2*center), expression=expression,
                dc_free=True)


class UniformReference(unittest.TestCase):
    def test_existing_power_numbers_are_preserved_for_nonuniform_gallery_meshes(self):
        from tests.test_wgport import factor, X20, Y20, X30, Y30
        expected = {"TE10": (1.0446548834838196, 1.085780225299379),
                    "TE20": (1.0564186075431332, 1.0909505183192387),
                    "TE11": (1.074974917910593, 1.1098708510805337)}
        for mode, pair in expected.items():
            np.testing.assert_allclose((factor(X20, Y20, mode), factor(X30, Y30, mode)),
                                       pair, rtol=0, atol=5e-14)

    def test_transverse_ratio_is_distinct_from_a_scalar_power_correction(self):
        r = reference()
        self.assertAlmostEqual(r["projection_ratio"], 1.0389223890724675, places=13)
        axes, _ = grid()
        power = probe_power_factor(*axes[:2], (0, 0), (A, B), A, B, inset_cells=1)
        self.assertGreater(abs(power-r["projection_ratio"]), .001)

    def test_discrete_beta_satisfies_the_independent_yee_stencil(self):
        axes, dt = grid()
        dx, _, dz = [np.diff(v)[0]*1e-3 for v in axes]
        beta = reference()["beta_per_m"]
        temporal = (np.sin(np.pi*F*dt)/(C0*dt))**2
        spatial = (np.sin(np.pi*dx/(2*A*1e-3))/dx)**2+(np.sin(beta*dz/2)/dz)**2
        np.testing.assert_allclose(spatial, temporal, rtol=3e-15)

    def test_continuum_phase_and_impedance_limits_improve_with_refinement(self):
        beta = np.sqrt((2*np.pi*F/C0)**2-(np.pi/(A*1e-3))**2)
        impedance = Z0*(2*np.pi*F/C0)/beta
        errors = []
        for n in (32, 64, 128):
            r = reference(n)
            errors.append((np.max(abs(r["beta_per_m"]/beta-1)),
                           np.max(abs(r["raw_probe_impedance_ohm"]/impedance-1))))
        for old, new in zip(errors, errors[1:]):
            self.assertLess(new[0], old[0]/3)
            self.assertLess(new[1], old[1]*.6)

    def test_units_translations_and_reversed_corners_preserve_reference(self):
        axes, dt = grid()
        original = reference()
        for scale, origin in ((1., (3., -8., 10.)), (.001, (0., 0., 0.))):
            translated = [axis*scale+offset for axis, offset in zip(axes, origin)]
            low = (origin[0], origin[1])
            high = (origin[0]+A*scale, origin[1]+B*scale)
            for first, last in ((low, high), (high, low)):
                actual = uniform_te10_probe_reference(*translated, first, last, A*scale, B*scale,
                    F, timestep_s=dt, unit=1e-3/scale, inset_cells=1)
                for key in original:
                    np.testing.assert_allclose(actual[key], original[key], rtol=3e-13, atol=1e-13)

    def test_single_frequency_and_different_timestep_are_explicit(self):
        axes, dt = grid()
        r = uniform_te10_probe_reference(*axes, (0, 0), (A, B), A, B, [9e9],
                                         timestep_s=dt/2, inset_cells=1)
        self.assertEqual(r["beta_per_m"].shape, (1,))
        self.assertEqual(r["raw_probe_impedance_ohm"].shape, (1,))
        self.assertNotEqual(r["beta_per_m"][0], reference()["beta_per_m"][100])

    def test_each_nonuniform_axis_is_rejected_before_projection(self):
        axes, dt = grid()
        for j in range(3):
            modified = [v.copy() for v in axes]
            modified[j][3] += np.diff(modified[j])[0]*.01
            with self.assertRaisesRegex(ValueError, "uniform"):
                uniform_te10_probe_reference(*modified, (0, 0), (A, B), A, B, F,
                                             timestep_s=dt, inset_cells=1)

    def test_invalid_meshes_corners_and_dimensions_are_rejected(self):
        axes, dt = grid()
        for bad in ([0., 1.], [0., 1., 1.], [2., 1., 0.], [0., np.nan, 2.],
                    [[0., 1., 2.]], [0j, 1j, 2j], [False, True, True]):
            with self.assertRaises(ValueError):
                uniform_te10_probe_reference(bad, *axes[1:], (0, 0), (A, B), A, B, F,
                                             timestep_s=dt)
        for low, high, a, b in (((0, 0), (A+.1, B), A, B),
                ((.1, 0), (A+.1, B), A, B), ((0, 0), (A, B), True, B),
                ((0, 0), (A, B), B, A), ((0, 0), (A, B), A, np.inf),
                ((0,), (A, B), A, B), ((0, 0), (A, np.nan), A, B)):
            with self.assertRaises(ValueError):
                uniform_te10_probe_reference(*axes, low, high, a, b, F, timestep_s=dt)

    def test_cutoff_higher_modes_bad_frequency_vectors_and_nyquist_are_refused(self):
        axes, dt = grid()
        for f in ([], [1e9], [C0/(2*A*1e-3)], [14e9], [np.nan], [np.inf],
                  [9e9, 8e9], [9e9, 9e9], [[9e9]], [9e9+1j], [True]):
            with self.assertRaises(ValueError):
                uniform_te10_probe_reference(*axes, (0, 0), (A, B), A, B, f,
                                             timestep_s=dt, inset_cells=1)
        # Just below the continuum TE20 cutoff, the coarser Yee TE20 mode
        # already propagates. A continuum-only guard would accept this.
        with self.assertRaisesRegex(ValueError, "higher-mode Yee cutoff"):
            uniform_te10_probe_reference(*axes, (0, 0), (A, B), A, B,
                [C0/(A*1e-3)*.999], timestep_s=dt, inset_cells=1)

    def test_timestep_unit_and_inset_policy_are_not_silently_guessed(self):
        _, dt = grid()
        for key, value in (("timestep_s", True), ("timestep_s", -dt), ("timestep_s", np.nan),
                ("timestep_s", dt*3), ("unit", 0), ("unit", np.inf), ("unit", "mm"),
                ("inset_cells", True), ("inset_cells", -1), ("inset_cells", 32)):
            with self.assertRaises(ValueError):
                reference(**{key:value})

    def test_native_controls_keep_interiors_and_sources_on_exact_mesh_nodes(self):
        for case in range(len(CASES)):
            sim, meta = build(case, 1)
            self.assertEqual(meta["threads"], 4)
            self.assertTrue(meta["excitation"]["dc_free"])
            self.assertEqual(meta["source_duration_s"], meta["excitation"]["duration_s"])
            self.assertEqual(sim.csx.GetPropertyByCoordPriority([A/2, B/2, 0]).GetName(), "guide_air")
            self.assertEqual(sim.csx.GetPropertyByCoordPriority([-A/meta["n"], B/2, 0]).GetName(), "guide_pec")
            for point in ((0, B/2, 0), (A, B/2, 0), (A/2, 0, 0), (A/2, B, 0)):
                self.assertEqual(sim.csx.GetPropertyByCoordPriority(point).GetName(), "guide_pec")
            for p in sim.ports:
                self.assertIn(p["start"][2], meta["mesh_mm"][2])
                self.assertIn(p["stop"][2], meta["mesh_mm"][2])
            if case >= 3:
                _, ordinary = build(1, 1)
                self.assertEqual(meta["dt_s"], ordinary["dt_s"])
                for a, b in zip(ordinary["mesh_mm"], meta["mesh_mm"]):
                    b = np.array(b)
                    np.testing.assert_array_equal(b[(b >= a[0]) & (b <= a[-1])], a)

    def test_native_source_has_band_support_and_negligible_discrete_dc(self):
        for n in (24, 32, 48):
            _, dt = grid(n)
            pulse = bandpass_pulse(dt)
            k = int(round(pulse["center_s"]/dt))
            t = np.arange(2*k+1)*dt
            centered = t-pulse["center_s"]
            et = np.exp(-(centered/pulse["tau_s"])**2)*np.sin(2*np.pi*pulse["f0"]*centered)
            np.testing.assert_allclose(et, -et[::-1], rtol=0, atol=2e-14)
            spectrum = abs(np.exp(-2j*np.pi*F[:, None]*t)@et)
            self.assertGreater(spectrum.min()/spectrum.max(), .09)
            self.assertLess(abs(et.sum())/spectrum.max(), 2e-14)

    def test_bad_probe_sampling_cannot_pass_with_a_large_absolute_tolerance(self):
        dt, end = 1e-12, 1e-9
        stride = int(1/(2*F[-1]*dt*4))
        data = np.column_stack((np.arange(12)*stride*dt, np.ones(12)))
        self.assertEqual(trace_clock(data, dt, end)["stride"], stride)
        for bad in (data*[2, 1], data*np.nan, np.vstack((data[:5], data[4:]))):
            with self.assertRaises(ValueError):
                trace_clock(bad, dt, end)

    def test_native_budget_guard_does_not_launch_or_create_outputs(self):
        with tempfile.TemporaryDirectory() as temp, patch(__name__+".popen_group") as launch:
            out = Path(temp)/"not-started"
            for rate in (True, 0, -1, np.nan, .001):
                with self.assertRaises(ValueError):
                    acquire_serial(out, rate)
                self.assertFalse(out.exists())
            launch.assert_not_called()

    def test_scattering_rejects_unexcited_nonfinite_and_wrong_shape_waves(self):
        for values in (np.zeros((2, 2, 201)), np.full((2, 2, 201), np.nan), np.ones((2, 201))):
            with self.assertRaises(ValueError):
                scattering(values, values, np.ones(201)*500)

    def test_native_stop_cannot_be_replaced_by_a_small_reflection_result(self):
        _, meta = build(1, 1)
        steps = int(np.ceil(2*meta["source_duration_s"]/meta["dt_s"]))
        meta["native"] = dict(cells=meta["cells"], steps=steps, dt_s=meta["dt_s"],
                              numerical_time_s=steps*meta["dt_s"])
        meta["run"] = dict(converged=True, exact_endcriteria=True, threads=4, grid=meta["native_lines"])
        text = "openEMS 64bit -- version v0.37.0-rc3\nfixed number of threads: 4\n"
        audit_native(meta, text)
        meta["run"]["hit_timestep_limit"] = True
        with self.assertRaisesRegex(ValueError, "stopping"):
            audit_native(meta, text)
        meta["run"]["hit_timestep_limit"] = False
        meta["native"]["numerical_time_s"] = .5*meta["source_duration_s"]
        with self.assertRaisesRegex(ValueError, "stopping"):
            audit_native(meta, text)


ROOT = Path(__file__).resolve().parents[2]
CASES = ((24, 65., 8, -80., 60e-9), (32, 65., 8, -80., 60e-9),
         (48, 65., 8, -80., 60e-9), (32, 85., 8, -80., 60e-9),
         (32, 65., 12, -80., 60e-9), (32, 65., 8, -90., 120e-9))
GATES = dict(reflection_abs=.001, transmission_abs=.001, complex_target_abs=.002,
             complex_mesh_abs=.002, complex_control_abs=.002, reciprocal_abs=.001,
             incident_condition_max=10., incident_floor_rel=.02)


def identity():
    names = ("tests/test_uniform_te10_reference.py", "tests/te10_runtime_identity.py", "tests/coax_resonator_fixture.py",
             "fairbeam/wgport.py", "fairbeam/simulation.py", "fairbeam/excitation.py",
             "fairbeam/procutil.py", "fairbeam/multiport.py")
    return {name:sha(ROOT/"python"/name) for name in names}


def build(case, port):
    if case not in range(len(CASES)) or port not in (1, 2):
        raise ValueError("declared native case and excited port required")
    n, distance, pml, end_db, cap = CASES[case]
    axes, dt = grid(n, distance, pml, padding=4)
    # A fresh, test-only source epoch isolates the low-frequency tail without
    # changing the physical guide, the reference API or any acceptance gate.
    sim = Simulation(F[0], F[-1], boundaries=["PEC"]*4+[f"PML_{pml}"]*2,
                     end_criteria_db=end_db, excitation="gauss")
    pulse = bandpass_pulse(dt)
    # In 0.37.0rc3 CalcCustomExcitation sets its Nyquist rate from the base
    # parameter, overriding fmax. Keep it at the highest measurement frequency;
    # the actual 9 GHz carrier is specified entirely by the expression.
    sim.fdtd.SetCustomExcite(pulse["expression"], F[-1], F[-1])
    pulse["native_base_parameter_hz"] = float(F[-1])
    sim.excitation = pulse
    for axis, lines in zip("xyz", axes):
        sim.mesh.AddLine(axis, lines)
    # Put the walls inside the mesh, with actual PEC outside the physical guide,
    # matching the projection helper's field support. Domain faces remain PEC.
    metal = sim.metal("guide_pec")
    metal.AddBox(priority=10, start=[v[0] for v in axes], stop=[v[-1] for v in axes])
    air = sim.dielectric("guide_air", 1.)
    air.AddBox(priority=20, start=[0, 0, axes[2][0]], stop=[A, B, axes[2][-1]])
    # An inclusive air box alone overrides metal on its boundary and moves the
    # tangential PEC constraint by a cell. Explicit wall planes keep a/b exact.
    for axis, value in ((0, 0), (0, A), (1, 0), (1, B)):
        first, last = [0, 0, axes[2][0]], [A, B, axes[2][-1]]
        first[axis] = last[axis] = value
        metal.AddBox(priority=30, start=first, stop=last)
    center = len(axes[2])//2
    q = int(round(distance/np.diff(axes[2])[0]))
    for number, side in ((1, -1), (2, 1)):
        source, plane = (float(axes[2][center+side*offset]) for offset in (q+2, q))
        native = sim.waveguide_port(number, [0, 0, source], [A, B, plane], "z", A, B,
                                    excite=number == port)
        wgport.inset_mode_probes(native, cells=1)
    steps = int(np.ceil(cap/dt))
    sim.max_timesteps = steps
    sim.fdtd.SetTimeStep(float(dt))
    sim.fdtd.SetNumberOfTimeSteps(steps)
    sim.fdtd.SetOverSampling(4)
    if sim.csx.Update():
        raise ValueError("invalid native guide geometry")
    meta = dict(case=case, n=n, distance_mm=distance, pml=pml, end_db=end_db, cap_s=cap,
                port=port, a_mm=A, b_mm=B, inset_cells=1, pec_padding_cells=4, unit=sim.unit,
                mesh_mm=[v.tolist() for v in axes], dt_s=float(dt), max_steps=steps,
                native_lines=[len(v) for v in axes], cells=int(np.prod([len(v) for v in axes])),
                excitation=sim.excitation, source_duration_s=pulse["duration_s"], threads=4)
    return sim, meta


def worker(out, case, port):
    out.mkdir(parents=True, exist_ok=False)
    sim, meta = build(case, port)
    source, runtime = identity(), runtime_identity()
    sim.fdtd.Write2XML(str(out/"input.xml"))
    meta.update(source_sha256=source, runtime=runtime, input_sha256=sha(out/"input.xml"))
    save(out/"declared.json", meta)
    sim.run(str(out/"raw"), threads=4, exact=True, echo=True, dump_statistics=True)
    stat = np.loadtxt(out/"raw/openEMS_stats.txt", comments="%")
    meta.update(native=dict(cells=int(stat[0]), dt_s=float(stat[1]), steps=int(stat[2]),
        numerical_time_s=float(stat[3]), iteration_wall_s=float(stat[4])), run=sim.run_stats)
    v, i, traces = [], [], {}
    for p in sim._port_objs:
        p.CalcPort(str(out/"raw"), F)
        v.append(p.uf_tot)
        i.append(p.if_tot)
        for name in p.U_filenames+p.I_filenames:
            path = out/"raw"/name
            data = np.loadtxt(path, comments="%", ndmin=2)
            traces[name] = dict(sha256=sha(path), **trace_clock(data, meta["native"]["dt_s"], stat[3]))
    if not np.isfinite(v).all() or not np.isfinite(i).all() or not np.any(np.abs(v[port-1])+np.abs(i[port-1]) > 0):
        raise ValueError("invalid or zero-field excited port")
    np.savez_compressed(out/"waves.npz", f=F, v=v, i=i)
    if source != identity() or runtime != runtime_identity():
        raise RuntimeError("source/runtime changed during the native worker")
    meta.update(waves_sha256=sha(out/"waves.npz"), raw_traces=traces)
    save(out/"report.json", meta)


def trace_clock(data, dt, end):
    stride = int(1/(2*F[-1]*dt*4))
    if (data.ndim != 2 or len(data) < 3 or not np.isfinite(data).all() or stride < 1
            or np.any(np.diff(data[:, 0]) <= 0)
            or not np.allclose(np.diff(data[:, 0]), stride*dt, rtol=2e-5, atol=dt*1e-5)
            or data[-1, 0] > end+stride*dt):
        raise ValueError("invalid native raw probe clock")
    return dict(samples=len(data), stride=stride)


def audit_native(meta, log):
    run, native = meta["run"], meta["native"]
    if not (run.get("converged") and run.get("exact_endcriteria") and not run.get("hit_timestep_limit")
            and run.get("threads") == 4 and run.get("grid") == meta["native_lines"]
            and native["cells"] == meta["cells"] and native["steps"] < meta["max_steps"]
            and abs(native["dt_s"]/meta["dt_s"]-1) < 1e-8
            and abs(native["numerical_time_s"]/(native["dt_s"]*native["steps"])-1) < 1e-8
            and native["numerical_time_s"] > meta["source_duration_s"]):
        raise ValueError("native stopping/grid/timestep/source completion audit failed")
    if ("openEMS 64bit -- version v0.37.0-rc3" not in log or "fixed number of threads: 4" not in log
            or re.search(r"forced timestep:.*larger than calculated timestep", log)):
        raise ValueError("declared native version, threads and stability required")


def read_case(out, case):
    records, v, i = [], [], []
    for port in (1, 2):
        path = out/f"case{case}/port{port}"
        meta = json.loads((path/"report.json").read_text())
        _, declared = build(case, port)
        if any(meta[k] != value for k, value in declared.items()) or meta["source_sha256"] != identity() or meta["runtime"] != runtime_identity():
            raise ValueError("changed physical model, source or runtime")
        if sha(path/"input.xml") != meta["input_sha256"] or sha(path/"waves.npz") != meta["waves_sha256"]:
            raise ValueError("changed native input or wave data")
        expected = {f"port_{k}t_{p}" for k in ("u", "i") for p in (1, 2)}
        if set(meta["raw_traces"]) != expected or any(sha(path/"raw"/name) != row["sha256"] for name, row in meta["raw_traces"].items()):
            raise ValueError("changed or incomplete raw probe data")
        log = (out/f"case{case}/port{port}.log").read_text()
        audit_native(meta, log)
        with np.load(path/"waves.npz") as data:
            np.testing.assert_array_equal(data["f"], F)
            v.append(data["v"].copy())
            i.append(data["i"].copy())
        records.append(meta)
    return records, np.array(v), np.array(i)


def scattering(v, i, impedance):
    v, i, impedance = np.asarray(v), np.asarray(i), np.asarray(impedance)
    if (v.shape != (2, 2, len(F)) or i.shape != v.shape or impedance.shape != F.shape
            or not np.isfinite(v).all() or not np.isfinite(i).all()
            or not np.isrealobj(impedance) or not np.isfinite(impedance).all() or np.any(impedance <= 0)):
        raise ValueError("complete finite two-port waves and positive real references required")
    incoming = (v+impedance*i)/(2*np.sqrt(impedance))
    outgoing = (v-impedance*i)/(2*np.sqrt(impedance))
    singular = np.linalg.svd(incoming.transpose(2, 1, 0), compute_uv=False)
    condition = singular[:, 0]/np.maximum(singular[:, -1], np.finfo(float).tiny)
    scale = float(singular[:, 0].max())
    floor = float(singular[:, -1].min()/scale) if scale else 0.
    if not np.isfinite(condition).all() or condition.max() > GATES["incident_condition_max"] or floor < GATES["incident_floor_rel"]:
        raise ValueError("unexcited or ill-conditioned incident-wave matrix")
    return multiport.assemble_s(incoming, outgoing, [1, 2], 2)


def analyse(out):
    rows, deembedded = [], []
    continuum_beta = np.sqrt((2*np.pi*F/C0)**2-(np.pi/(A*1e-3))**2)
    continuum_z = Z0*(2*np.pi*F/C0)/continuum_beta
    for case, (_, distance, _, _, _) in enumerate(CASES):
        records, v, i = read_case(out, case)
        meta = records[0]
        cal = uniform_te10_probe_reference(*meta["mesh_mm"], (0, 0), (A, B), A, B, F,
                    timestep_s=meta["native"]["dt_s"], unit=meta["unit"], inset_cells=1)
        before, after = scattering(v, i, continuum_z), scattering(v, i, cal["raw_probe_impedance_ohm"])
        plane_length = 2*distance*1e-3
        ideal = np.zeros_like(after)
        ideal[:, 0, 1] = ideal[:, 1, 0] = np.exp(-1j*cal["beta_per_m"]*plane_length)
        def metrics(matrix):
            return dict(reflection_max_abs=float(np.max(abs(matrix[:, (0, 1), (0, 1)]))),
                transmission_magnitude_error=float(np.max(abs(abs(matrix[:, (0, 1), (1, 0)])-1))),
                complex_target_error=float(np.max(abs(matrix-ideal))),
                reciprocal_error=float(np.max(abs(matrix-matrix.transpose(0, 2, 1)))))
        data = dict(case=case, settings=meta, projection_ratio=cal["projection_ratio"],
                    before=metrics(before), after=metrics(after), all_native_complete=True,
                    five_frequencies=[dict(ghz=float(F[j]/1e9), before_s11_abs=float(abs(before[j,0,0])),
                        after_s11_abs=float(abs(after[j,0,0])),
                        before_phase_error_deg=float(np.angle(before[j,1,0]/ideal[j,1,0], deg=True)),
                        after_phase_error_deg=float(np.angle(after[j,1,0]/ideal[j,1,0], deg=True)))
                        for j in (0, 50, 100, 150, 200)])
        data["target_passes"] = all(data["after"][key] <= GATES[gate] for key, gate in
            (("reflection_max_abs", "reflection_abs"), ("transmission_magnitude_error", "transmission_abs"),
             ("complex_target_error", "complex_target_abs"), ("reciprocal_error", "reciprocal_abs")))
        deembedded.append(after*np.exp(1j*cal["beta_per_m"]*plane_length)[:,None,None])
        rows.append(data)
        np.savez_compressed(out/f"case{case}/comparison.npz", f=F, before=before, after=after, ideal=ideal)
    mesh = [float(np.max(abs(b-a))) for a,b in zip(deembedded[:3], deembedded[1:3])]
    controls = {name:float(np.max(abs(deembedded[case]-deembedded[1])))
                for case, name in ((3, "distance"), (4, "pml"), (5, "time"))}
    result = dict(scope="Uniform air/PEC TE10 modal splitting and Yee phase only; no coupler, loss or general power validation",
        source_sha256=identity(), runtime=runtime_identity(), limits=GATES, rows=rows,
        mesh_changes=mesh, control_changes=controls,
        qualified=bool(all(row["target_passes"] for row in rows)
            and all(v <= GATES["complex_mesh_abs"] for v in mesh)
            and all(v <= GATES["complex_control_abs"] for v in controls.values())))
    save(out/"comparison.json", result)
    return result


def acquire_serial(out, rate):
    if isinstance(rate, (bool, np.bool_)) or not np.isfinite(rate) or rate <= 0:
        raise ValueError("positive finite conservative native rate required")
    plans = []
    for case in range(len(CASES)):
        _, meta = build(case, 1)
        estimate = 20+1.15*meta["cells"]*meta["max_steps"]/(rate*1e6)
        if not np.isfinite(estimate) or estimate > 1800:
            raise ValueError("positive conservative rate and <=30 minute native forecast required")
        plans.append(dict(case=case, cells=meta["cells"], dt_s=meta["dt_s"], estimated_seconds=estimate))
    out.mkdir(parents=True, exist_ok=False)
    initial = dict(status="prepared", source_sha256=identity(), runtime=runtime_identity(), limits=GATES, plans=plans, rows=[])
    save(out/"protocol.json", initial)
    for case in range(len(CASES)):
        parent = out/f"case{case}"
        parent.mkdir()
        for port in (1, 2):
            if identity() != initial["source_sha256"] or runtime_identity() != initial["runtime"]:
                raise RuntimeError("source/runtime changed between native workers")
            command = [sys.executable, "-m", "tests.test_uniform_te10_reference", "--worker",
                       "--out", str(parent/f"port{port}"), "--case", str(case), "--port", str(port)]
            start, wall = time.monotonic(), time.time()
            with (parent/f"port{port}.log").open("w", encoding="utf-8") as log:
                proc = popen_group(command, cwd=ROOT/"python", stdout=log, stderr=subprocess.STDOUT,
                    env={**os.environ, "OMP_NUM_THREADS":"4", "OPENBLAS_NUM_THREADS":"1"})
                initial.update(status="running", active_case=case, active_port=port, owned_pid=proc.pid)
                save(out/"protocol.json", initial)
                try:
                    while proc.poll() is None:
                        left = 1800-max(time.monotonic()-start, time.time()-wall)
                        if left <= 0:
                            raise TimeoutError("owned native worker exceeded 30 minutes including suspend")
                        try:
                            proc.wait(timeout=min(1., left))
                        except subprocess.TimeoutExpired:
                            pass
                    if max(time.monotonic()-start, time.time()-wall) > 1800 or proc.returncode:
                        raise RuntimeError("late or unsuccessful native worker; preserve its log")
                except (RuntimeError, TimeoutError) as error:
                    initial.update(status="failed", reason=str(error), qualified=False, owned_pid=None)
                    save(out/"protocol.json", initial)
                    raise
                finally:
                    if proc.poll() is None:
                        terminate_group(proc.pid, grace=0, job=proc.win_job)
                        proc.wait(timeout=15)
                    release_group(proc)
                    save(parent/f"port{port}.worker.json", dict(pid=proc.pid, command=command,
                        exit_code=proc.returncode, wall_seconds=time.time()-wall, deadline_seconds=1800))
            report = json.loads((parent/f"port{port}/report.json").read_text())
            try:
                audit_native(report, (parent/f"port{port}.log").read_text())
            except ValueError as error:
                initial.update(status="rejected", reason=str(error), qualified=False, owned_pid=None)
                save(out/"protocol.json", initial)
                raise
            initial["rows"].append(dict(case=case, port=port, wall_seconds=time.time()-wall))
            save(out/"protocol.json", initial)
    result = analyse(out)
    initial.update(status="complete", active_case=None, active_port=None, owned_pid=None, qualified=result["qualified"])
    save(out/"protocol.json", initial)
    return result


def native_main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "fdtd", "analyse", "worker"):
        action.add_argument("--"+name, action="store_true", help=argparse.SUPPRESS if name == "worker" else None)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", type=int, choices=range(len(CASES)), default=0, help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, choices=(1, 2), default=1, help=argparse.SUPPRESS)
    parser.add_argument("--rate-mcps", type=float, default=10.)
    args = parser.parse_args()
    if not np.isfinite(args.rate_mcps) or args.rate_mcps <= 0:
        parser.error("--rate-mcps must be positive and finite")
    if args.worker:
        worker(args.out, args.case, args.port)
    elif args.fdtd:
        print(json.dumps(acquire_serial(args.out, args.rate_mcps), indent=2))
    elif args.analyse:
        print(json.dumps(analyse(args.out), indent=2))
    else:
        args.out.mkdir(parents=True, exist_ok=False)
        rows = []
        for case in range(len(CASES)):
            sim, meta = build(case, 1)
            sim.fdtd.Write2XML(str(args.out/f"case{case}.xml"))
            rows.append(dict(case=case, meta=meta, input_sha256=sha(args.out/f"case{case}.xml"),
                estimated_seconds_per_port=20+1.15*meta["cells"]*meta["max_steps"]/(args.rate_mcps*1e6)))
        save(args.out/"plan.json", dict(source_sha256=identity(), runtime=runtime_identity(), limits=GATES, rows=rows))
        print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    native_main() if any(arg in sys.argv for arg in ("--preflight", "--fdtd", "--analyse", "--worker")) else unittest.main()
