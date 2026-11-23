// Resizable and expandable configuration dialogs + viewport-proportional panel/dock bounds (#9).
// Pure Node check (Vite + Solid reactive signals + CSS/JSX/i18n contracts), no solver or browser.
//
//   node scripts/check-dialog-resize.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const read = (p) => readFileSync(`${root}${p}`, "utf8");

const modules = [
  "components/DialogSize.tsx",
  "components/PanelResizeHandles.tsx",
  "components/DockResizeHandle.tsx",
];
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] }, css: { postcss: {} },
  plugins: [solid(), {
    name: "dialog-resize-entry",
    resolveId(id) { if (id.endsWith("dialog-resize-entry")) return "\0dialog-resize-entry"; },
    load(id) {
      if (id !== "\0dialog-resize-entry") return;
      return modules.map((path, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${path}`)};`).join("\n");
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: "dialog-resize-entry", formats: ["es"] } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((o) => o.type === "chunk");
const stub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, querySelector: () => null };
globalThis.window = { ...stub, innerWidth: 2560, innerHeight: 1440, document: stub };
globalThis.document = stub;
const { m0: dialogSize, m1: panelResize, m2: dockResize } =
  await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);

// ---- 1. DialogSize reactive controller & clamping
{
  const { DIALOG_MARGIN_PX, DIALOG_MIN_WIDTH, DIALOG_MIN_HEIGHT, clampDialogSize, createDialogSize } = dialogSize;
  assert.equal(DIALOG_MARGIN_PX, 24);
  assert.deepEqual(clampDialogSize(200, 150, 1920, 1080), { width: DIALOG_MIN_WIDTH, height: DIALOG_MIN_HEIGHT }, "clamps to sensible minimum dimensions");
  assert.deepEqual(clampDialogSize(5000, 4000, 2560, 1440), { width: 2536, height: 1416 }, "allows resizing up to calc(100vw - 24px) by calc(100vh - 24px) on QHD/4K");
  assert.deepEqual(clampDialogSize(980.4, 740.6, 1440, 900), { width: 980, height: 741 }, "rounds pixel sizes cleanly");

  const removed = [];
  const fakeBox = { style: { removeProperty: (name) => removed.push(name) } };
  const ctl = createDialogSize(() => fakeBox);
  assert.equal(ctl.expanded(), false);
  assert.equal(ctl.sized(), false);
  assert.equal(ctl.size(), null);
  assert.equal(ctl.style(), undefined);

  ctl.toggleExpand();
  assert.equal(ctl.expanded(), true, "Expand activates expanded state");
  assert.equal(ctl.sized(), false);
  assert.equal(ctl.style(), undefined, "expanded state delegates dimensions to CSS min(96vw, 1440px) / 90dvh");
  assert.deepEqual(removed.splice(0), ["width", "height"], "clears any native inline width/height when expanding");

  ctl.toggleExpand();
  assert.equal(ctl.expanded(), false, "Restore returns from expanded state");
  assert.equal(ctl.sized(), false);
  assert.equal(ctl.size(), null, "Restore returns to default dialog size");

  ctl.applySize(1800, 1100, 2560, 1440);
  assert.equal(ctl.expanded(), false);
  assert.equal(ctl.sized(), true);
  assert.deepEqual(ctl.size(), { width: 1800, height: 1100 });
  assert.deepEqual(ctl.style(), { "--dialog-user-w": "1800px", "--dialog-user-h": "1100px" });

  // Expanding after a manual drag switches cleanly to expanded mode, and restoring goes back to default
  ctl.toggleExpand();
  assert.equal(ctl.expanded(), true);
  assert.equal(ctl.sized(), false);
  assert.equal(ctl.style(), undefined);
  ctl.toggleExpand();
  assert.equal(ctl.expanded(), false);
  assert.equal(ctl.sized(), false);

  // Dragging from expanded mode transitions smoothly into custom user size (e.g. > 1440px on 4K)
  ctl.toggleExpand();
  ctl.applySize(2400, 1600, 3840, 2160);
  assert.equal(ctl.expanded(), false);
  assert.equal(ctl.sized(), true);
  assert.deepEqual(ctl.size(), { width: 2400, height: 1600 });

  ctl.reset();
  assert.equal(ctl.expanded(), false);
  assert.equal(ctl.sized(), false);
  assert.equal(ctl.size(), null);
}

// ---- 2. Panel & Dock viewport-proportional upper bounds
{
  const { MIN_PANEL_WIDTH, MIN_CENTER_WIDTH, MAX_PANEL_SHARE, panelMaxWidth } = panelResize;
  assert.equal(MIN_PANEL_WIDTH, 180);
  assert.equal(MIN_CENTER_WIDTH, 420);
  assert.equal(MAX_PANEL_SHARE, 0.65);

  assert.equal(panelMaxWidth(1440, 240), 780, "1440px viewport allows 780px (> old 600px cap) while keeping 420px center");
  assert.equal(panelMaxWidth(1440, 26), 936, "with collapsed neighbor strip (26px), reaches 65% of 1440px (936px)");
  assert.equal(panelMaxWidth(2560, 260), 1664, "QHD 2560px viewport reaches 65% (1664px) instead of hardcoded 600px");
  assert.equal(panelMaxWidth(3840, 260), 2496, "4K 3840px viewport reaches 65% (2496px)");
  assert.equal(panelMaxWidth(1440, 732), 288, "when opposite panel took 732px on 1440px, caps at 288px so 420px 3D center remains");
  assert.equal(panelMaxWidth(600, 240), MIN_PANEL_WIDTH, "never drops below minimum panel width");

  assert.equal(dockResize.MIN_VIEW_ABOVE, 320, "dock keeps MIN_VIEW_ABOVE = 320px for the 3D view / plot above");
  assert.match(read("src/components/DockResizeHandle.tsx"), /Math\.min\(Math\.floor\(center\.clientHeight \* 0\.8\), Math\.floor\(room - MIN_VIEW_ABOVE\)\)/,
    "dock allows up to 80% of center height on tall monitors while preserving MIN_VIEW_ABOVE");
}

// ---- 3. Configuration & Designer modals wire DialogExpandButton, DialogResizeGrip, and .dialog-resizable
{
  const expandableDialogs = [
    "src/designer/SimSettingsDialog.tsx",
    "src/designer/ConvergenceDialog.tsx",
    "src/designer/SweepDialog.tsx",
    "src/designer/OptimizeDialog.tsx",
    "src/designer/RunDialog.tsx",
    "src/designer/MaterialLibrary.tsx",
    "src/designer/UserMaterialsDialog.tsx",
    "src/designer/HistoryDialog.tsx",
    "src/designer/ResearchDialog.tsx",
    "src/designer/ParametersDock.tsx",
    "src/designer/dialogs/ShapeDialog.tsx",
    "src/designer/FeedCreationDialog.tsx",
    "src/designer/ContextMenu.tsx",
    "src/components/ExportDialog.tsx",
    "src/components/PackageDialog.tsx",
    "src/render/RenderDialog.tsx",
    "src/components/PcbImportDialog.tsx",
    "src/components/CstImportDialog.tsx",
  ];
  for (const path of expandableDialogs) {
    const src = read(path);
    assert.match(src, /dialog-resizable/, `${path} enables .dialog-resizable`);
    assert.match(src, /<DialogExpandButton size=\{/, `${path} includes header Expand/Restore button`);
    assert.match(src, /<DialogResizeGrip size=\{/, `${path} includes pointer resize grip`);
    assert.match(src, /data-dialog-expanded=/, `${path} binds data-dialog-expanded`);
    assert.match(src, /data-dialog-sized=/, `${path} binds data-dialog-sized`);
  }
  const gs = read("src/components/GeneralSettings.tsx");
  assert.match(gs, /dialog-resizable/, "GeneralSettings supports dynamic resizing");
  assert.match(gs, /<DialogResizeGrip size=\{/, "GeneralSettings includes resize grip");
}

// ---- 4. CSS contracts: expanded dimensions, dynamic bounds, and responsive Mesh / Simulation grids
{
  const appCss = read("src/styles/app.css");
  assert.match(appCss, /\.dialog-resize-grip[\s\S]*?cursor:\s*nwse-resize/, "resizable dialogs expose a pointer resize handle");
  assert.match(appCss, /max-width:\s*min\(100%,\s*calc\(100vw - 24px\)\)/, "max-width uses calc(100vw - 24px)");
  assert.match(appCss, /max-height:\s*min\(100%,\s*calc\(100dvh - 24px\)\)/, "max-height uses calc(100dvh - 24px)");
  assert.match(appCss, /\.scrim \.dialog\.dialog-resizable\[data-dialog-expanded="true"\][\s\S]*?width:\s*min\(96vw,\s*1440px,\s*calc\(100vw - 24px\)\)[\s\S]*?height:\s*min\(90dvh,\s*calc\(100dvh - 24px\)\)/,
    "expanded dialog uses min(96vw, 1440px) width and 90dvh height");

  const simCss = read("src/styles/designer-sim.css");
  assert.match(simCss, /container:\s*ss-pane\s*\/\s*inline-size/, "Simulation/Mesh pane is a size container");
  assert.match(simCss, /@container ss-pane \(min-width: 680px\)[\s\S]*?\.ss-auto-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}[\s\S]*?\.ss-region-bounds \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    "Mesh overrides and Local Mesh Region start/stop vectors expand to multi-column grids when widened");
  assert.match(simCss, /@container ss-pane \(min-width: 1040px\)[\s\S]*?\.ss-auto-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/,
    "Mesh overrides expand to 3 columns on large expanded dialogs");
  assert.match(read("src/designer/SimSettingsDialog.tsx"), /<div class="ss-auto-grid">/, "SimSettingsDialog wraps mesh overrides in .ss-auto-grid");
  assert.match(read("src/designer/LocalMeshRegionsEditor.tsx"), /<div class="ss-region-bounds">/, "LocalMeshRegionsEditor wraps start/stop vectors in .ss-region-bounds");

  assert.match(read("src/styles/sweep-dialog.css"), /\.sd-dialog:is\(\[data-dialog-sized="true"\], \[data-dialog-expanded="true"\], \[style\*="height"\]\) > \.sd-body \{ max-height: none; \}/,
    "Sweep dialog body uncaps its 680px max-height when expanded or resized");
  assert.match(read("src/styles/convergence.css"), /\.cv-dialog:is\(\[data-dialog-sized="true"\], \[data-dialog-expanded="true"\], \[style\*="height"\]\) > \.cv-body \{ max-height: none; \}/,
    "Mesh convergence dialog body uncaps its 720px max-height when expanded or resized");
}

// ---- 5. i18n glossary compliance (EN & TR)
{
  const en = JSON.parse(read("src/i18n/en.json"));
  const tr = JSON.parse(read("src/i18n/tr.json"));
  for (const key of ["dialog.expand", "dialog.expandTitle", "dialog.restore", "dialog.restoreTitle", "dialog.resizeTitle"]) {
    assert.ok(typeof en[key] === "string" && en[key].length > 0, `en.json has ${key}`);
    assert.ok(typeof tr[key] === "string" && tr[key].length > 0, `tr.json has ${key}`);
    assert.doesNotMatch(tr[key], /\b3D\b/, `${key} in TR never uses 3D`);
    assert.doesNotMatch(tr[key], /denetim/i, `${key} in TR reserves denetim for Checks`);
  }
}

console.log("Dialog & panel resize checks passed: Expand/Restore toggle, dynamic clamping up to full viewport, QHD/4K panel & dock bounds, and multi-column Mesh/Local-mesh responsiveness.");
