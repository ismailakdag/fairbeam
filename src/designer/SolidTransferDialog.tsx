import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { t } from "../i18n";
import { checkTitle, parameterErrorTitle } from "./checkText";
import {
  applySolidTransfer,
  buildSolidTransfer,
  parseSolidTransfer,
  previewSolidTransfer,
  SolidTransferError,
  type SolidConflictMode,
  type SolidTransferDiagnostic,
  type SolidTransferPayload,
  type SolidTransferPreview,
} from "./solidTransfer";
import {
  closeSolidExportDialog,
  closeSolidImportDialog,
  exportSolidsToFile,
  solidExportTarget,
  solidImportOpen,
} from "./solidTransferUi";
import { draft, edit, file, setMessage, setSelection } from "./store";
import type { Design } from "./types";
import "../styles/designer-parameters.css";

function formatDiagnostic(diag: SolidTransferDiagnostic | undefined, fallback?: string): string {
  if (!diag) return fallback ? parameterErrorTitle(fallback) : "";
  switch (diag.code) {
    case "file-too-large":
      return t("solidTransfer.error.fileTooLarge");
    case "invalid-json":
      return t("solidTransfer.error.invalidJson");
    case "invalid-schema":
      return t("solidTransfer.error.invalidSchema");
    case "invalid-structure":
      return t("solidTransfer.error.invalidStructure");
    case "material-missing":
      return diag.params?.material
        ? t("solidTransfer.error.materialMissing", { material: String(diag.params.material) })
        : t("solidTransfer.error.invalidStructure");
    case "solid-duplicate":
      return t("solidTransfer.error.solidDuplicate", { name: String(diag.params?.name ?? "") });
    case "solid-name":
      return t("solidTransfer.error.solidName", { name: String(diag.params?.name ?? "") });
    case "param-key":
    case "param-duplicate":
    case "param-value":
    case "param-expr":
      return parameterErrorTitle(diag.message);
    case "design-check":
      return diag.checkCode ? checkTitle({ code: diag.checkCode, message: diag.message }) : parameterErrorTitle(diag.message);
    default:
      return parameterErrorTitle(diag.message);
  }
}

