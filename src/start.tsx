import { render } from "solid-js/web";
import "./styles/fonts.css";
import "../design-system/tokens.css";
import "./styles/app.css";
import "./styles/runner.css";
import "./styles/drawing.css";
import "./styles/array.css";
import "./styles/import.css";
import "./styles/compare.css";
import "./styles/editor.css";
import "./styles/optimize.css";
import "./styles/designer.css";
import "./styles/render.css";
import App from "./App";
import "./styles/scaling.css";
import { applyTheme, theme } from "./state";
import { health, recheckServer, serverState } from "./runner/store";
import { dirty } from "./designer/store";
import { installChunkReloadGuard } from "./lib/chunkReload";
import { installReloadGuard } from "./lib/reloadGuard";
import { applyAppearance, watchAppearanceTheme } from "./lib/appearance";
import { readGeneralSettings } from "./lib/generalSettings";

applyTheme(theme());
applyAppearance(readGeneralSettings());
watchAppearanceTheme();
installReloadGuard(() => !!health()?.desktop || "__TAURI_INTERNALS__" in window, () => dirty());
// The WebView's own menu (Back, Reload, Inspect) means nothing in the app. Keep it only where it
// helps: text fields (cut/copy/paste) and selected text. Our own menus call preventDefault first.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
  if (String(getSelection() ?? "").trim()) return;
  e.preventDefault();
});
// A lazy chunk that is gone (the app files were replaced while it ran, e.g. by an update) cannot be
// imported again: reload once only after verifying the origin answers, never into a dead server.
installChunkReloadGuard(window, {
  dirty: () => dirty(),
  isOffline: () => serverState() === "offline",
  onUnreachable: () => { void recheckServer(); },
});
render(() => <App />, document.getElementById("root")!);
