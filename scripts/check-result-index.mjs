import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
// Bundle the actual public state module with the same Solid runtime as the application.
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] },
  plugins: [{
    name: "result-index-entry",
    resolveId: id => id.endsWith("result-index-entry") ? "\0result-index-entry" : undefined,
    load: id => id === "\0result-index-entry"
      ? `export {loadIndex,index,indexLoading,indexLoadError} from ${JSON.stringify(root + "src/state.ts")};`
      : undefined,
  }],
  build: { write: false, minify: false, lib: { entry: "result-index-entry", formats: ["es"] } },
});
const code = (Array.isArray(built) ? built[0] : built).output.find(item => item.type === "chunk").code;
const { loadIndex, index, indexLoading, indexLoadError } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const originalFetch = globalThis.fetch;
const pending = [];
const entry = file => ({ file, name: file, model: "dipole", simulated: true });
const oldRows = [entry("older.json")];
const newRows = [...oldRows, entry("new-result.json")];
const response = projects => ({ ok: true, json: async () => ({ projects }) });
globalThis.fetch = (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
const next = () => {
  const promise = loadIndex();
  const request = pending.shift();
  assert.ok(request.url.endsWith("/projects/index.json"));
  assert.equal(request.options.cache, "no-store");
  assert.equal(indexLoading(), true);
  assert.equal(indexLoadError(), null);
  return { promise, ...request };
};

try {
  assert.deepEqual(index(), []);
  // Initial failure is distinguishable from a genuinely empty workspace, without throwing.
  let request = next();
  request.reject(new Error("offline"));
  assert.deepEqual(await request.promise, []);
  assert.equal(indexLoadError(), "unavailable");
  assert.equal(indexLoading(), false);

  request = next();
  request.resolve(response(oldRows));
  assert.deepEqual(await request.promise, oldRows);
  assert.equal(indexLoadError(), null);
  assert.equal(indexLoading(), false);

  // A later completed refresh wins, including the value returned to the older startup caller.
  const older = next(), newer = next();
  newer.resolve(response(newRows));
  assert.deepEqual(await newer.promise, newRows);
  older.resolve(response(oldRows));
  assert.deepEqual(await older.promise, newRows);
  assert.deepEqual(index(), newRows);

  // Completing an old request cannot clear the new request's loading indicator or error state.
  const stale = next(), latest = next();
  stale.reject(new Error("old connection failed"));
  assert.deepEqual(await stale.promise, newRows);
  assert.equal(indexLoading(), true);
  assert.equal(indexLoadError(), null);
  latest.resolve({ ok: false, status: 503 });
  assert.deepEqual(await latest.promise, newRows);
  assert.equal(indexLoadError(), "unavailable");
  assert.equal(indexLoading(), false);

  const lateSuccess = next(), failedLatest = next();
  failedLatest.reject(new Error("newest request failed"));
  await failedLatest.promise;
  lateSuccess.resolve(response(oldRows));
  assert.deepEqual(await lateSuccess.promise, newRows);
  assert.equal(indexLoadError(), "unavailable", "an old success cannot hide the latest failure");
  assert.equal(indexLoading(), false);

  // Malformed JSON, missing/invalid lists and invalid rows retain all known results.
  for (const data of [null, {}, { projects: null }, { projects: {} }, { projects: [null] },
    { projects: [entry("good.json"), { file: "bad.json" }] },
    { projects: [{ ...entry("bad.json"), simulated: "true" }] },
    { projects: [{ ...entry("bad.json"), file: " " }] }]) {
    request = next();
    request.resolve({ ok: true, json: async () => data });
    assert.deepEqual(await request.promise, newRows);
    assert.equal(indexLoadError(), "invalid");
    assert.equal(indexLoading(), false);
  }
  request = next();
  request.resolve({ ok: true, json: async () => { throw new SyntaxError("truncated JSON"); } });
  assert.deepEqual(await request.promise, newRows);
  assert.equal(indexLoadError(), "invalid");

  // The response headers can arrive first while its JSON body is still pending.
  let finishBody;
  const slowBody = next();
  slowBody.resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
  await Promise.resolve();
  const recovered = next();
  recovered.resolve(response([]));
  assert.deepEqual(await recovered.promise, [], "a successful empty index removes deleted results");
  finishBody({ projects: oldRows });
  assert.deepEqual(await slowBody.promise, []);
  assert.deepEqual(index(), []);
  assert.equal(indexLoadError(), null);
  assert.equal(indexLoading(), false);

  // A stalled network or response body must release startup and offer Retry after 30 seconds.
  // Advance a local clock rather than sleeping or relying on the fetch mock honoring abort.
  request = next();
  request.resolve(response(oldRows));
  await request.promise;
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let now = 0, timerId = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  try {
    const stalled = next();
    let finished = false;
    stalled.promise.then(() => { finished = true; });
    await advance(29_999);
    assert.equal(finished, false, "the deadline must not fire early");
    await advance(1);
    assert.equal(finished, true, "a stalled result index must not block startup forever");
    assert.deepEqual(await stalled.promise, oldRows);
    assert.equal(stalled.options.signal.aborted, true);
    assert.equal(indexLoading(), false);
    assert.equal(indexLoadError(), "unavailable");
    assert.equal(timers.size, 0);

    let finishStalledBody;
    const body = next();
    body.resolve({ ok: true, json: () => new Promise(resolve => { finishStalledBody = resolve; }) });
    await advance(0);
    await advance(30_000);
    assert.deepEqual(await body.promise, oldRows);
    assert.equal(body.options.signal.aborted, true);
    assert.equal(indexLoadError(), "unavailable", "a body timeout is a network failure, not invalid JSON");
    finishStalledBody({ projects: newRows });
    await advance(0);
    assert.deepEqual(index(), oldRows, "a timed-out body cannot publish late results");

    const retry = next();
    retry.resolve(response(newRows));
    assert.deepEqual(await retry.promise, newRows);
    assert.equal(indexLoadError(), null);
    assert.equal(indexLoading(), false);
    assert.equal(timers.size, 0, "success clears its deadline");

    const malformed = next();
    malformed.resolve({ ok: true, json: async () => { throw new SyntaxError("broken JSON"); } });
    await malformed.promise;
    assert.equal(indexLoadError(), "invalid");
    assert.equal(timers.size, 0, "failure clears its deadline too");

    const oldTimeout = next();
    await advance(1_000);
    const waiting = next();
    await advance(29_000);
    assert.deepEqual(await oldTimeout.promise, newRows);
    assert.equal(indexLoading(), true, "an old timeout cannot clear a new request's loading state");
    assert.equal(indexLoadError(), null);
    waiting.resolve(response(oldRows));
    await waiting.promise;
    assert.deepEqual(index(), oldRows);
    assert.equal(timers.size, 0);

    const outdated = next(), winner = next();
    winner.resolve(response(newRows));
    await winner.promise;
    await advance(30_000);
    assert.deepEqual(await outdated.promise, newRows);
    assert.deepEqual(index(), newRows);
    assert.equal(indexLoadError(), null, "a stale timeout cannot hide a newer success");
    assert.equal(indexLoading(), false);
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Result index: latest response wins; preserved results; malformed/empty responses; header/body deadlines and recovery passed");
