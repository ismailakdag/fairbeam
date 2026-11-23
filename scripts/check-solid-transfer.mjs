import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const read = (p) => readFileSync(`${root}${p}`, "utf8");

const built = await build({
  root,
  configFile: false,
  logLevel: "silent",
  resolve: { conditions: ["browser"] },
  plugins: [{
    name: "solid-transfer-check-entry",
    resolveId(id) { if (id.endsWith("solid-transfer-check-entry")) return "\0solid-transfer-check-entry"; },
    load(id) {
      if (id === "\0solid-transfer-check-entry") {
        return [
          "designer/checks",
          "designer/expr",
          "i18n/index",
          "designer/solidTransfer",
          "designer/sessionCore",
        ].map((p, i) => `export * as m${i} from ${JSON.stringify(`${root}src/${p}.ts`)};`).join("\n");
      }
    },
  }],
  build: { write: false, minify: false, lib: { entry: "solid-transfer-check-entry", formats: ["es"] } },
});
const bundleCode = (Array.isArray(built) ? built[0] : built).output[0].code;
const {
  m0: { designChecks },
  m1: { paramValues },
  m2: { setLanguage },
  m3: {
    applySolidTransfer,
    buildSolidTransfer,
    exportSolidsJson,
    orderParamsByDependency,
    parseSolidTransfer,
    previewSolidTransfer,
    SOLID_TRANSFER_LIMIT,
    SOLID_TRANSFER_SCHEMA,
  },
  m4: { createDesignerSession },
} = await import(`data:text/javascript;base64,${Buffer.from(bundleCode).toString("base64")}`);

// ---- 1. Targeted single-solid delta export with transitive parameter & custom material closure
const sourceDesign = {
  schema: "fairbeam.design/1",
  model: { id: "source_ant", name: "Source antenna" },
  params: [
    { key: "f0", default: 2.45, unit: "GHz", label: "Design frequency" },
    { key: "P_unused", default: 99, unit: "mm", description: "unrelated parameter" },
    { key: "W", default: 30, unit: "mm", min: 10, max: 80, label: "Substrate width" },
    { key: "H", expr: "W / 2", unit: "mm", description: "half width" },
    { key: "Z_top", expr: "H / 10 + 0.5", unit: "mm" },
    { key: "er_base", default: 3.38 },
    { key: "er_eff", expr: "er_base * 1.05" },
  ],
  simulation: { f_min: "f0 * 0.8", f_max: "f0 * 1.2", boundaries: "MUR", end_criteria_db: -50 },
  materials: [
    { name: "copper", kind: "metal", library: "pec" },
    { name: "custom_sub", kind: "dielectric", eps_r: "er_eff", tan_d: 0.0027, tan_d_freq: 2.45, color: "#4a8f6d" },
    { name: "unused_radome", kind: "dielectric", eps_r: 2.1, tan_d: 0.0002 },
  ],
  parts: [
    {
      name: "ground",
      label: "Ground plane",
      material: "copper",
      primitives: [{ kind: "box", start: [-40, -40, 0], stop: [40, 40, 0] }],
    },
    {
      name: "substrate",
      label: "Main substrate",
      component: "board/core",
      material: "custom_sub",
      primitives: [{ kind: "box", start: ["-W/2", "-W/2", 0], stop: ["W/2", "W/2", "Z_top"] }],
    },
    {
      name: "patch",
      label: "Radiating patch",
      component: "antenna",
      material: "copper",
      primitives: [{ kind: "box", start: [-12, -10, "Z_top"], stop: [12, 10, "Z_top"] }],
    },
  ],
  ports: [{ type: "lumped", number: 1, R: 50, start: [4, 0, 0], stop: [4, 0, "Z_top"], direction: "z" }],
  resistors: [],
  mesh: { mode: "auto", cells_per_wavelength: 20 },
  far_field: { enabled: true, frequencies: ["f0"] },
};

const sourceSnapshot = JSON.stringify(sourceDesign);
assert.deepEqual(
  designChecks(sourceDesign).filter((c) => c.severity === "error"),
  [],
  "source fixture passes designChecks cleanly",
);

