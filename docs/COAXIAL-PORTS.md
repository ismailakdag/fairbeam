# Experimental coaxial TEM ports

This implementation is a draft capability, not a generally qualified port model. It uses native
`openEMS.AddCoaxialPort`; it never substitutes a discrete port. Windows construction and bounded
air-line controls have been exercised. macOS, GPU engines, dielectric-filled lines and general
RF structures still require qualification before release.

The run API currently rejects GPU runs containing coaxial ports. Availability of CUDA or Metal
does not establish parity for weighted radial excitation or transmission-line probes. The CPU
path is experimental too; native API presence is a capability check, not accuracy qualification.

## Contract

An editable `coaxial` port stores its axis, centerline endpoints, inner-conductor radius `r_i`,
shield inner/outer radii `r_o`/`r_os`, PEC material reference, optional dielectric material
reference, excitation flag, feed offset, measurement offset and `open`/`short` termination.
Lengths use the design's millimeters. Require `0 < r_i < r_o < r_os`; endpoints must share an
axis-aligned centerline. Offsets are measured from start toward stop, including reversed lines.

The port creates conductor/shield and dielectric geometry. It stages that geometry for meshing,
then constructs the native transmission-line probes on the final mesh. At least three cells
across the annulus and two per inner radius are required; this is a refusal threshold, not a
convergence guarantee. Three neighboring measurement planes must lie inside the port and outside
PML, with the excitation before the measurement plane and outside PML. The bundle records the
actual snapped measurement plane.

Finite feed resistance is unsupported upstream and rejected. `open` and `short` describe the
physical feed termination. They do not define an absorbing matched load: a through line normally
continues into an absorbing boundary. Dispersive filling, finite-conductivity conductor references,
cylindrical meshes, grouped feeds and custom complex reference impedance are outside this draft.
Missing native API support produces an error rather than a different source model.

Output waves use the positive real lossless TEM reference
`Zref = eta0/(2*pi) * sqrt(mu_r/eps_r) * ln(r_o/r_i)` independently of the feed termination.
Native differential-TL complex impedance is retained in `native_tem_z_re`/`native_tem_z_im`.
This separates physical loading, numerical impedance estimation and output normalization.

CST-compatible macro export retains generated material geometry but warns that the native coaxial
port is skipped. The exported macro is therefore not an equivalent operational simulation.
No macro execution or cross-solver equivalence has been established.

## Reproducible controls

`scripts/validate-coaxial-native.py` builds a synthetic air-filled PEC coax with radii 1/3/3.5 mm,
a 100 mm length, 1–2 GHz band, CPU with two threads, and a -50 dB energy criterion. It retains
the run manifest, raw solve directory and complex CSV values. Use a new output directory per run:

```sh
python scripts/validate-coaxial-native.py --case through --step .25 --out /path/to/new/run
```

Cases are through, open (PMC end plane) and short (PEC end plane). Compare two transverse mesh
resolutions and the known TEM line phase before interpreting a result. `--reuse-solve` reprocesses
retained probes and records their directory without starting another solver.

The first through refinement reduced complex error against the analytical line, but residual
phase and impedance error remains material. These observations are not a release acceptance claim.
Further axial/transverse refinement, reference-plane shifts, boundary controls and filled-line
tests are required. Test passivity and convergence separately from solver completion.

Inspected runtime: openEMS Python `0.37.0rc3`, `ports.py` SHA-256
`0daec44373d6a06395f1c47b252b004df4e99ee2fca5525b486e934451dcc1c1`.
The version string alone does not establish API availability for another packaged runtime.

Upstream API: <https://docs.openems.de/en/latest/python/openEMS/ports.html#coaxial-port>.
