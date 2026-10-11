import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { file, restoreRecovery } from "./store";
import { type Backup, readLegacyBackup, readOlderBackups, validBackupScope, watchBackups } from "./draftBackup";
import { downloadFailedMessage, downloadMessage, saveDownload } from "../lib/download";
import { fmt, t } from "../i18n";

/** Old unscoped drafts remain available without silently assigning them to this workspace. */
export default function BackupNotice() {
  const current = () => file();
  const [revision, setRevision] = createSignal(0);
  onCleanup(watchBackups(() => setRevision(n => n + 1)));
  const legacy = createMemo(() => { revision(); return current() && !current()!.readonly ? readLegacyBackup(current()!.id) : null; });
  const older = createMemo(() => {
    revision();
    const f = current();
    return f && !f.readonly ? readOlderBackups(f.id, f.hash, f.backup_scope) : [];
  });
  const [busy, setBusy] = createSignal(false), [note, setNote] = createSignal("");
  createEffect(on(current, () => setNote("")));
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const restore = async (saved: Backup) => {
    if (busy()) return;
    const f = current();
    setBusy(true); setNote("");
    try { await restoreRecovery(saved); }
    catch (error) { if (!disposed && current() === f) setNote((error as Error).message); }
    finally { if (!disposed) setBusy(false); }
  };
  const download = async (saved: Backup | null) => {
    const f = current();
    if (!f || !saved || busy()) return;
    const name = `${f.id}.recovered-${saved.at}.design.json`;
    setBusy(true); setNote("");
    try {
      const result = await saveDownload(name, JSON.stringify(saved.design, null, 2) + "\n", "application/json");
      if (!disposed && current() === f) setNote(downloadMessage(result));
    } catch (error) {
      if (!disposed && current() === f) setNote(downloadFailedMessage(name, error));
    } finally { if (!disposed) setBusy(false); }
  };
  return <>
    <Show when={current() && !current()!.readonly && !validBackupScope(current()!.backup_scope)}>
      <p class="dz-msg dz-msg-warn" role="status">{t("store.backupScopeUnavailable")}</p>
    </Show>
    <Show when={legacy()}>
      <div class="dz-msg dz-msg-warn" role="status">
        <p>{t("store.legacyBackup")}</p>
        <button class="btn btn-sm" disabled={busy()} onClick={() => void download(legacy())}>{t("store.legacyBackupDownload")}</button>
      </div>
    </Show>
    <For each={older()}>{saved => <div class="dz-msg dz-msg-warn" role="status" data-recovery-owner={saved.owner ?? "v2"}>
      <p>{t("store.recoveryBackup", { name: saved.design.model.name || saved.design.model.id, at: fmt.dateTime(saved.at), owner: saved.owner?.slice(-8) ?? t("store.recoveryPrevious") })}</p>
      <Show when={saved.base !== current()?.hash}><p>{t("store.recoveryOlderBase")}</p></Show>
      <div class="cluster">
        <button class="btn btn-sm" disabled={busy()} onClick={() => void restore(saved)}>{t("store.restoreBackup")}</button>
        <button class="btn btn-sm" disabled={busy()} onClick={() => void download(saved)}>{t("store.legacyBackupDownload")}</button>
      </div>
    </div>}</For>
    <Show when={note()}><p class="dz-msg" role="status">{note()}</p></Show>
  </>;
}