// Export under Turkish locale as well: exported numbers must still keep decimal points.
setLanguage("tr");
const targetedJson = exportSolidsJson(sourceDesign, ["substrate"]);
setLanguage("en");
assert.equal(JSON.stringify(sourceDesign), sourceSnapshot, "exportSolidsJson never mutates source design");
assert.match(targetedJson, /3\.38/, "exported JSON numbers always keep a decimal point");
assert.match(targetedJson, /0\.0027/, "exported dielectric loss tangent keeps a decimal point");
assert.equal(exportSolidsJson(sourceDesign, new Set(["substrate"])), targetedJson, "Set<string> selection matches array selection");

const targeted = parseSolidTransfer(targetedJson);
assert.equal(targeted.schema, SOLID_TRANSFER_SCHEMA);
assert.equal(targeted.units, "mm/GHz");
assert.deepEqual(targeted.parts.map((p) => p.name), ["substrate"], "only targeted solid is exported");
assert.equal(targeted.parts[0].component, "board/core", "component folder path is preserved on exported solid");
assert.deepEqual(targeted.materials.map((m) => m.name), ["custom_sub"], "only referenced custom material is exported");
assert.deepEqual(
  targeted.params.map((p) => p.key),
  ["W", "H", "Z_top", "er_base", "er_eff"],
  "transitive parameter closure W -> H -> Z_top and er_base -> er_eff is extracted in dependency order, excluding f0 and P_unused",
);

// Out-of-order source params are topologically ordered on export so derived expressions always resolve.
{
  const outOfOrder = structuredClone(sourceDesign);
  outOfOrder.params = [
    { key: "H", expr: "W / 2", unit: "mm" },
    { key: "W", default: 30, unit: "mm" },
  ];
  outOfOrder.materials = [{ name: "copper", kind: "metal" }];
  outOfOrder.parts = [{ name: "bar", material: "copper", primitives: [{ kind: "box", start: [0, 0, 0], stop: [10, 10, "H"] }] }];
  const exported = parseSolidTransfer(exportSolidsJson(outOfOrder, ["bar"]));
  assert.deepEqual(exported.params.map((p) => p.key), ["W", "H"], "dependency order puts W before H");
  assert.deepEqual(Object.keys(paramValues(exported.params).errors), [], "ordered params evaluate with zero errors");
  assert.deepEqual(orderParamsByDependency(outOfOrder.params).map((p) => p.key), ["W", "H"]);
}

// Boolean history operand parameters are also captured in transitive closure.
{
  const withBool = structuredClone(sourceDesign);
  withBool.params.push({ key: "slot_base", default: 4 }, { key: "slot_w", expr: "slot_base / 2" });
  withBool.parts.push({
    name: "slotted",
    material: "copper",
    primitives: [{ kind: "box", start: [-10, -10, 0], stop: [10, 10, 1] }],
    booleanHistory: {
      operation: "subtract",
      live: true,
      A: { name: "slotted", material: "copper", primitives: [{ kind: "box", start: [-10, -10, 0], stop: [10, 10, 1] }] },
      B: { name: "cutter", material: "copper", primitives: [{ kind: "box", start: ["-slot_w", -2, 0], stop: ["slot_w", 2, 1] }] },
    },
  });
  const delta = buildSolidTransfer(withBool, ["slotted"]);
  assert.deepEqual(delta.params.map((p) => p.key), ["slot_base", "slot_w"], "Boolean operand parameter chain is included");
}

// ---- 2. Full solids export round-trip
const fullJson = exportSolidsJson(sourceDesign);
const fullPayload = parseSolidTransfer(fullJson);
assert.equal(exportSolidsJson(sourceDesign, ["ground", "substrate", "patch"]), fullJson, "explicitly selecting all solids matches omitted selection");
assert.deepEqual(fullPayload.parts.map((p) => p.name), ["ground", "substrate", "patch"]);
assert.deepEqual(fullPayload.materials.map((m) => m.name), ["copper", "custom_sub"], "unused_radome is excluded even in full export");
assert.ok(!fullPayload.params.some((p) => p.key === "P_unused"), "P_unused is excluded");

