import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../i18n";

export const MIN_PANEL_WIDTH = 180;
export const MIN_CENTER_WIDTH = 420;
export const MAX_PANEL_SHARE = 0.65;

/** Upper bound for a side panel: up to 65 % of the workspace while keeping MIN_CENTER_WIDTH for the 3D view / dock. */
export function panelMaxWidth(workspaceWidth: number, otherWidth: number, minimum = MIN_PANEL_WIDTH): number {
  const byShare = Math.floor(workspaceWidth * MAX_PANEL_SHARE);
  const byRoom = Math.floor(workspaceWidth - Math.max(0, otherWidth) - MIN_CENTER_WIDTH);
  return Math.max(minimum, Math.min(byShare, byRoom));
}

/** Edge separators write the same variables as responsive layout defaults. */
export default function PanelResizeHandles() {
  return <><PanelHandle side="left" /><PanelHandle side="right" /></>;
}
function PanelHandle(props: { side: "left" | "right" }) {
  let handle!: HTMLDivElement;
  let workspace!: HTMLElement;
  let requested: number | undefined;
  let drag: { id: number; x: number; width: number } | undefined;
  const [width, setWidth] = createSignal(0);
  const [maximum, setMaximum] = createSignal(480);
  const minimum = MIN_PANEL_WIDTH;
  const otherSide = props.side === "left" ? "right" : "left";
  const variable = `--scaling-${props.side}`;
  const otherVariable = `--scaling-${otherSide}`;
  const key = `fairbeam.panel-${props.side}-width`;
  const panel = () => workspace.querySelector<HTMLElement>(`:scope > .panel-${props.side}`);
  const otherPanel = () => workspace.querySelector<HTMLElement>(`:scope > .panel-${otherSide}`);
  const otherStrip = () => workspace.querySelector<HTMLElement>(`:scope > .dw-strip-${otherSide}`);
  const otherWidth = (forWindowResize = false) => {
    const other = otherPanel();
    if (!other || getComputedStyle(other).display === "none") {
      const strip = otherStrip();
      return strip && getComputedStyle(strip).display !== "none" ? Math.round(strip.getBoundingClientRect().width) : 0;
    }
    const domWidth = Math.round(other.getBoundingClientRect().width);
    if (!forWindowResize || requested === undefined) return domWidth;
    const otherInline = parseFloat(workspace.style.getPropertyValue(otherVariable));
    if (Number.isFinite(otherInline) && requested + otherInline > workspace.clientWidth - MIN_CENTER_WIDTH) {
      return Math.min(otherInline, Math.floor((workspace.clientWidth - MIN_CENTER_WIDTH) / 2));
    }
    return domWidth;
  };
  const refreshMax = (forWindowResize = false) => {
    const nextMax = panelMaxWidth(workspace.clientWidth, otherWidth(forWindowResize), minimum);
    setMaximum(nextMax);
    return nextMax;
  };
  const apply = (value: number, remember = true, notify = true) => {
    requested = value;
    const max = refreshMax(!notify);
    const next = Math.round(Math.max(minimum, Math.min(max, value)));
    workspace.style.setProperty(variable, `${next}px`);
    setWidth(next);
    if (remember) try { localStorage.setItem(key, String(next)); } catch { /* Optional storage. */ }
    if (notify) window.dispatchEvent(new CustomEvent("fairbeam:panel-resize", { detail: props.side }));
  };
  const reset = (notify = true) => {
    requested = undefined; workspace.style.removeProperty(variable);
    requestAnimationFrame(() => {
      refreshMax(false);
      setWidth(Math.round(panel()?.getBoundingClientRect().width ?? 0));
      if (notify) window.dispatchEvent(new CustomEvent("fairbeam:panel-resize", { detail: props.side }));
    });
    try { localStorage.removeItem(key); } catch { /* Optional storage. */ }
  };
  onMount(() => {
    workspace = handle.parentElement!;
    try { const saved = Number(localStorage.getItem(key)); if (Number.isFinite(saved) && saved >= minimum) requested = saved; } catch { /* Responsive defaults. */ }
    const measure = () => {
      refreshMax(true);
      if (requested !== undefined) apply(requested, false, false);
      else setWidth(Math.round(panel()?.getBoundingClientRect().width ?? 0));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(workspace);
    const mutations = new MutationObserver(measure); mutations.observe(workspace, { attributes: true, attributeFilter: ["class"] });
    const resetLayoutEvent = () => reset(false);
    const siblingResizeEvent = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== props.side) refreshMax(false);
    };
    window.addEventListener("fairbeam:reset-layout", resetLayoutEvent);
    window.addEventListener("fairbeam:panel-resize", siblingResizeEvent);
    onCleanup(() => {
      observer.disconnect(); mutations.disconnect();
      window.removeEventListener("fairbeam:reset-layout", resetLayoutEvent);
      window.removeEventListener("fairbeam:panel-resize", siblingResizeEvent);
    });
  });
  return <div ref={handle} class={`panel-resize panel-resize-${props.side}`} role="separator" tabindex={0}
    aria-label={t(props.side === "left" ? "resize.panel.left" : "resize.panel.right")} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum()} aria-valuenow={width()}
    title={t("resize.panel.title")}
    onDblClick={() => reset(true)}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
      refreshMax(false);
      drag = { id: e.pointerId, x: e.clientX, width: panel()?.getBoundingClientRect().width ?? width() };
    }}
    onPointerMove={(e) => { if (drag?.id === e.pointerId) apply(drag.width + (e.clientX - drag.x) * (props.side === "left" ? 1 : -1)); }}
    onPointerUp={(e) => { if (drag?.id === e.pointerId) { drag = undefined; handle.releasePointerCapture(e.pointerId); } }}
    onPointerCancel={() => { drag = undefined; }} onLostPointerCapture={() => { drag = undefined; }}
    onKeyDown={(e) => {
      refreshMax(false);
      const step = e.shiftKey ? 50 : 10;
      const sign = props.side === "left" ? 1 : -1;
      const current = panel()?.getBoundingClientRect().width ?? width();
      const next = e.key === "ArrowRight" ? current + step * sign : e.key === "ArrowLeft" ? current - step * sign
        : e.key === "ArrowUp" ? current + step : e.key === "ArrowDown" ? current - step
        : e.key === "Home" ? minimum : e.key === "End" ? maximum() : null;
      if (next === null) return;
      e.preventDefault(); e.stopPropagation(); apply(next);
    }} />;
}
