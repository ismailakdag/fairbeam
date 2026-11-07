#!/usr/bin/env node
// Display units (src/lib/displayUnits.ts): designs store mm and GHz; the chosen units only change
// what fields show and how typed numbers are read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultUnits, designUnitsOpen, displayUnits, fromTyped, kindOf, registerDesignUnits, setDefaultUnits, setDisplayUnits, shownUnit, storedUnitLabel, toShown, validUnits } from "../src/lib/displayUnits.ts";

const mmGHz = { length: "mm", frequency: "GHz" };
const cmMHz = { length: "cm", frequency: "MHz" };
assert.equal(kindOf("mm"), "length");
assert.equal(kindOf("GHz"), "frequency");
assert.equal(kindOf("Ω"), null);
assert.equal(shownUnit("mm", cmMHz), "cm");
assert.equal(shownUnit("GHz", cmMHz), "MHz");
assert.equal(shownUnit("deg", cmMHz), "deg", "other units are left alone");
assert.equal(toShown(10, "mm", cmMHz), 1, "10 mm reads 1 in cm");
assert.equal(toShown(0.0071, "GHz", cmMHz), 7.1, "0.0071 GHz reads 7.1 in MHz");
assert.equal(toShown(5, "deg", cmMHz), 5);
assert.equal(fromTyped("1", "mm", cmMHz), 10, "a plain number is read in the chosen unit");
assert.equal(fromTyped("7.1", "GHz", cmMHz), 0.0071);
assert.equal(fromTyped("1 cm", "mm", mmGHz), 10, "a number with a unit is read in that unit");
assert.equal(fromTyped("2m", "mm", mmGHz), 2000);
assert.equal(fromTyped("1 in", "mm", mmGHz), 25.4);
assert.equal(fromTyped("7.1 MHz", "GHz", mmGHz), 0.0071);
assert.equal(fromTyped("2,5 cm", "mm", mmGHz), 25, "a decimal comma reads as a point");
assert.equal(fromTyped("3", "mm", mmGHz), 3, "mm stays mm");
assert.equal(fromTyped("w/2", "mm", cmMHz), null, "expressions are not converted");
assert.equal(fromTyped("1 MHz", "mm", mmGHz), null, "a unit of the other kind is not a length");
assert.equal(fromTyped("1", "deg", cmMHz), null, "fields without a length or frequency unit are left alone");
for (const x of [0.3, 17.5, 19605.633802816905]) assert.ok(Math.abs(fromTyped(String(toShown(x, "mm", cmMHz)), "mm", cmMHz) - x) <= 1e-12 * x, `round trip ${x}`);

assert.equal(storedUnitLabel("MHz"), "GHz", "a frequency unit label is stored as GHz");
assert.equal(storedUnitLabel(" cm "), "mm", "a length unit label is stored as mm");
assert.equal(storedUnitLabel("Ω"), "Ω", "other labels are kept");
assert.equal(storedUnitLabel("M"), "M", "a half-typed label is kept");

// a design's own units over the Settings default; with no design open the menu sets the default
assert.deepEqual(validUnits({ length: "km", frequency: "MHz", x: 1 }), { frequency: "MHz" });
let design = null;
const saved = [];
registerDesignUnits(() => design, (u) => { saved.push(u); design = { ...u }; });
assert.equal(designUnitsOpen(), false);
setDisplayUnits({ frequency: "MHz" });
assert.deepEqual(defaultUnits(), { length: "mm", frequency: "MHz" }, "no design open: the default changes");
design = {};
assert.deepEqual(displayUnits(), { length: "mm", frequency: "MHz" }, "a design without units uses the default");
setDisplayUnits({ length: "m" });
assert.deepEqual(saved.at(-1), { length: "m", frequency: "MHz" }, "with a design open the design saves the choice");
assert.deepEqual(defaultUnits(), { length: "mm", frequency: "MHz" }, "and the default stays");
setDefaultUnits({ length: "cm" });
assert.deepEqual(displayUnits(), { length: "m", frequency: "MHz" }, "the design's own choice wins over the default");
design = null;
assert.deepEqual(displayUnits(), { length: "cm", frequency: "MHz" });
setDefaultUnits({ length: "mm", frequency: "GHz" });

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
assert.match(read("src/designer/StatusBar.tsx"), /<UnitsMenu \/>/, "the status bar's units open a menu");
assert.match(read("src/designer/DesignPane.tsx"), /fromTyped\(e\.currentTarget\.value, canonical\(\)\) \?\? toExpr/, "value fields convert typed numbers");
assert.match(read("src/designer/RibbonField.tsx"), /fromTyped\(value, props\.unit\)/);
assert.match(read("src/designer/ParametersDock.tsx"), /shownUnit\(p\.unit\)/, "the parameter unit label follows the chosen unit");
assert.match(read("src/designer/PropsExtras.tsx"), /storedUnitLabel/, "the inspector stores unit labels canonically");
assert.match(read("src/components/GeneralSettings.tsx"), /setDefaultUnits\(\{ length:/, "Settings picks the default units");
assert.match(read("src/designer/store.ts"), /registerDesignUnits\(/, "the open design saves its own units");
assert.match(read("src/designer/DesignPane.tsx"), /dz-design-length-unit/, "the design Properties pick the units too");
assert.match(read("src/charts/LineChart.tsx"), /xLabelShown\(\)/, "GHz chart axes follow the chosen unit");
console.log("display units: conversion, parsing and entry points ok");
