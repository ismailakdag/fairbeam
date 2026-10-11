// A local copy of the unsaved draft of the open design, so that a reload, a crash or a closed
// window does not lose work: this page can restore its own draft; prior pages are offered for
// explicit recovery in BackupNotice. Kept per
// workspace, design file and page owner in localStorage; every access is guarded.
import type { Design } from "./types";
import { currentSchema } from "../lib/legacy.ts";
import { newDesignerSessionId } from "./asyncState.ts";

export interface Backup { at: number; base: string; design: Design }
interface ScopedBackup extends Backup { version: 2 | 3; scope: string; id: string; owner?: string }
export interface RecoveryBackup extends Backup { owner?: string; version: 2 | 3 }
export type BackupWriteFailure = "quota" | "unavailable";
export const validBackupScope = (scope: unknown): scope is string => typeof scope === "string" && /^models-v1:[a-f0-9]{64}$/.test(scope);
const prefix = (id: string, scope: string, version = 3) => `fairbeam:draft:v${version}:${scope}:${encodeURIComponent(id)}:`;
const key = (id: string, scope: string, base: string, owner: string) => prefix(id, scope) + encodeURIComponent(base) + ":" + encodeURIComponent(owner);
const lastKey = (scope: string) => `fairbeam:lastDesign:v2:${scope}`;
const changedEvent = "fairbeam:draft-backups-changed";
function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(changedEvent)); }
/** Fresh per document, including duplicated tabs; HMR alone keeps the same owner. */
const ownerSlot = Symbol.for("fairbeam.draftBackup.pageOwner");
const pageGlobals = globalThis as unknown as Record<symbol, string>;
const pageOwner = pageGlobals[ownerSlot] ??= newDesignerSessionId();
function isBackup(value: unknown): value is Backup {
  const b = value as Backup | null;
  return !!b && Number.isFinite(b.at) && b.at > 0 && typeof b.base === "string" && !!b.base
    && currentSchema(b.design?.schema) === "fairbeam.design/1" && typeof b.design.model?.id === "string"
    && Array.isArray(b.design.parts) && Array.isArray(b.design.materials) && Array.isArray(b.design.params);
}

/** Separate instances model independent pages sharing one origin's storage. */
export function createDraftBackupStore(owner: string) {
  if (!owner) throw new Error("draft backup owner is required");
  const writeFailures = new Map<string, BackupWriteFailure>();
  function readBackupWriteFailure(id: string, base: string, scope?: string): BackupWriteFailure | null {
    return validBackupScope(scope) ? writeFailures.get(key(id, scope, base, owner)) ?? null : null;
  }
  function records(id: string, scope: string): ScopedBackup[] {
    const found: ScopedBackup[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const candidate = localStorage.key(i);
        for (const version of [2, 3] as const) {
          const start = prefix(id, scope, version);
          if (!candidate?.startsWith(start)) continue;
          try {
            const b = JSON.parse(localStorage.getItem(candidate) ?? "null") as ScopedBackup;
            if (!isBackup(b) || b.version !== version || b.scope !== scope || b.id !== id) continue;
            const expected = version === 2 ? start + encodeURIComponent(b.base)
              : typeof b.owner === "string" && b.owner ? key(id, scope, b.base, b.owner) : null;
            if (candidate !== expected) continue;
            b.design.schema = "fairbeam.design/1";
            found.push(b);
          } catch { /* one broken record does not hide the other recoverable drafts */ }
        }
      }
    } catch { /* storage unavailable */ }
    return found;
  }
  function writeBackup(id: string, base: string, design: Design, scope?: string) {
    if (!validBackupScope(scope)) return;
    const target = key(id, scope, base, owner);
    try {
      localStorage.setItem(target, JSON.stringify({ version: 3, scope, id, owner, at: Date.now(), base, design } satisfies ScopedBackup));
      writeFailures.delete(target);
      notify();
    } catch (error) {
      // Keep every existing recovery record. Report only this page/file/base's failed write.
      const failure = error instanceof Error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED") ? "quota" : "unavailable";
      if (writeFailures.get(target) !== failure) { writeFailures.set(target, failure); notify(); }
    }
  }
  /** Only this page's draft can be restored without an explicit choice. */
  function readBackup(id: string, base: string, scope?: string): Backup | null {
    if (!validBackupScope(scope)) return null;
    return records(id, scope).find(b => b.version === 3 && b.owner === owner && b.base === base) ?? null;
  }
  function clearBackup(id: string, scope?: string, base?: string) {
    if (!validBackupScope(scope)) return;
    try {
      for (const b of records(id, scope)) if (b.version === 3 && b.owner === owner && (base === undefined || b.base === base)) {
        localStorage.removeItem(key(id, scope, b.base, owner));
      }
      notify();
    } catch { /* storage unavailable */ }
  }
  /** Previous pages, other open windows and v2 drafts remain explicitly recoverable. */
  function readOlderBackups(id: string, base: string, scope?: string): RecoveryBackup[] {
    if (!validBackupScope(scope)) return [];
    return records(id, scope).filter(b => b.version === 2 || b.owner !== owner || b.base !== base)
      .sort((a, b) => b.at - a.at);
  }
  return { writeBackup, readBackup, clearBackup, readOlderBackups, readBackupWriteFailure };
}
export const { writeBackup, readBackup, clearBackup, readOlderBackups, readBackupWriteFailure } = createDraftBackupStore(pageOwner);
export function watchBackups(changed: () => void): () => void {
  const external = (e: StorageEvent) => { if (e.key === null || e.key.startsWith("fairbeam:draft:")) changed(); };
  window.addEventListener("storage", external);
  window.addEventListener(changedEvent, changed);
  return () => { window.removeEventListener("storage", external); window.removeEventListener(changedEvent, changed); };
}

/** Legacy records have no proven workspace owner. Offer a download; never auto-restore/delete. */
export function readLegacyBackup(id: string): Backup | null {
  try {
    const raw = localStorage.getItem(`fairbeam:draft:${id}`);
    if (!raw) return null;
    const b: unknown = JSON.parse(raw);
    return isBackup(b) ? b : null;
  } catch { return null; }
}

// The design that was open when the page reloaded (or the dev server hot-reloaded): reopened at
// start-up so a reload does not drop the user on the Start screen. sessionStorage, so it lives as
// long as the window does; closing the design on purpose (or the window) forgets it.
export function rememberLastDesign(id: string, scope?: string) {
  if (!validBackupScope(scope)) return;
  try { sessionStorage.setItem(lastKey(scope), id); } catch { /* storage unavailable */ }
}
export function readLastDesign(scope?: string): string | null {
  if (!validBackupScope(scope)) return null;
  try { return sessionStorage.getItem(lastKey(scope)); } catch { return null; }
}
export function forgetLastDesign(scope?: string) {
  if (!validBackupScope(scope)) return;
  try { sessionStorage.removeItem(lastKey(scope)); } catch { /* storage unavailable */ }
}
