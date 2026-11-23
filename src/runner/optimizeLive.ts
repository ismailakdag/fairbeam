// Pure live-state derivation for optimization jobs: elapsed clock, active candidate,
// intra-evaluation solver progress, and monotonic percentage. Uses type-only imports so
// scripts/check-optimize-tree.mjs can test the exact production logic in Node.
import type { JobStatus, OptActive, OptProgress } from "./api";

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["done", "failed", "cancelled", "interrupted"]);

export interface ActiveEvaluation {
  index: number;
  max_evals?: number;
  params: Record<string, number>;
  excite?: number[];
  timestep: number | null;
  max_timesteps: number | null;
  energy_db: number | null;
  fraction: number;
  port?: number;
  port_run?: number;
  port_total?: number;
  mcells_s: number | null;
}

export type OptimizeStreamEvent =
  | { type: "opt_start"; max_evals?: number; ports?: number[]; excite?: number[] }
  | ({ type: "opt_active" } & OptActive)
  | ({ type: "opt_progress" } & OptProgress)
  | { type: "opt_eval"; index: number; evaluations?: number; max_evals?: number; elapsed_s?: number }
  | { type: "opt_done"; evaluations: number; wall_time_s?: number }
  | { type: "status"; status: JobStatus }
  | { type: string };

export interface OptimizeLiveSummary {
  completedEvals: number;
  budget: number;
  active: ActiveEvaluation | null;
  /** Monotonic completed + active evaluation units while running; completed count once done. */
  effectiveEvals: number;
  done: boolean;
}

const clamp01 = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
};

/** Reduce an optimization job's event stream (plus optional job metadata/stats fallback) into
 * completed count, active candidate state, and monotonic effective evaluation progress. */