const emptyDest = {
  schema: "fairbeam.design/1",
  model: { id: "dest_ant", name: "Destination antenna" },
  params: [{ key: "f0", default: 2.45, unit: "GHz" }],
  simulation: { f_min: "f0 * 0.8", f_max: "f0 * 1.2", boundaries: "MUR", end_criteria_db: -50 },
  materials: [{ name: "copper", kind: "metal", library: "pec" }],
  parts: [],
  ports: [{ type: "lumped", number: 1, R: 50, start: [4, 0, 0], stop: [4, 0, 2], direction: "z" }],
  resistors: [],
  mesh: { mode: "auto", cells_per_wavelength: 20 },
  far_field: { enabled: false },
};
{
  const dest = structuredClone(emptyDest);
  const preview = previewSolidTransfer(fullPayload, dest);
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.solidsAdded, 3);
  assert.equal(preview.counts.materialsAdded, 1, "custom_sub added, copper recognized as unchanged");
  assert.equal(preview.counts.materialsUnchanged, 1);
  assert.equal(preview.counts.paramsAdded, 5);
  const applied = applySolidTransfer(dest, fullPayload);
  assert.equal(applied.ok, true);
  assert.deepEqual(dest.parts, sourceDesign.parts);
  assert.deepEqual(
    designChecks(dest).filter((c) => c.severity === "error"),
    [],
    "round-tripped destination passes designChecks cleanly",
  );
}

// ---- 3. UTF-8 BOM handling & malformed JSON / unknown schema / invalid expression / missing material rejection
assert.deepEqual(parseSolidTransfer("\uFEFF" + targetedJson), targeted, "UTF-8 BOM is stripped cleanly");

for (const badText of [
  "",
  "{bad json",
  "null",
  "[]",
  "42",
  " ".repeat(SOLID_TRANSFER_LIMIT + 10),
  JSON.stringify({ schema: "fairbeam.solid-transfer/2", params: [], materials: [], parts: [] }),
  JSON.stringify({ schema: "fairbeam.design/1", params: [], materials: [], parts: [] }),
  JSON.stringify({ params: [], materials: [], parts: [] }),
  JSON.stringify({ schema: SOLID_TRANSFER_SCHEMA, units: "m/Hz", params: [], materials: [], parts: [] }),
  JSON.stringify({ schema: SOLID_TRANSFER_SCHEMA, unknownTopKey: 1, params: [], materials: [], parts: [] }),
  JSON.stringify({ schema: SOLID_TRANSFER_SCHEMA, params: "bad", materials: [], parts: [] }),
  JSON.stringify({ schema: SOLID_TRANSFER_SCHEMA, params: [], materials: [], parts: null }),
  `{"schema":"${SOLID_TRANSFER_SCHEMA}","__proto__":{"polluted":true},"params":[],"materials":[],"parts":[]}`,
]) {
  assert.throws(() => parseSolidTransfer(badText), "invalid transfer text is rejected by parseSolidTransfer");
}
assert.equal(({}).polluted, undefined, "prototype is never polluted");

assert.throws(() => exportSolidsJson(sourceDesign, []), /at least one solid/i);
assert.throws(() => exportSolidsJson(sourceDesign, ["does_not_exist"]), /Unknown solid/i);

const assertRejected = (mutate, label) => {
  const dest = structuredClone(emptyDest);
  const destBefore = JSON.stringify(dest);
  const broken = structuredClone(targeted);
  mutate(broken);
  const prev = previewSolidTransfer(broken, dest);
  assert.equal(prev.ok, false, `preview rejects: ${label}`);
  assert.ok(prev.errors.length > 0, `preview reports diagnostic for: ${label}`);
  assert.throws(() => applySolidTransfer(dest, broken), `apply throws for: ${label}`);
  assert.equal(JSON.stringify(dest), destBefore, `destination is untouched on failure: ${label}`);
};

