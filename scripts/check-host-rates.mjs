import assert from "node:assert/strict";
import { median, pickHostRates, loadHostRates, hostRates } from "../src/lib/hostRates.ts";

const bench = { models: {
  a: [{ machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "cpu", mcells_s: 300 }, { machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "gpu", mcells_s: 1000 }],
  b: [{ machine: "Apple M5 Pro", host_cpu: "Apple M5 Pro", engine: "cpu", mcells_s: 100 }, { machine: "AMD", host_cpu: "AMD", engine: "cpu", mcells_s: 50 }, { machine: "x", host_cpu: null, engine: "cpu", mcells_s: null }],
} };
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([1, 2, 3, 10]), 2.5);
// 1. the machine's own runs
assert.deepEqual(pickHostRates({ cpu: { mcells_s: 180, runs: 4 } }, "Apple M5 Pro", bench).cpu, { mcps: 180, source: "runs", n: 4 });
// 2. the benchmark rows of the same machine name for the engine without runs
const r = pickHostRates({ cpu: { mcells_s: 180, runs: 4 } }, "Apple M5 Pro", bench);
assert.deepEqual(r.gpu, { mcps: 1000, source: "bench", n: 1 });
assert.deepEqual(pickHostRates(undefined, "Apple M5 Pro", bench).cpu, { mcps: 200, source: "bench", n: 2 });
// 3. otherwise nothing: the fixed 250 / 700 apply
assert.deepEqual(pickHostRates(undefined, "Unknown CPU", bench), {});
assert.deepEqual(pickHostRates(undefined, null, bench), {});
assert.deepEqual(pickHostRates({ cpu: { mcells_s: 0, runs: 1 } }, null, null), {});
for (const mcells_s of [NaN, Infinity, -1, 0])
  assert.deepEqual(pickHostRates({ cpu: { mcells_s, runs: 1 } }, null, null), {});
assert.deepEqual(pickHostRates({ unknown: { mcells_s: 100, runs: 1 }, cpu: { mcells_s: 100, runs: 0 } }, null, null), {});
assert.deepEqual(pickHostRates(undefined, "X", { models: { a: [null, {engine: "cpu", host_cpu: "X", mcells_s: Infinity}] } }), {});

// A delayed benchmark response cannot replace a newer host's measured rates or revive an offline host.
const originalFetch = globalThis.fetch;
try {
  let respond;
  globalThis.fetch = () => new Promise(resolve => { respond = resolve; });
  const old = loadHostRates({ host_cpu: "Apple M5 Pro" }, "https://fixture.invalid/first");
  await loadHostRates({ host_cpu: "AMD", throughput: { cpu: { mcells_s: 123, runs: 1 }, gpu: { mcells_s: 456, runs: 2 } } }, "https://fixture.invalid/first");
  respond({ ok: true, json: async () => bench });
  await old;
  assert.equal(hostRates().cpu.mcps, 123);
  assert.equal(hostRates().gpu.mcps, 456);

  const pending = loadHostRates({ host_cpu: "Apple M5 Pro" }, "https://fixture.invalid/second");
  await loadHostRates(null, "https://fixture.invalid/second");
  respond({ ok: true, json: async () => bench });
  await pending;
  assert.deepEqual(hostRates(), {});

  // Same-host health refreshes incorporate newly completed runs without restarting the app.
  await loadHostRates({ host_cpu: "Apple M5 Pro", throughput: { cpu: { mcells_s: 333, runs: 2 } } }, "https://fixture.invalid/second");
  assert.equal(hostRates().cpu.mcps, 333);
  assert.equal(hostRates().gpu.mcps, 1000);
} finally { globalThis.fetch = originalFetch; }
console.log("host-aware throughput selection and delayed response checks passed");
