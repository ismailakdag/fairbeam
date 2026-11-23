import assert from "node:assert/strict";
import { optimizationNodes, bestParameterChanges } from "../src/designer/optimizationResults.ts";
import { optimizeElapsedSeconds, optimizeProgressPercent, summarizeOptimizeLive } from "../src/runner/optimizeLive.ts";

const opt = { method: "nelder-mead", max_evals: 40, vary: [{ key: "width", min: 1, max: 5 }], goals: [{ kind: "s11_max", target: -10, at: 2.45 }] };
const job = { id: "opt-1", kind: "optimize", status: "done", model: "design-a", created: 1, finished: 2, label: "Tune", name: "tune", optimize: opt,
  stats: { file: "optimizations/tune.json", best_file: "optimizations/tune/best.json", evaluations: 40, max_evals: 40 } };
const running = { ...job, id: "opt-2", status: "running", created: 5, finished: null, stats: { file: "optimizations/t2.json", evaluations: 14, max_evals: 40 } };
const runs = (id) => id === "opt-1" ? [{ index: 1, file: "optimizations/tune/1.json", label: "width=2 (evaluation 1)" }, { index: 2, file: "optimizations/tune/best.json", label: "width=3 (evaluation 2)" }] : [];
const nodes = optimizationNodes([job, { ...job, id: "other", model: "design-b" }, running], "design-a", runs);
assert.equal(nodes.length, 2, "a running and a finished optimization of this design");
assert.equal(nodes[0].id, "optimization:opt-2", "newest first");
assert.equal(nodes[0].label, "Nelder–Mead · |S11| ≤ -10 dB @ 2.45 GHz · 14/40 · running");
assert.equal(nodes[1].label, "Nelder–Mead · |S11| ≤ -10 dB @ 2.45 GHz · 40/40 · done");
assert.equal(nodes[0].action.kind, "optimization");
assert.deepEqual(nodes[0].children.map((c) => c.label), ["Progress"], "no best run yet, no evaluated runs known");
assert.deepEqual(nodes[1].children.map((c) => c.label), ["Progress", "Best result", "Evaluated runs"]);
assert.equal(nodes[1].children[0].action.kind, "optimization-history");
assert.equal(nodes[1].children[1].action.kind, "optimization-best");
assert.equal(nodes[1].children[1].action.file, "optimizations/tune/best.json");
assert.deepEqual(nodes[1].children[2].children.map((c) => c.action.file), ["optimizations/tune/1.json", "optimizations/tune/best.json"]);
assert.equal(nodes[1].children[2].children[1].sub, "best");
const cancelled = optimizationNodes([{ ...job, id: "stopped", status: "cancelled" }], "design-a");
assert.match(cancelled[0].label, /stopped$/, "a stopped optimization keeps its partial history");
assert.equal(cancelled[0].children[0].action.kind, "optimization-history");