assertRejected((x) => { x.materials = []; }, "missing custom material");
assertRejected((x) => { x.parts[0].material = "ghost_mat"; }, "unknown material reference");
assertRejected((x) => { x.params[0].key = "bad-key"; }, "invalid parameter key");
assertRejected((x) => { x.params[0].key = "for"; }, "Python keyword parameter key");
assertRejected((x) => { x.params.push({ ...x.params[0] }); }, "duplicate parameter key in file");
assertRejected((x) => { x.params[1].expr = "UnknownVar / 2"; }, "unknown parameter in derived expression");
assertRejected((x) => { x.params[1].expr = "0x10"; }, "hex literal in expression");
assertRejected((x) => { x.params[1].expr = "1 / 0"; }, "division by zero in parameter expression");
assertRejected((x) => { x.parts[0].primitives[0].stop = ["UnknownDim", 10, 2]; }, "unknown parameter in solid geometry");
assertRejected((x) => { x.parts[0].primitives[0].stop = ["1 + * 2", 10, 2]; }, "syntax error in solid geometry");
assertRejected((x) => { x.parts[0].primitives[0] = { kind: "box", start: [10, 0, 0], stop: [-10, 5, 5] }; }, "inverted brick bounds");
assertRejected((x) => { x.parts[0].primitives[0] = { kind: "box", start: [0, 0, 0], stop: [0, 0, 5] }; }, "zero-area flat brick");
assertRejected((x) => { x.parts[0].primitives[0] = { kind: "pyramid", start: [0, 0, 0], stop: [1, 1, 1] }; }, "unsupported primitive kind");
assertRejected((x) => { x.parts[0].name = "fairbeam_helper"; }, "reserved solid name prefix");
assertRejected((x) => { x.parts.push(structuredClone(x.parts[0])); }, "duplicate solid name in import");
assertRejected((x) => { x.parts[0].component = "board//core"; }, "empty segment in component path");
assertRejected((x) => { x.materials[0].eps_r = 0.5; }, "dielectric eps_r < 1");

// ---- 4. Conflict handling: solid rename vs replace, parameter preservation vs update, and clean lint
{
  const baseDest = {
    schema: "fairbeam.design/1",
    model: { id: "conflict_dest", name: "Conflict destination" },
    params: [
      { key: "f0", default: 2.45, unit: "GHz" },
      { key: "W", default: 44, unit: "mm", min: 20, max: 60, label: "Existing width" },
    ],
    simulation: { f_min: 1.5, f_max: 3.5, boundaries: "MUR", end_criteria_db: -50 },
    materials: [{ name: "copper", kind: "metal", library: "pec" }],
    parts: [
      { name: "ground", material: "copper", primitives: [{ kind: "box", start: [-50, -50, 0], stop: [50, 50, 0] }] },
      { name: "substrate", label: "Main substrate", material: "copper", primitives: [{ kind: "box", start: [-5, -5, 1], stop: [5, 5, 2] }] },
    ],
    ports: [{ type: "lumped", number: 1, R: 50, start: [0, 0, 0], stop: [0, 0, 1], direction: "z" }],
    resistors: [],
    mesh: { mode: "auto", cells_per_wavelength: 20 },
    far_field: { enabled: false },
  };

  // 4a. Default: solidConflict = "rename", updateExistingParams = false (keep existing W = 44)
  const destKeep = structuredClone(baseDest);
  const prevKeep = previewSolidTransfer(targeted, destKeep);
  assert.equal(prevKeep.ok, true);
  assert.equal(prevKeep.counts.solidsRenamed, 1, "conflicting solid is renamed by default");
  assert.equal(prevKeep.solids[0].targetName, "substrate 2");
  assert.equal(prevKeep.counts.paramsKept, 1, "existing parameter W is kept by default");
  assert.equal(prevKeep.counts.paramsAdded, 4, "H, Z_top, er_base, er_eff are added");
  assert.equal(prevKeep.counts.materialsAdded, 1, "custom_sub is added");

  applySolidTransfer(destKeep, targeted);
  assert.deepEqual(destKeep.parts.map((p) => p.name), ["ground", "substrate", "substrate 2"]);
  assert.equal(destKeep.parts[2].label, "Main substrate 2", "conflicting display label is disambiguated too");
  const wKept = destKeep.params.find((p) => p.key === "W");
  assert.equal(wKept.default, 44, "existing W = 44 was NOT overwritten");
  assert.equal(wKept.label, "Existing width", "existing metadata kept");
  assert.equal(paramValues(destKeep.params).names.H, 22, "imported derived H = W/2 evaluates to 22 using kept W = 44");
  assert.deepEqual(
    designChecks(destKeep).filter((c) => c.severity === "error"),
    [],
    "renamed solid + kept parameter passes designChecks cleanly",
  );

  // Importing again renames to "substrate 3" cleanly.
  applySolidTransfer(destKeep, targeted);
  assert.equal(destKeep.parts.at(-1).name, "substrate 3");
  assert.deepEqual(designChecks(destKeep).filter((c) => c.severity === "error"), []);

  // 4b. Opt-in: solidConflict = "replace", updateExistingParams = true
  const destUpdate = structuredClone(baseDest);
  // Also pre-seed H as an independent parameter BEFORE W existed at the end, to test dependency reordering on update.
  destUpdate.params = [
    { key: "f0", default: 2.45, unit: "GHz" },
    { key: "H", default: 12, unit: "mm", label: "Existing height" },
    { key: "W", default: 44, unit: "mm", min: 20, max: 60, label: "Existing width" },
  ];
  const prevUpdate = previewSolidTransfer(targeted, destUpdate, {
    solidConflict: "replace",
    updateExistingParams: true,
  });
  assert.equal(prevUpdate.ok, true);
  assert.equal(prevUpdate.counts.solidsReplaced, 1);
  assert.equal(prevUpdate.counts.paramsUpdated, 2, "both W and H are marked updated");
  applySolidTransfer(destUpdate, targeted, { solidConflict: "replace", updateExistingParams: true });
  assert.deepEqual(destUpdate.parts.map((p) => p.name), ["ground", "substrate"], "replaced in-place without adding duplicate");
  assert.equal(destUpdate.parts[1].material, "custom_sub", "substrate material updated to imported solid");
  const wUpdated = destUpdate.params.find((p) => p.key === "W");
  const hUpdated = destUpdate.params.find((p) => p.key === "H");
  assert.equal(wUpdated.default, 30, "W updated to imported value 30");
  assert.equal(wUpdated.label, "Substrate width", "imported label applied when present");
  assert.equal(hUpdated.label, "Existing height", "existing label preserved when imported param has none");
  assert.ok(
    destUpdate.params.findIndex((p) => p.key === "W") < destUpdate.params.findIndex((p) => p.key === "H"),
    "W is ordered before derived H = W / 2",
  );
  assert.equal(paramValues(destUpdate.params).names.H, 15, "updated H evaluates to 15");
  assert.deepEqual(
    designChecks(destUpdate).filter((c) => c.severity === "error"),
    [],
    "replaced solid + updated parameters passes designChecks cleanly",
  );
}

