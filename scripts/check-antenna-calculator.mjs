import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { antennaDimensions, calculatorRecord } from '../src/home/antennaDimensions.ts';
import { antennaDraft } from '../src/home/antennaDraft.ts';
import { paramValues, evaluate } from '../src/designer/expr.ts';
import { designChecks } from '../src/designer/checks.ts';
import { quickBundle } from '../src/designer/geometry.ts';
import { validateBundle } from '../src/lib/validate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const venv = win ? join(root, '.venv', 'Scripts', 'python.exe') : join(homedir(), 'opt/openEMS/venv/bin/python');
const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? 'python' : 'python3');

const input = { kind: 'dipole', frequencyGHz: .3, shortening: 1, epsilonR: 4.3, heightMm: 1.6 };
const dimensions = i => { const r = antennaDimensions(i); assert.equal(r.ok, true); return r.dimensions; };
const close = (a, b, tol = 1e-8) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

const dipole = dimensions(input);
close(dipole.wavelengthMm, 999.3081933333333);
close(dipole.lengthMm, 499.65409666666665);
close(dipole.armMm, dipole.lengthMm / 2);
close(dimensions({ ...input, kind: 'monopole' }).lengthMm, dipole.lengthMm / 2);
close(dimensions({ ...input, frequencyGHz: .6 }).lengthMm, dipole.lengthMm / 2);
close(dimensions({ ...input, shortening: .95 }).lengthMm, .95 * dipole.lengthMm);

const folded = dimensions({ ...input, kind: 'folded_dipole', shortening: .95 });
close(folded.wavelengthMm, dipole.wavelengthMm);
close(folded.lengthMm, 0.5 * .95 * dipole.wavelengthMm);
close(folded.spacingMm, 0.01 * dipole.wavelengthMm);
assert.equal(folded.armMm, undefined);

const gp = dimensions({ ...input, kind: 'ground_plane', shortening: .95 });
close(gp.wavelengthMm, dipole.wavelengthMm);
close(gp.lengthMm, 0.25 * .95 * dipole.wavelengthMm);
close(gp.radialMm, 0.25 * .95 * dipole.wavelengthMm);

const yagi = dimensions({ ...input, kind: 'yagi', shortening: .95 });
close(yagi.wavelengthMm, dipole.wavelengthMm);
close(yagi.reflectorMm, 0.495 * dipole.wavelengthMm);
close(yagi.lengthMm, 0.473 * .95 * dipole.wavelengthMm);
close(yagi.directorMm, 0.44 * dipole.wavelengthMm);
close(yagi.reflectorSpacingMm, 0.2 * dipole.wavelengthMm);
close(yagi.directorSpacingMm, 0.15 * dipole.wavelengthMm);
close(yagi.boomMm, 0.35 * dipole.wavelengthMm);

const patch = dimensions({ ...input, kind: 'patch', frequencyGHz: 2.45 });
assert.ok(patch.widthMm > 37.5 && patch.widthMm < 37.7);
assert.ok(patch.lengthMm > 29.0 && patch.lengthMm < 29.3);
assert.ok(patch.effectivePermittivity > 1 && patch.effectivePermittivity < 4.3);
const scaled = dimensions({ ...input, kind: 'patch', frequencyGHz: 4.9, heightMm: .8 });
close(scaled.lengthMm, patch.lengthMm / 2);
close(scaled.widthMm, patch.widthMm / 2);
close(scaled.effectivePermittivity, patch.effectivePermittivity);

const wireKinds = ['dipole', 'folded_dipole', 'monopole', 'ground_plane', 'yagi'];
const allKinds = [...wireKinds, 'patch'];
for (const kind of allKinds) {
  for (const frequencyGHz of [0, -1, NaN, Infinity, 1e9]) assert.equal(antennaDimensions({ ...input, kind, frequencyGHz }).ok, false);
}
for (const kind of wireKinds) {
  for (const shortening of [0, .49, 1.01, NaN]) assert.equal(antennaDimensions({ ...input, kind, shortening }).ok, false);
}
for (const heightMm of [0, -1, NaN, 1e6]) assert.equal(antennaDimensions({ ...input, kind: 'patch', heightMm }).ok, false);
for (const epsilonR of [.99, 21, NaN]) assert.equal(antennaDimensions({ ...input, kind: 'patch', epsilonR }).ok, false);

for (const kind of allKinds) {
  const src = { ...input, kind, frequencyGHz: 2.45, shortening: .95 };
  const record = calculatorRecord(src);
  assert.equal(record.schema, 'fairbeam.antenna-estimate/1');
  assert.equal(record.simulated, false);
  assert.deepEqual(record.dimensions, dimensions(src));
  assert.deepEqual(record.units, { frequency: 'GHz', length: 'mm' });
  assert.ok(typeof record.assumptions === 'string' && record.assumptions.length > 20);
  if (kind === 'patch') assert.equal('shortening' in record.inputs, false);
  else assert.equal(record.inputs.shortening, .95);
}
assert.throws(() => calculatorRecord({ ...input, frequencyGHz: NaN }));
console.log('antenna calculator: six classical families, scaling, input refusal, honest export records PASS');

