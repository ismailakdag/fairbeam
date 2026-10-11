// Pure regression for exporting the plotted synthesized array and selected element.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { comparedResultDataTable, resultDataCsv, resultDataTable } from "../src/designer/resultData.ts";
const arrayPattern = JSON.parse(readFileSync(new URL("../public/projects/patch-array-2x1.json", import.meta.url), "utf8"));
const p2 = arrayPattern.results.farfield.find(ff => ff.port === 2);
assert.ok(p2);
const selectedPattern = resultDataTable(arrayPattern, "pattern", p2.f, { patternPort: 2 });
const synthesized = { ...p2, port: undefined, f: p2.f + 1, theta: [0, 20], phi: [0], directivity_dbi: [[9.123456789012345], [7.876543210987654]] };
const overlayOptions = { patternPort: 2, patternEntries: [{ label: "Array", field: synthesized }, { label: "Element P2", field: p2 }] };
const overlayTable = resultDataTable(arrayPattern, "pattern", p2.f, overlayOptions);
assert.deepEqual(overlayTable.header, ["Pattern", "Port", "f (GHz)", "theta (deg)", "phi (deg)", "Directivity (dBi)"]);
assert.deepEqual(overlayTable.rows[0], ["Array", null, synthesized.f / 1e9, 0, 0, 9.123456789012345]);
assert.deepEqual(overlayTable.rows[2], ["Element P2", 2, p2.f / 1e9, p2.theta[0], p2.phi[0], p2.directivity_dbi[0][0]]);
assert.equal(overlayTable.rows.length, selectedPattern.rows.length + 2, "independent grids are retained without resampling");
assert.deepEqual(comparedResultDataTable([{ file: "a", bundle: arrayPattern }, { file: "b", bundle: arrayPattern }], "pattern", p2.f, overlayOptions),
  comparedResultDataTable([{ file: "a", bundle: arrayPattern }, { file: "b", bundle: arrayPattern }], "pattern", p2.f, { patternPort: 2 }),
  "standalone synthesized overlay never leaks into a stored-run comparison");
assert.ok(resultDataCsv(overlayTable).includes("Array,,"), "synthesized array never borrows an element port");
assert.ok(resultDataCsv(overlayTable).includes("9.123456789012344"), "CSV retains JavaScript round-trip precision");
console.log("Array pattern export: overlay identity, selected port, per-grid frequency, full precision and comparison isolation passed.");