export function summarizeOptimizeLive(
  events: readonly OptimizeStreamEvent[],
  opts: {
    status?: JobStatus;
    budget?: number;
    fallbackActive?: (OptActive & Partial<OptProgress>) | null;
    fallbackCompleted?: number;
  } = {},
): OptimizeLiveSummary {
  let done = opts.status ? TERMINAL_STATUS.has(opts.status) : false;
  let budget = typeof opts.budget === "number" && opts.budget > 0 ? opts.budget : 0;
  let completedEvals = typeof opts.fallbackCompleted === "number" && opts.fallbackCompleted > 0 ? opts.fallbackCompleted : 0;
  let active = null as ActiveEvaluation | null;
  const currentFor = (index: number): ActiveEvaluation | null => (active && active.index === index ? active : null);
  let maxEffective = completedEvals;

  for (const ev of events) {
    if (ev.type === "status" && "status" in ev && typeof ev.status === "string") {
      if (TERMINAL_STATUS.has(ev.status)) {
        done = true;
        active = null;
      }
    } else if (ev.type === "opt_start") {
      const s = ev as Extract<OptimizeStreamEvent, { type: "opt_start" }>;
      if (!budget && typeof s.max_evals === "number" && s.max_evals > 0) budget = s.max_evals;
      active = null;
    } else if (ev.type === "opt_active") {
      const a = ev as Extract<OptimizeStreamEvent, { type: "opt_active" }>;
      if (!budget && typeof a.max_evals === "number" && a.max_evals > 0) budget = a.max_evals;
      if (!done && a.index > completedEvals) {
        active = {
          index: a.index,
          max_evals: a.max_evals,
          params: { ...(a.params ?? {}) },
          excite: a.excite ? [...a.excite] : undefined,
          timestep: null,
          max_timesteps: null,
          energy_db: null,
          fraction: 0,
          port: undefined,
          port_run: undefined,
          port_total: a.excite?.length,
          mcells_s: null,
        };
      }
    } else if (ev.type === "opt_progress") {
      const p = ev as Extract<OptimizeStreamEvent, { type: "opt_progress" }>;
      if (!budget && typeof p.max_evals === "number" && p.max_evals > 0) budget = p.max_evals;
      if (!done && p.index > completedEvals) {
        const prev = currentFor(p.index);
        const frac = Math.max(prev?.fraction ?? 0, clamp01(p.fraction));
        active = {
          index: p.index,
          max_evals: p.max_evals ?? prev?.max_evals,
          params: prev?.params ?? {},
          excite: prev?.excite,
          timestep: typeof p.timestep === "number" && Number.isFinite(p.timestep) ? p.timestep : (prev?.timestep ?? null),
          max_timesteps: typeof p.max_timesteps === "number" && Number.isFinite(p.max_timesteps) ? p.max_timesteps : (prev?.max_timesteps ?? null),
          energy_db: p.energy_db === null ? null : typeof p.energy_db === "number" && Number.isFinite(p.energy_db) ? p.energy_db : (prev?.energy_db ?? null),
          fraction: frac,
          port: typeof p.port === "number" ? p.port : prev?.port,
          port_run: typeof p.port_run === "number" ? p.port_run : prev?.port_run,
          port_total: typeof p.port_total === "number" ? p.port_total : prev?.port_total,
          mcells_s: typeof p.mcells_s === "number" && Number.isFinite(p.mcells_s) ? p.mcells_s : (prev?.mcells_s ?? null),
        };
        maxEffective = Math.max(maxEffective, completedEvals + active.fraction);
      }
    } else if (ev.type === "opt_eval") {
      const e = ev as Extract<OptimizeStreamEvent, { type: "opt_eval" }>;
      if (!budget && typeof e.max_evals === "number" && e.max_evals > 0) budget = e.max_evals;
      const count = typeof e.evaluations === "number" ? e.evaluations : Math.max(completedEvals + 1, e.index);
      completedEvals = Math.max(completedEvals, count);
      if (!active || active.index <= e.index) active = null;
      maxEffective = Math.max(maxEffective, completedEvals);
    } else if (ev.type === "opt_done") {
      const d = ev as Extract<OptimizeStreamEvent, { type: "opt_done" }>;
      if (typeof d.evaluations === "number") completedEvals = Math.max(completedEvals, d.evaluations);
      done = true;
      active = null;
      maxEffective = Math.max(maxEffective, completedEvals);
    }
  }

  if (done) {
    active = null;
  } else if (!active && opts.fallbackActive && opts.fallbackActive.index > completedEvals) {
    const f = opts.fallbackActive;
    active = {
      index: f.index,
      max_evals: f.max_evals,
      params: { ...(f.params ?? {}) },
      excite: f.excite ? [...f.excite] : undefined,
      timestep: typeof f.timestep === "number" && Number.isFinite(f.timestep) ? f.timestep : null,
      max_timesteps: typeof f.max_timesteps === "number" && Number.isFinite(f.max_timesteps) ? f.max_timesteps : null,
      energy_db: typeof f.energy_db === "number" && Number.isFinite(f.energy_db) ? f.energy_db : null,
      fraction: clamp01(f.fraction),
      port: f.port,
      port_run: f.port_run,
      port_total: f.port_total ?? f.excite?.length,
      mcells_s: typeof f.mcells_s === "number" && Number.isFinite(f.mcells_s) ? f.mcells_s : null,
    };
    maxEffective = Math.max(maxEffective, completedEvals + active.fraction);
  }

  return {
    completedEvals,
    budget,
    active,
    effectiveEvals: done ? completedEvals : maxEffective,
    done,
  };
}

/** Percentage [0, 100] of the evaluation budget, incorporating active intra-evaluation progress
 * monotonically and never exceeding 99% before `done` unless the budget is reached. */
export function optimizeProgressPercent(summary: Pick<OptimizeLiveSummary, "completedEvals" | "budget" | "effectiveEvals" | "done">): number {
  const { completedEvals, budget, effectiveEvals, done } = summary;
  if (!(budget > 0)) return 0;
  if (done) return Math.min(100, Math.round((100 * completedEvals) / budget));
  if (completedEvals >= budget) return 100;
  const pct = Math.round((100 * Math.max(completedEvals, effectiveEvals)) / budget);
  return Math.max(0, Math.min(99, pct));
}

/** Elapsed seconds to display for an optimization job: live ticker while running, final wall time once done. */
export function optimizeElapsedSeconds(opts: {
  done: boolean;
  elapsedNow: number | null;
  doneWallTime?: number | null;
  latestEvalElapsed?: number | null;
}): number | null {
  if (opts.done) return opts.doneWallTime ?? opts.latestEvalElapsed ?? opts.elapsedNow;
  return opts.elapsedNow;
}