// the tree filters by the design's file id (a job's `model`), not the design's model.id
const byFile = { ...job, id: "file-id", model: "zz_opt", model_id: "zz-opt" };
assert.equal(optimizationNodes([byFile], "zz_opt").length, 1, "jobs match the design file id");
assert.equal(optimizationNodes([byFile], "zz-opt").length, 0, "model.id is not the job's model key");
assert.equal(optimizationNodes([byFile], "").length, 0, "no open design file: no optimization rows");
const tree = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/NavTree.tsx", import.meta.url), "utf8"));
assert.match(tree, /optimizationNodes\(jobs\(\), file\(\)\?\.id/, "NavTree passes the design file id");
assert.doesNotMatch(tree, /fetch\(`\/api\/optimizations/, "Save best goes through the runner store (JSON POST)");
assert.match(tree, /case "optimization-best": focusResult\(/, "Open best opens in the designer dock");
// the tree menu of an optimization node: Open, Apply best parameters, Stop while running, Delete record
for (const key of ["optTree.menu.open", "optTree.menu.apply", "optTree.menu.stop", "optTree.menu.delete"]) assert.ok(tree.includes(`t("${key}")`), `menu item ${key}`);
assert.match(tree, /sec\("optimizations"/, "Optimizations is its own tree folder");
assert.match(tree, /!isTerminal\(job\.status\)\) actions\.push\(\{ label: t\("optTree\.menu\.stop"\)/, "Stop only while running");
const actions = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/optimizationActions.ts", import.meta.url), "utf8"));
assert.match(actions, /}, "", t\("tree\.history\.applyOptimization"\)\);/, "Apply best parameters is one named undo step");
const props = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/PropsExtras.tsx", import.meta.url), "utf8"));
for (const key of ["optTree.menu.open", "optTree.menu.apply", "optTree.menu.stop", "optTree.menu.delete", "optTree.props.bounds", "optTree.props.bestParams"]) assert.ok(props.includes(`t("${key}")`), `Properties shows ${key}`);

const design = { params: [{ key: "width", default: 1 }, { key: "gap", default: 2 }] };
assert.deepEqual(bestParameterChanges(design, { width: 3.5 }), { ok: true, changes: { width: 3.5 } });
assert.equal(bestParameterChanges(design, { width: 3, missing: 4 }).ok, false, "unknown keys reject the entire apply");
assert.equal(bestParameterChanges(design, { width: Infinity }).ok, false, "non-finite values reject the entire apply");
assert.equal(bestParameterChanges({ params: [{ key: "width", default: 1, min: 0, max: 2 }] }, { width: 3 }).ok, false, "out-of-range values reject the entire apply");

// ---- Live optimizer progress & elapsed clock regressions (#12)
// Root cause A: live elapsed time must tick continuously while !done and NEVER freeze at latest().elapsed_s
assert.equal(
  optimizeElapsedSeconds({ done: false, elapsedNow: 5, latestEvalElapsed: undefined, doneWallTime: undefined }),
  5,
  "before evaluation #1 finishes, live elapsed ticker is shown",
);
for (const tick of [12.4, 30, 300, 1845]) {
  assert.equal(
    optimizeElapsedSeconds({ done: false, elapsedNow: tick, latestEvalElapsed: 12.4, doneWallTime: undefined }),
    tick,
    `while running past evaluation #1, elapsed time advances to ${tick}s instead of freezing at 12.4s`,
  );
}
assert.equal(
  optimizeElapsedSeconds({ done: true, elapsedNow: 1900, latestEvalElapsed: 1850, doneWallTime: 1852.6 }),
  1852.6,
  "once done, optDone.wall_time_s is authoritative",
);
assert.equal(
  optimizeElapsedSeconds({ done: true, elapsedNow: 1900, latestEvalElapsed: 1850, doneWallTime: undefined }),
  1850,
  "if stopped before opt_done, falls back to latest().elapsed_s then elapsed()",
);
assert.equal(
  optimizeElapsedSeconds({ done: true, elapsedNow: 42, latestEvalElapsed: undefined, doneWallTime: undefined }),
  42,
  "cancelled before first evaluation finishes keeps job elapsed duration",
);

// Root cause B: active candidate state renders/clears properly, and progressPercent advances monotonically
{
  const stream = [{ type: "opt_start", max_evals: 12, ports: [1, 2], excite: [1, 2] }];
  let s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(s.active, null);
  assert.equal(optimizeProgressPercent(s), 0);

  // Evaluation #1 starts and completes (1/12 = 8%)
  stream.push({ type: "opt_active", index: 1, max_evals: 12, params: { length: 58 }, excite: [1, 2] });
  s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(s.active?.index, 1);
  assert.deepEqual(s.active?.params, { length: 58 });
  assert.equal(s.active?.timestep, null);
  assert.equal(optimizeProgressPercent(s), 0);

  stream.push({ type: "opt_progress", index: 1, timestep: 4000, max_timesteps: 60000, energy_db: -25.5, fraction: 0.5, port: 1, port_run: 1, port_total: 2, mcells_s: 140.2 });
  s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(s.active?.timestep, 4000);
  assert.equal(s.active?.energy_db, -25.5);
  assert.equal(s.active?.port, 1);
  assert.equal(optimizeProgressPercent(s), 4, "(0 + 0.5) / 12 rounds to 4%");

  stream.push({ type: "opt_eval", index: 1, evaluations: 1, max_evals: 12, elapsed_s: 12.4 });
  s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(s.active, null, "opt_eval clears active candidate state");
  assert.equal(optimizeProgressPercent(s), 8, "1/12 completed = 8%");

  // Evaluation #2 runs for a long time: percentage advances smoothly & monotonically instead of staying stuck at 8%
  stream.push({ type: "opt_active", index: 2, max_evals: 12, params: { length: 56.5 }, excite: [1, 2] });
  s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(s.active?.index, 2);
  assert.deepEqual(s.active?.params, { length: 56.5 });
  assert.equal(optimizeProgressPercent(s), 8);

  const historyPct = [optimizeProgressPercent(s)];
  for (const [ts, frac, port, portRun] of [
    [3000, 0.3, 1, 1],
    [6000, 0.6, 1, 1],
    [6500, 0.45, 1, 1], // lower sample must not make progress jump backwards
    [2000, 0.85, 2, 2],
  ]) {
    stream.push({ type: "opt_progress", index: 2, timestep: ts, max_timesteps: 60000, energy_db: -35, fraction: frac, port, port_run: portRun, port_total: 2 });
    s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
    historyPct.push(optimizeProgressPercent(s));
  }
  assert.deepEqual(historyPct, [8, 11, 13, 13, 15], "intra-evaluation progress advances smoothly and monotonically beyond 8%");
  assert.equal(s.active?.port, 2);
  assert.equal(s.active?.port_run, 2);

  // Near budget completion (eval 12 of 12 at 99.9% solver fraction): clamped to <= 99% until done
  for (let idx = 2; idx <= 11; idx++) {
    stream.push({ type: "opt_eval", index: idx, evaluations: idx, max_evals: 12 });
  }
  stream.push({ type: "opt_active", index: 12, max_evals: 12, params: { length: 57.9 } });
  stream.push({ type: "opt_progress", index: 12, timestep: 59900, max_timesteps: 60000, fraction: 0.999 });
  s = summarizeOptimizeLive(stream, { status: "running", budget: 12 });
  assert.equal(optimizeProgressPercent(s), 99, "never exceeds 99% before done while active evaluation is still running");

  // Once done (opt_done or terminal status), active clears and 12/12 reaches 100%
  stream.push({ type: "opt_eval", index: 12, evaluations: 12, max_evals: 12 });
  stream.push({ type: "opt_done", evaluations: 12, wall_time_s: 240 });
  s = summarizeOptimizeLive(stream, { status: "done", budget: 12 });
  assert.equal(s.active, null, "opt_done clears active state");
  assert.equal(optimizeProgressPercent(s), 100);

  // Cancellation mid-evaluation clears active state immediately
  const cancelledStream = [
    { type: "opt_start", max_evals: 12 },
    { type: "opt_eval", index: 1, evaluations: 1, max_evals: 12 },
    { type: "opt_active", index: 2, max_evals: 12, params: { length: 55 } },
    { type: "opt_progress", index: 2, timestep: 5000, fraction: 0.5 },
    { type: "status", status: "cancelled" },
  ];
  const cancelledState = summarizeOptimizeLive(cancelledStream, { status: "cancelled", budget: 12 });
  assert.equal(cancelledState.active, null, "terminal status clears active candidate state");
  assert.equal(cancelledState.done, true);
  assert.equal(optimizeProgressPercent(cancelledState), 8, "cancelled summary reflects completed evaluations");

  // Fallback from job.stats.active_eval works when attaching mid-run before SSE replay
  const midAttach = summarizeOptimizeLive([], {
    status: "running",
    budget: 10,
    fallbackCompleted: 2,
    fallbackActive: { index: 3, params: { width: 31.2 }, timestep: 8000, max_timesteps: 40000, fraction: 0.5 },
  });
  assert.equal(midAttach.active?.index, 3);
  assert.equal(optimizeProgressPercent(midAttach), 25, "(2 + 0.5) / 10 = 25%");
}

const optProgressSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/runner/OptimizeProgress.tsx", import.meta.url), "utf8"));
assert.doesNotMatch(optProgressSrc, /latest\(\)\?\.elapsed_s \?\? elapsed\(\)/, "OptimizeProgress never freezes elapsed time at latest().elapsed_s");
assert.match(optProgressSrc, /optimizeElapsedSeconds\(\{ done: done\(\), elapsedNow: elapsed\(\)/, "OptimizeProgress uses live elapsed ticker while running");
assert.match(optProgressSrc, /!done\(\) && optActive\(\)/, "OptimizeProgress renders active candidate only while running");
const storeSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/runner/store.ts", import.meta.url), "utf8"));
assert.match(storeSrc, /"opt_active",\s*"opt_progress"/, "EventSource subscribes to opt_active and opt_progress SSE events");
const statusBarSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/designer/StatusBar.tsx", import.meta.url), "utf8"));
assert.match(statusBarSrc, /j\.kind === "optimize" \? optProgressPercent\(\)/, "Designer status bar uses live optimization percentage");

console.log("Optimization results tree checks passed.");