// ---- 5. Single-step Undo in real Designer sessionCore + UI wiring contracts
{
  const session = createDesignerSession();
  try {
    const base = structuredClone(emptyDest);
    session.takeFile({ id: "dest_ant", hash: "h1", file: "dest_ant.design.json", design: base });
    const beforeUndoText = JSON.stringify(session.draft);
    assert.equal(session.canUndo(), false);

    session.edit((d) => {
      applySolidTransfer(d, fullPayload);
    }, "", "Import solids");

    assert.equal(session.draft.parts.length, 3, "all 3 solids imported in session");
    assert.equal(session.draft.materials.length, 2, "custom material added in session");
    assert.equal(session.draft.params.length, 6, "5 transitive parameters added alongside f0");
    assert.equal(session.canUndo(), true);
    assert.equal(session.undoLabel(), "Import solids");

    session.undo();
    assert.equal(session.canUndo(), false, "entire import applied as ONE single undo step");
    assert.equal(JSON.stringify(session.draft), beforeUndoText, "one undo restores exact prior design");

    session.redo();
    assert.equal(session.draft.parts.length, 3, "redo re-applies the imported solids, materials and parameters");
  } finally {
    session.dispose();
  }

  // UI entry points contracts
  assert.match(read("src/designer/ContextMenu.tsx"), /contextMenu\.exportSolid/, "solid context menu offers JSON export");
  assert.match(read("src/designer/NavTree.tsx"), /tree\.menu\.exportSolids/, "Solids tree section offers JSON export");
  assert.match(read("src/designer/NavTree.tsx"), /tree\.menu\.importSolids/, "Solids tree section offers JSON import");
  assert.match(read("src/designer/NavTree.tsx"), /tree\.menu\.exportComponentSolids/, "Component folder menu offers JSON export");
  assert.match(read("src/designer/DesignWorkspace.tsx"), /ribbon\.solids\.import/, "Modeling ribbon offers Solids JSON import");
  assert.match(read("src/designer/DesignWorkspace.tsx"), /ribbon\.solids\.export/, "Modeling ribbon offers Solids JSON export");
  assert.match(read("src/designer/SolidTransferDialog.tsx"), /edit\(\(d\) => \{\s*applied = applySolidTransfer/s, "dialog applies import in one edit() undo step");
}

console.log("Solid transfer delta export, transitive parameter/material closure, BOM/schema/lint validation, conflict modes and single-step undo passed");