const pyCases = [];
for (const kind of allKinds) {
  for (const frequencyGHz of [0.0071, 0.145, 0.3, 2.45]) {
    for (const shortening of [0.5, 0.95, 1]) {
      if (kind === 'patch' && shortening !== 0.95) continue;
      const source = { ...input, kind, frequencyGHz, shortening }, before = JSON.stringify(source);
      const draft = antennaDraft(source, 'calculated_antenna', 'Calculated antenna');
      assert.deepEqual(
        draft.units,
        frequencyGHz < 0.1 ? { length: 'm', frequency: 'MHz' } : { length: 'mm', frequency: 'GHz' },
        `${kind} @ ${frequencyGHz} GHz display units`,
      );
      const values = paramValues(draft.params);
      assert.deepEqual(Object.keys(values.errors), []);
      assert.deepEqual(designChecks(draft), [], `${kind} @ ${frequencyGHz} GHz live checks`);
      const qb = quickBundle(draft, values.names, null);
      assert.ok(qb, `${kind} @ ${frequencyGHz} GHz quickBundle`);
      assert.doesNotThrow(() => validateBundle(qb));

      const expected = dimensions(source);
      close(values.names.L, expected.lengthMm);
      if (kind === 'patch') {
        close(values.names.W, expected.widthMm);
        assert.equal(draft.materials.find(m => m.name === 'substrate').eps_r, 'eps_r');
      } else {
        assert.ok(values.names.g < values.names.L / 2);
        if (kind === 'folded_dipole') {
          close(values.names.s, expected.spacingMm);
          assert.equal(draft.ports[0].R, 300);
          assert.ok(draft.params.some(p => p.key === 'k_s' && p.expr === undefined));
        } else {
          assert.equal(draft.ports[0].R, 50);
        }
        if (kind === 'ground_plane') {
          close(values.names.L_rad, expected.radialMm);
          assert.ok(draft.params.some(p => p.key === 'k_rad' && p.expr === undefined));
        }
        if (kind === 'yagi') {
          close(values.names.L_r, expected.reflectorMm);
          close(values.names.L_d, expected.directorMm);
          close(values.names.s_r, expected.reflectorSpacingMm);
          close(values.names.s_d, expected.directorSpacingMm);
          close(values.names.boom, expected.boomMm);
          for (const key of ['k', 'k_r', 'k_d', 'k_sr', 'k_sd']) {
            assert.ok(draft.params.some(p => p.key === key && p.expr === undefined), `yagi tunable param ${key}`);
          }
        }
        if (kind === 'monopole') assert.match(draft.model.description, /finite.*ground/i);
      }

      assert.equal(draft.ports.length, 1);
      assert.equal(draft.ports[0].direction, 'z');
      const env = paramValues(draft.params).names;
      assert.ok(evaluate(draft.ports[0].stop[2], env) > evaluate(draft.ports[0].start[2], env));
      assert.equal(JSON.stringify(source), before, 'draft creation does not alter calculator inputs');
      assert.match(draft.model.description, /no simulated performance/i);

      if (shortening === 0.95) pyCases.push({ kind, frequencyGHz, draft: structuredClone(draft) });

      if (kind !== 'patch') {
        const originalLength = values.names.L;
        draft.params.find(p => p.key === 'f0').default *= 2;
        const doubled = paramValues(draft.params).names;
        close(doubled.L, originalLength / 2);
        if (kind === 'folded_dipole') close(doubled.s, expected.spacingMm / 2);
        if (kind === 'ground_plane') close(doubled.L_rad, expected.radialMm / 2);
        if (kind === 'yagi') close(doubled.boom, expected.boomMm / 2);
      }
    }
  }
}

// Load stdlib-only schema/check modules without fairbeam.__init__ (which imports CSXCAD),
// matching designer_fixture.py and wideband_fixture.py so SDK-less web CI runs cleanly.
const pyScript = `
import json, sys, types
from pathlib import Path
package = types.ModuleType("fairbeam")
package.__path__ = [str(Path(sys.argv[1]) / "python" / "fairbeam")]
sys.modules["fairbeam"] = package
from fairbeam.design import check_design
from fairbeam.design_checks import lint, run_blockers
out = []
for item in json.loads(sys.stdin.read()):
    d = item["draft"]
    check_design(d)
    ec = []
    checks = lint(d, endpoint_contacts=ec)
    out.append({
        "kind": item["kind"],
        "frequencyGHz": item["frequencyGHz"],
        "checks": checks,
        "blockers": run_blockers(checks),
        "contacts": [c["status"] for c in ec],
    })
print(json.dumps(out))
`;
const pyResults = JSON.parse(execFileSync(python, ['-I', '-S', '-c', pyScript, root], {
  input: JSON.stringify(pyCases),
  env: { ...process.env, PYTHONUTF8: '1' },
  maxBuffer: 16 << 20,
}).toString());
for (const r of pyResults) {
  assert.deepEqual(r.checks, [], `Python lint clean for ${r.kind} @ ${r.frequencyGHz} GHz`);
  assert.deepEqual(r.blockers, [], `Python run_blockers empty for ${r.kind} @ ${r.frequencyGHz} GHz`);
  assert.deepEqual(r.contacts, ['touching', 'touching'], `Port contacts touching for ${r.kind} @ ${r.frequencyGHz} GHz`);
}

for (const bad of [{ frequencyGHz: NaN }, { shortening: 0 }, { kind: 'unknown' }, { kind: 'patch', epsilonR: 0 }]) {
  assert.throws(() => antennaDraft({ ...input, ...bad }, 'calculated_antenna', 'Calculated antenna'));
}
console.log('antenna drafts: six editable geometries across HF/VHF/UHF/microwave, TS+Python lint parity, units, feeds and invalid input refusal PASS; no solver run');
