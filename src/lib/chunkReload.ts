const STORAGE_KEY = "fairbeam.chunkReload";
const COOLDOWN_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

export interface ChunkReloadHost {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener?(type: string, listener: (e: Event) => void): void;
  location: { pathname: string; reload: () => void };
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  fetch: typeof fetch;
}

export interface ChunkReloadOptions {
  dirty: () => boolean;
  isOffline?: () => boolean;
  onUnreachable?: () => void;
  now?: () => number;
  cooldownMs?: number;
  probeTimeoutMs?: number;
}

/** Reload once when a lazy chunk was replaced on disk (e.g. after an update), but never navigate into
 * an unreachable loopback server (which would strand the desktop WebView on a connection-failed page).
 * When the origin does not answer, trigger server recovery instead of reloading. */
export function installChunkReloadGuard(host: ChunkReloadHost, opts: ChunkReloadOptions): () => void {
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let checking: Promise<void> | null = null;

  const handler = () => {
    if (checking) return;
    if (opts.isOffline?.()) {
      opts.onUnreachable?.();
      return;
    }
    let withinCooldown = false;
    try {
      const last = Number(host.sessionStorage.getItem(STORAGE_KEY) ?? 0);
      withinCooldown = now() - last < cooldownMs;
    } catch {
      withinCooldown = true;
    }
    checking = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), probeTimeoutMs);
      let reachable = false;
      try {
        const res = await host.fetch(host.location.pathname || "/", {
          method: "GET",
          cache: "no-store",
          signal: ctl.signal,
        });
        reachable = res.ok;
      } catch {
        reachable = false;
      } finally {
        clearTimeout(timer);
      }
      if (!reachable) {
        opts.onUnreachable?.();
        return;
      }
      if (withinCooldown || opts.dirty()) return;
      try {
        host.sessionStorage.setItem(STORAGE_KEY, String(now()));
      } catch {
        return;
      }
      host.location.reload();
    })().finally(() => {
      checking = null;
    });
  };

  host.addEventListener("vite:preloadError", handler);
  return () => host.removeEventListener?.("vite:preloadError", handler);
}