function ExportSolidsDialog(props: { initial: string[]; close: () => void }) {
  const validInitial = props.initial.filter((id) => draft.parts.some((p) => p.name === id));
  const [selected, setSelected] = createSignal<string[]>(
    validInitial.length ? validInitial : draft.parts.map((p) => p.name),
  );
  let box!: HTMLDivElement;
  useModal(() => box, props.close);

  const selectedSet = createMemo(() => new Set(selected()));
  const toggle = (name: string) => {
    const next = new Set(selected());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(draft.parts.filter((p) => next.has(p.name)).map((p) => p.name));
  };

  const summary = createMemo(() => {
    const ids = selected();
    if (!ids.length) return null;
    try {
      return buildSolidTransfer(unwrap(draft), ids);
    } catch {
      return null;
    }
  });

  const confirm = async () => {
    const ids = selected();
    if (!ids.length) return;
    const allSelected = ids.length === draft.parts.length;
    const ok = await exportSolidsToFile(allSelected ? undefined : ids, ids.length === 1 ? ids[0] : undefined);
    if (ok) props.close();
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.close()}>
      <div ref={box} class="dialog parameter-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="st-export-title" tabindex="-1">
        <div class="dialog-head">
          <div>
            <h2 id="st-export-title">{t("solidTransfer.export.title")}</h2>
            <p class="muted">{t("solidTransfer.export.subtitle")}</p>
          </div>
          <button class="icon-btn" type="button" onClick={props.close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="pt-body stack">
          <Show when={draft.parts.length > 0} fallback={<p class="muted">{t("solidTransfer.export.empty")}</p>}>
            <div class="cluster">
              <button class="btn btn-sm" type="button" onClick={() => setSelected(draft.parts.map((p) => p.name))}>
                {t("solidTransfer.export.selectAll")}
              </button>
              <button class="btn btn-sm" type="button" onClick={() => setSelected([])}>
                {t("solidTransfer.export.clearSelection")}
              </button>
            </div>
            <ul class="pt-preview" style={{ "list-style": "none", "padding-left": "0" }}>
              <For each={draft.parts}>{(part) => (
                <li>
                  <label class="cluster" style={{ gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={selectedSet().has(part.name)}
                      onChange={() => toggle(part.name)}
                    />
                    <span><b>{part.label || part.name}</b> <span class="muted">({part.material})</span></span>
                  </label>
                </li>
              )}</For>
            </ul>
            <Show when={summary()} fallback={<p class="note">{t("solidTransfer.error.noSelection")}</p>}>
              {(data) => (
                <div class="stack" style={{ gap: "0.25rem" }}>
                  <p class="muted" role="status">
                    {t("solidTransfer.export.deltaSummary", {
                      solids: data().parts.length,
                      params: data().params.length,
                      materials: data().materials.length,
                    })}
                  </p>
                  <Show when={data().params.length > 0}>
                    <p class="note mono">{t("solidTransfer.import.section.params")}: {data().params.map((p) => p.key).join(", ")}</p>
                  </Show>
                  <Show when={data().materials.length > 0}>
                    <p class="note mono">{t("solidTransfer.import.section.materials")}: {data().materials.map((m) => m.name).join(", ")}</p>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </div>
        <div class="dialog-foot">
          <span class="muted" />
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.close}>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="button" disabled={!summary()} onClick={() => void confirm()}>
              {t("solidTransfer.export.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportSolidsDialog(props: { close: () => void }) {
  const [payload, setPayload] = createSignal<SolidTransferPayload | null>(null);
  const [parseDiag, setParseDiag] = createSignal<SolidTransferDiagnostic | null>(null);
  const [parseMessage, setParseMessage] = createSignal("");
  const [solidConflict, setSolidConflict] = createSignal<SolidConflictMode>("rename");
  const [updateParams, setUpdateParams] = createSignal(false);
  const [updateMaterials, setUpdateMaterials] = createSignal(false);

  let box!: HTMLDivElement;
  let chooser!: HTMLInputElement;
  useModal(() => box, props.close, () => chooser);

  const load = async (chosen?: File) => {
    if (!chosen) return;
    const owner = file()?.id;
    setParseDiag(null);
    setParseMessage("");
    setPayload(null);
    try {
      const text = await chosen.text();
      if (file()?.id !== owner) return;
      setPayload(parseSolidTransfer(text));
    } catch (e) {
      if (file()?.id !== owner) return;
      if (e instanceof SolidTransferError && e.diagnostics[0]) {
        setParseDiag(e.diagnostics[0]);
      } else {
        setParseMessage((e as Error).message);
      }
    }
  };

  const preview = createMemo<SolidTransferPreview | null>(() => {
    const p = payload();
    if (!p) return null;
    return previewSolidTransfer(p, JSON.parse(JSON.stringify(draft)) as Design, {
      solidConflict: solidConflict(),
      updateExistingParams: updateParams(),
      updateExistingMaterials: updateMaterials(),
    });
  });

  const hasChanges = createMemo(() => {
    const p = preview();
    if (!p || !p.ok) return false;
    const c = p.counts;
    return c.solidsAdded + c.solidsRenamed + c.solidsReplaced + c.paramsAdded + c.paramsUpdated + c.materialsAdded + c.materialsUpdated > 0;
  });

  const apply = () => {
    const p = payload();
    const prev = preview();
    if (!p || !prev || !prev.ok || !hasChanges()) return;
    let applied: SolidTransferPreview | null = null;
    edit((d) => {
      applied = applySolidTransfer(d, p, {
        solidConflict: solidConflict(),
        updateExistingParams: updateParams(),
        updateExistingMaterials: updateMaterials(),
      });
    }, "", t("solidTransfer.import.history"));
    if (applied) {
      const done = applied as SolidTransferPreview;
      if (done.appliedPartIndices.length > 0) {
        setSelection({ type: "part", i: done.appliedPartIndices[0] });
      }
      const count = done.counts.solidsAdded + done.counts.solidsRenamed + done.counts.solidsReplaced;
      if (count > 0) {
        setMessage({ tone: "good", text: t("solidTransfer.import.done", { count }) });
      }
    }
    props.close();
  };

  const solidStatusText = (s: SolidTransferPreview["solids"][number]) => {
    if (s.kind === "renamed") return t("solidTransfer.import.kind.renamed", { target: s.targetName });
    if (s.kind === "replaced") return t("solidTransfer.import.kind.replaced");
    if (s.kind === "error") return `${t("solidTransfer.import.kind.error")}: ${formatDiagnostic(s.diagnostic, s.message)}`;
    return t("solidTransfer.import.kind.added");
  };

  const paramStatusText = (p: SolidTransferPreview["params"][number]) => {
    if (p.kind === "kept") return `${t("solidTransfer.import.kind.kept")} (${p.existingExpression} vs ${p.expression})`;
    if (p.kind === "updated") return `${t("solidTransfer.import.kind.updated")} (${p.existingExpression} → ${p.expression})`;
    if (p.kind === "unchanged") return `${t("solidTransfer.import.kind.unchanged")} (${p.expression})`;
    if (p.kind === "error") return `${t("solidTransfer.import.kind.error")}: ${formatDiagnostic(p.diagnostic, p.message)}`;
    return `${t("solidTransfer.import.kind.added")} (${p.expression})`;
  };

  const materialStatusText = (m: SolidTransferPreview["materials"][number]) => {
    if (m.kind === "kept") return t("solidTransfer.import.kind.kept");
    if (m.kind === "updated") return t("solidTransfer.import.kind.updated");
    if (m.kind === "unchanged") return t("solidTransfer.import.kind.unchanged");
    if (m.kind === "error") return `${t("solidTransfer.import.kind.error")}: ${formatDiagnostic(m.diagnostic, m.message)}`;
    return t("solidTransfer.import.kind.added");
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.close()}>
      <div ref={box} class="dialog parameter-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="st-import-title" tabindex="-1">
        <div class="dialog-head">
          <div>
            <h2 id="st-import-title">{t("solidTransfer.import.title")}</h2>
            <p class="muted">{t("solidTransfer.import.subtitle")}</p>
          </div>
          <button class="icon-btn" type="button" onClick={props.close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="pt-body stack">
          <input
            ref={chooser}
            type="file"
            accept=".json,application/json"
            onChange={(e) => { void load(e.currentTarget.files?.[0]); }}
          />
          <Show when={parseDiag() || parseMessage()}>
            <p class="dz-bad" role="alert">{formatDiagnostic(parseDiag() ?? undefined, parseMessage())}</p>
          </Show>
          <Show when={preview()}>
            {(prev) => (
              <div class="stack" style={{ gap: "0.5rem" }}>
                <div class="cluster" style={{ "flex-wrap": "wrap", gap: "0.75rem" }}>
                  <label class="cluster" style={{ gap: "0.35rem" }}>
                    <span class="dz-label">{t("solidTransfer.import.solidConflict")}</span>
                    <select
                      class="rp-input"
                      value={solidConflict()}
                      onChange={(e) => setSolidConflict(e.currentTarget.value as SolidConflictMode)}
                    >
                      <option value="rename">{t("solidTransfer.import.solidConflict.rename")}</option>
                      <option value="replace">{t("solidTransfer.import.solidConflict.replace")}</option>
                    </select>
                  </label>
                  <label class="cluster" style={{ gap: "0.35rem" }}>
                    <input
                      type="checkbox"
                      checked={updateParams()}
                      onChange={(e) => setUpdateParams(e.currentTarget.checked)}
                    />
                    <span>{t("solidTransfer.import.updateParams")}</span>
                  </label>
                  <Show when={prev().materials.some((m) => m.kind === "kept" || m.kind === "updated")}>
                    <label class="cluster" style={{ gap: "0.35rem" }}>
                      <input
                        type="checkbox"
                        checked={updateMaterials()}
                        onChange={(e) => setUpdateMaterials(e.currentTarget.checked)}
                      />
                      <span>{t("solidTransfer.import.updateMaterials")}</span>
                    </label>
                  </Show>
                </div>

                <p class="muted" role="status">
                  {t("solidTransfer.import.summary", {
                    solidsAdded: prev().counts.solidsAdded,
                    solidsRenamed: prev().counts.solidsRenamed,
                    solidsReplaced: prev().counts.solidsReplaced,
                    paramsAdded: prev().counts.paramsAdded,
                    paramsKept: prev().counts.paramsKept,
                    paramsUpdated: prev().counts.paramsUpdated,
                    materialsAdded: prev().counts.materialsAdded,
                    errors: prev().counts.errors,
                  })}
                </p>

                <Show when={prev().solids.length > 0}>
                  <div>
                    <h3 class="dz-h">{t("solidTransfer.import.section.solids")}</h3>
                    <ul class="pt-preview">
                      <For each={prev().solids}>{(s) => (
                        <li classList={{ "dz-bad": s.kind === "error" }}>
                          <b>{s.label || s.name}</b> <span class="muted">({s.material})</span> — {solidStatusText(s)}
                        </li>
                      )}</For>
                    </ul>
                  </div>
                </Show>

                <Show when={prev().params.length > 0}>
                  <div>
                    <h3 class="dz-h">{t("solidTransfer.import.section.params")}</h3>
                    <ul class="pt-preview">
                      <For each={prev().params}>{(p) => (
                        <li classList={{ "dz-bad": p.kind === "error" }}>
                          <b class="mono">{p.key}</b> — {paramStatusText(p)}
                        </li>
                      )}</For>
                    </ul>
                  </div>
                </Show>

                <Show when={prev().materials.length > 0}>
                  <div>
                    <h3 class="dz-h">{t("solidTransfer.import.section.materials")}</h3>
                    <ul class="pt-preview">
                      <For each={prev().materials}>{(m) => (
                        <li classList={{ "dz-bad": m.kind === "error" }}>
                          <b>{m.name}</b> — {materialStatusText(m)}
                        </li>
                      )}</For>
                    </ul>
                  </div>
                </Show>

                <Show when={!prev().ok && prev().errors.some((d) => !prev().solids.some((s) => s.diagnostic === d) && !prev().params.some((p) => p.diagnostic === d) && !prev().materials.some((m) => m.diagnostic === d))}>
                  <ul class="pt-preview">
                    <For each={prev().errors.filter((d) => !prev().solids.some((s) => s.diagnostic === d) && !prev().params.some((p) => p.diagnostic === d) && !prev().materials.some((m) => m.diagnostic === d))}>
                      {(d) => <li class="dz-bad" role="alert">{formatDiagnostic(d)}</li>}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>
        </div>
        <div class="dialog-foot">
          <span class="muted">{preview() ? t("solidTransfer.import.review") : ""}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.close}>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="button" disabled={!hasChanges()} onClick={apply}>
              {t("solidTransfer.import.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SolidTransferHost() {
  createEffect(on(() => file()?.id, () => {
    closeSolidExportDialog();
    closeSolidImportDialog();
  }, { defer: true }));
  return (
    <>
      <Show when={solidExportTarget()} keyed>
        {(initial) => <ExportSolidsDialog initial={initial} close={closeSolidExportDialog} />}
      </Show>
      <Show when={solidImportOpen()}>
        <ImportSolidsDialog close={closeSolidImportDialog} />
      </Show>
    </>
  );
}
