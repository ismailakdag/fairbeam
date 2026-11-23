import { createSignal, Show, type JSX } from "solid-js";
import { Maximize2, Minimize2 } from "lucide-solid";
import { t } from "../i18n";

export const DIALOG_MARGIN_PX = 24;
export const DIALOG_MIN_WIDTH = 420;
export const DIALOG_MIN_HEIGHT = 320;

export function clampDialogSize(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  minWidth = DIALOG_MIN_WIDTH,
  minHeight = DIALOG_MIN_HEIGHT,
): { width: number; height: number } {
  const maxWidth = Math.max(240, viewportWidth - DIALOG_MARGIN_PX);
  const maxHeight = Math.max(200, viewportHeight - DIALOG_MARGIN_PX);
  return {
    width: Math.round(Math.min(maxWidth, Math.max(Math.min(minWidth, maxWidth), width))),
    height: Math.round(Math.min(maxHeight, Math.max(Math.min(minHeight, maxHeight), height))),
  };
}

export type DialogSizeController = ReturnType<typeof createDialogSize>;

export function createDialogSize(
  getBox?: () => HTMLElement | undefined,
  options?: { minWidth?: number; minHeight?: number },
) {
  const [expanded, setExpanded] = createSignal(false);
  const [size, setSize] = createSignal<{ width: number; height: number } | null>(null);
  const minWidth = options?.minWidth ?? DIALOG_MIN_WIDTH;
  const minHeight = options?.minHeight ?? DIALOG_MIN_HEIGHT;

  const clearInlineResize = () => {
    const box = getBox?.();
    if (!box) return;
    box.style.removeProperty("width");
    box.style.removeProperty("height");
  };

  const toggleExpand = () => {
    clearInlineResize();
    if (expanded()) {
      setExpanded(false);
      setSize(null);
    } else {
      setExpanded(true);
    }
  };

  const reset = () => {
    clearInlineResize();
    setExpanded(false);
    setSize(null);
  };

  const applySize = (width: number, height: number, viewportWidth?: number, viewportHeight?: number) => {
    clearInlineResize();
    const vw = viewportWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1440);
    const vh = viewportHeight ?? (typeof window !== "undefined" ? window.innerHeight : 900);
    setExpanded(false);
    setSize(clampDialogSize(width, height, vw, vh, minWidth, minHeight));
  };

  const sized = () => !expanded() && size() !== null;

  const style = (): JSX.CSSProperties | undefined => {
    if (expanded()) return undefined;
    const current = size();
    if (!current) return undefined;
    return {
      "--dialog-user-w": `${current.width}px`,
      "--dialog-user-h": `${current.height}px`,
    };
  };

  return { box: getBox, expanded, size, sized, toggleExpand, reset, applySize, style };
}

export function DialogExpandButton(props: { size: DialogSizeController }) {
  return (
    <button
      type="button"
      class="icon-btn dialog-expand"
      data-dialog-expand=""
      data-noprompt
      aria-pressed={props.size.expanded()}
      aria-label={t(props.size.expanded() ? "dialog.restore" : "dialog.expand")}
      title={t(props.size.expanded() ? "dialog.restoreTitle" : "dialog.expandTitle")}
      onClick={() => props.size.toggleExpand()}
    >
      <Show when={props.size.expanded()} fallback={<Maximize2 size={15} aria-hidden="true" />}>
        <Minimize2 size={15} aria-hidden="true" />
      </Show>
    </button>
  );
}

export function DialogResizeGrip(props: { size: DialogSizeController }) {
  let grip!: HTMLDivElement;
  let drag: { id: number; x: number; y: number; width: number; height: number; xFactor: number; yFactor: number } | undefined;

  return (
    <div
      ref={grip}
      class="dialog-resize-grip"
      data-dialog-resize=""
      data-noprompt
      aria-hidden="true"
      title={t("dialog.resizeTitle")}
      onDblClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.size.reset();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const box = props.size.box?.();
        if (!box) return;
        e.stopPropagation();
        grip.setPointerCapture(e.pointerId);
        const rect = box.getBoundingClientRect();
        const parent = box.parentElement?.getBoundingClientRect();
        const centeredX = parent ? Math.abs((rect.left + rect.right) - (parent.left + parent.right)) < 12 : true;
        const centeredY = parent ? Math.abs((rect.top + rect.bottom) - (parent.top + parent.bottom)) < 12 : true;
        drag = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          width: rect.width,
          height: rect.height,
          xFactor: centeredX ? 2 : 1,
          yFactor: centeredY ? 2 : 1,
        };
      }}
      onPointerMove={(e) => {
        if (!drag || drag.id !== e.pointerId) return;
        const nextW = drag.width + (e.clientX - drag.x) * drag.xFactor;
        const nextH = drag.height + (e.clientY - drag.y) * drag.yFactor;
        props.size.applySize(nextW, nextH);
      }}
      onPointerUp={(e) => {
        if (drag?.id === e.pointerId) {
          drag = undefined;
          grip.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => { drag = undefined; }}
      onLostPointerCapture={() => { drag = undefined; }}
    />
  );
}
