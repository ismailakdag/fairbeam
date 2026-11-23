// Regression checks for sweep / run-server crash resilience (#11):
//   1. vite:preloadError never calls location.reload() into an unreachable loopback server (which
//      would strand the desktop WebView on "Connecting to localhost..." and destroy session state),
//      nor with unsaved edits; instead it triggers server recovery.
//   2. Desktop probeServer() and recheckServer() invoke Tauri's `recover_server` when /api/health
//      fails, seamlessly respawning an exited `fairbeam serve` child in place without losing state.
//   3. refreshRuns() coalesces overlapping 1 s sweep polls into single-flight + 1 trailing request so
//      concurrent /api/runs calls never starve the browser's 6-socket HTTP/1.1 origin pool.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root,
  configFile: false,
  logLevel: "silent",
  resolve: { conditions: ["browser"] },
  plugins: [{
    name: "sweep-recovery-entry",
    resolveId(id) { if (id.endsWith("sweep-recovery-entry")) return "\0sweep-recovery-entry"; },
    load(id) {
      if (id !== "\0sweep-recovery-entry") return;
      return ["lib/chunkReload", "runner/store", "runner/api"]
        .map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`)
        .join("\n");
    },
  }],
  build: { write: false, minify: false, lib: { entry: "sweep-recovery-entry", formats: ["es"] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: chunkReload, m1: runner, m2: { api } } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`,
);

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

// ------------------------------------------------------------------ 1. chunkReload guard
{
  const listeners = new Map();
  const session = new Map();
  let reloads = 0;
  let unreachable = 0;
  let isDirty = false;
  let offline = false;
  let nowMs = 100_000;
  let fetchImpl = async () => { throw new TypeError("Failed to fetch"); };

  const host = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    location: { pathname: "/", reload() { reloads++; } },
    sessionStorage: {
      getItem: (k) => session.get(k) ?? null,
      setItem: (k, v) => session.set(k, String(v)),
    },
    fetch: (url, init) => fetchImpl(url, init),
  };

  const dispose = chunkReload.installChunkReloadGuard(host, {
    dirty: () => isDirty,
    isOffline: () => offline,
    onUnreachable: () => { unreachable++; },
    now: () => nowMs,
  });

  // Unreachable server: must NOT reload, must NOT burn cooldown, MUST trigger recovery.
  listeners.get("vite:preloadError")(new Event("vite:preloadError"));
  await settle();
  assert.equal(reloads, 0, "never reload into a dead server");
  assert.equal(unreachable, 1, "triggers server recovery on unreachable origin");
  assert.equal(session.has("fairbeam.chunkReload"), false, "cooldown not consumed when reload skipped");

  // Known-offline server: short-circuits into recovery without reloading.
  offline = true;
  listeners.get("vite:preloadError")(new Event("vite:preloadError"));
  await settle();
  assert.equal(reloads, 0);
  assert.equal(unreachable, 2);
  offline = false;

  // Reachable server, but dirty draft: must NOT reload.
  fetchImpl = async () => ({ ok: true });
  isDirty = true;
  listeners.get("vite:preloadError")(new Event("vite:preloadError"));
  await settle();
  assert.equal(reloads, 0, "never reload with unsaved edits");

  // Reachable server and clean draft: reloads once, then respects cooldown.
  isDirty = false;
  listeners.get("vite:preloadError")(new Event("vite:preloadError"));
  await settle();
  assert.equal(reloads, 1, "reloads once when origin answers 200 OK and draft is clean");

  nowMs += 5_000;
  listeners.get("vite:preloadError")(new Event("vite:preloadError"));
  await settle();
  assert.equal(reloads, 1, "suppresses second reload within 30 s cooldown");

  dispose();
  assert.equal(listeners.has("vite:preloadError"), false);
}

// ------------------------------------------------------------------ 2. desktop recover_server
{
  let serverAlive = true;
  let recoverCalls = 0;
  let modelsCalls = 0;
  let runsCalls = 0;
  let queueVersion = 1;

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ projects: [] }), { status: 200 });
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd) => {
        assert.equal(cmd, "recover_server");
        recoverCalls++;
        serverAlive = true;
        queueVersion++;
        return { status: "recovered", port: 5320 };
      },
    },
  };

  api.health = async () => {
    if (!serverAlive) throw new Error("connection refused");
    return {
      ok: true,
      api: 1,
      cpu_count: 8,
      default_threads: 4,
      engines: ["cpu"],
      desktop: true,
      queue: { running: null, queued: 0, version: queueVersion, external: 0 },
    };
  };
  api.models = async () => { modelsCalls++; return []; };
  api.runs = async () => { runsCalls++; return []; };

  assert.equal(await runner.probeServer(), true);
  assert.equal(runner.serverState(), "online");
  assert.equal(recoverCalls, 0);

  // Simulate mid-sweep server crash: recheckServer() transparently recovers in place!
  serverAlive = false;
  const modelsBefore = modelsCalls;
  const runsBefore = runsCalls;
  assert.equal(await runner.recheckServer(), true);
  assert.equal(recoverCalls, 1, "recheckServer invokes desktop recover_server");
  assert.equal(runner.serverState(), "online", "stays online after in-place server recovery");
  assert.equal(modelsCalls, modelsBefore + 1, "refreshes models after respawn");
  assert.equal(runsCalls, runsBefore + 1, "refreshes runs after respawn");

  // If desktop recovery is unavailable (e.g. non-recoverable failure), falls back to offline cleanly,
  // then clicking Check again (probeServer) recovers when available again.
  globalThis.window.__TAURI_INTERNALS__.invoke = async () => ({ status: "unavailable" });
  serverAlive = false;
  assert.equal(await runner.recheckServer(), false);
  assert.equal(runner.serverState(), "offline");

  globalThis.window.__TAURI_INTERNALS__.invoke = async () => {
    recoverCalls++;
    serverAlive = true;
    return { status: "recovered", port: 5320 };
  };
  assert.equal(await runner.probeServer(), true);
  assert.equal(runner.serverState(), "online", "Check again recovers dead desktop server");
  delete globalThis.window;
  globalThis.fetch = savedFetch;
}

// ------------------------------------------------------------------ 3. single-flight refreshRuns()
{
  let inFlight = 0;
  let maxInFlight = 0;
  let totalCalls = 0;
  const gates = [];
  api.runs = () => {
    inFlight++;
    totalCalls++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      gates.push(() => {
        inFlight--;
        resolve([{
          id: `run-${totalCalls}`, status: "running", model: "patch", model_id: "patch",
          label: null, sweep: null, params: {}, overrides: {}, threads: 2, name: null,
          phase: "running", created: 1, started: 1, finished: null, created_iso: null,
          duration_s: null, exit_code: null, bundle: null, error: null, end_criteria_db: null,
          engine: "cpu", last_progress: null, stats: {}, info: {},
        }]);
      });
    });
  };

  // Fire 8 overlapping 1 s poll calls while the first request is still pending.
  const callers = Array.from({ length: 8 }, () => runner.refreshRuns());
  await settle();
  assert.equal(maxInFlight, 1, "never opens more than 1 /api/runs request at a time");
  assert.equal(totalCalls, 1, "overlapping polls share the active request + 1 trailing slot");

  gates.shift()();
  await settle();
  assert.equal(maxInFlight, 1, "trailing refresh also stays single-flight");
  assert.equal(totalCalls, 2, "all 7 queued callers coalesce into a single trailing request");

  gates.shift()();
  await Promise.all(callers);
  assert.equal(runner.jobs()[0]?.id, "run-2", "awaiting callers observe the fresh trailing result");
}

console.log("sweep & server recovery checks passed");
