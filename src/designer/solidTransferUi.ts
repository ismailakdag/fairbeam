import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { suggestDesignId } from "../lib/designId";
import { downloadFailedMessage, downloadMessage, saveDownload } from "../lib/download";
import { exportSolidsJson } from "./solidTransfer";
import { draft, file, selection, setMessage } from "./store";

export const [solidExportTarget, setSolidExportTarget] = createSignal<string[] | null>(null);
export const [solidImportOpen, setSolidImportOpen] = createSignal(false);

export function openSolidExportDialog(initialIds?: string[]) {
  if (initialIds) {
    setSolidExportTarget([...initialIds]);
    return;
  }
  const s = selection();
  if ((s.type === "part" || s.type === "primitive") && draft.parts[s.i]) {
    setSolidExportTarget([draft.parts[s.i].name]);
    return;
  }
  setSolidExportTarget(draft.parts.map((p) => p.name));
}

export function closeSolidExportDialog() {
  setSolidExportTarget(null);
}

export function openSolidImportDialog() {
  setSolidImportOpen(true);
}

export function closeSolidImportDialog() {
  setSolidImportOpen(false);
}

export async function exportSolidsToFile(selectedIds?: string[], baseHint?: string): Promise<boolean> {
  const hint = baseHint
    || (selectedIds?.length === 1 ? (draft.parts.find((p) => p.name === selectedIds[0])?.label || selectedIds[0]) : "")
    || draft.model?.name
    || file()?.id
    || "solids";
  const slug = suggestDesignId(hint) || "solids";
  const name = `${slug}.solids.json`;
  try {
    const content = exportSolidsJson(unwrap(draft), selectedIds);
    const result = await saveDownload(name, content, "application/json;charset=utf-8");
    if (result.status !== "cancelled") {
      setMessage({
        tone: result.status === "failed" ? "critical" : "good",
        text: downloadMessage(result),
      });
    }
    return result.status !== "failed" && result.status !== "cancelled";
  } catch (error) {
    setMessage({ tone: "critical", text: downloadFailedMessage(name, error) });
    return false;
  }
}
