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
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Result index: latest response wins; errors preserve results; malformed, empty and delayed responses passed");
