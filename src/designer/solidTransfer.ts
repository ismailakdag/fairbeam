// Targeted and full solids export/import with transitive parameter and material delta
// (schema "fairbeam.solid-transfer/1"). Pure TypeScript (no Solid, no DOM, no i18n),
// so Node check scripts can run it directly and exported JSON always uses decimal points.
import { materialiseBoolean } from "./booleanParts.ts";
import { designChecks } from "./checks.ts";
import { validColor, validOpacity } from "./colors.ts";
import { descriptorProblem } from "./dispersion.ts";
import { evaluate, nameMap, namesIn, paramKeyError, paramValues } from "./expr.ts";
import { isReservedName } from "../lib/legacy.ts";
import type {
  Axis,
  BooleanOperation,
  Design,
  DesignCut,
  DesignMaterial,
  DesignParam,
  DesignPart,
  DesignTransform,
  Expr,
} from "./types.ts";

export const SOLID_TRANSFER_SCHEMA = "fairbeam.solid-transfer/1" as const;
export const SOLID_TRANSFER_LIMIT = 4 * 1024 * 1024;

export interface SolidTransferPayload {
  schema: typeof SOLID_TRANSFER_SCHEMA;
  units: "mm/GHz";
  params: DesignParam[];
  materials: DesignMaterial[];
  parts: DesignPart[];
}

export type SolidConflictMode = "rename" | "replace";

export interface SolidTransferOptions {
  /** How to resolve solids whose `name` already exists in the destination design (default: "rename"). */
  solidConflict?: SolidConflictMode;
  /** Overwrite existing destination parameters with the imported values/expressions (default: false). */
  updateExistingParams?: boolean;
  /** Overwrite existing destination materials with the imported definitions (default: false). */
  updateExistingMaterials?: boolean;
}

export type TransferErrorCode =
  | "file-too-large"
  | "invalid-json"
  | "invalid-schema"
  | "invalid-structure"
  | "param-key"
  | "param-duplicate"
  | "param-value"
  | "param-expr"
  | "material-duplicate"
  | "material-invalid"
  | "material-missing"
  | "solid-name"
  | "solid-duplicate"
  | "solid-invalid"
  | "design-check";

export interface SolidTransferDiagnostic {
  code: TransferErrorCode;
  checkCode?: string;
  path?: string;
  message: string;
  params?: Record<string, string | number>;
}

export interface SolidPreviewItem {
  name: string;
  targetName: string;
  label?: string;
  material: string;
  kind: "added" | "renamed" | "replaced" | "error";
  message?: string;
  diagnostic?: SolidTransferDiagnostic;
}

export interface ParamPreviewItem {
  key: string;
  kind: "added" | "kept" | "updated" | "unchanged" | "error";
  expression: string;
  existingExpression?: string;
  message?: string;
  diagnostic?: SolidTransferDiagnostic;
}

export interface MaterialPreviewItem {
  name: string;
  materialKind: "metal" | "dielectric";
  kind: "added" | "kept" | "updated" | "unchanged" | "error";
  message?: string;
  diagnostic?: SolidTransferDiagnostic;
}

export interface SolidTransferCounts {
  solidsAdded: number;
  solidsRenamed: number;
  solidsReplaced: number;
  paramsAdded: number;
  paramsKept: number;
  paramsUpdated: number;
  paramsUnchanged: number;
  materialsAdded: number;
  materialsKept: number;
  materialsUpdated: number;
  materialsUnchanged: number;
  errors: number;
}

export interface SolidTransferPreview {
  ok: boolean;
  solids: SolidPreviewItem[];
  params: ParamPreviewItem[];
  materials: MaterialPreviewItem[];
  counts: SolidTransferCounts;
  errors: SolidTransferDiagnostic[];
  /** Complete validated next Design when `ok` is true; undefined when `ok` is false. */
  candidate?: Design;
  /** Indices in `candidate.parts` of the imported solids. */
  appliedPartIndices: number[];
}

export class SolidTransferError extends Error {
  readonly diagnostics: SolidTransferDiagnostic[];
  constructor(message: string, diagnostics: SolidTransferDiagnostic[]) {
    super(message);
    this.name = "SolidTransferError";
    this.diagnostics = diagnostics;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOP_KEYS = new Set(["schema", "units", "components", "params", "materials", "parts"]);
const PARAM_KEYS = new Set(["key", "default", "expr", "label", "unit", "description", "min", "max"]);
const MATERIAL_KEYS = new Set([
  "name", "kind", "eps_r", "mu_r", "tan_d", "tan_d_freq", "dispersion", "conductivity", "thickness", "color", "opacity", "library",
]);
const PART_KEYS = new Set(["name", "label", "component", "material", "color", "opacity", "primitives", "transforms", "cuts", "booleanHistory"]);
const AXES = new Set<Axis>(["x", "y", "z"]);
const BOOLEAN_OPS = new Set<BooleanOperation>(["add", "subtract", "intersect", "insert"]);
const PRIMITIVE_KINDS = new Set(["box", "cylinder", "sphere", "polygon", "linpoly", "cone", "torus", "wire", "polyhedron"]);

const GEOMETRY_EXPR_KEYS = [
  "start", "stop", "points", "vertices", "elevation", "length", "range", "radius", "inner_radius", "center",
  "bottom_radius", "top_radius", "major_radius", "minor_radius",
] as const;
const TRANSFORM_EXPR_KEYS = ["offset", "center", "angle", "copies", "step", "factors", "origin", "point"] as const;
const CUT_EXPR_KEYS = ["start", "stop", "center", "radius", "elevation", "points"] as const;
const MATERIAL_EXPR_KEYS = ["eps_r", "mu_r", "tan_d", "tan_d_freq", "conductivity", "thickness"] as const;
const WORD_KEYS = new Set(["edge_rule", "quantity", "component", "normal", "kind", "type", "mode", "name", "label", "axis", "plane"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return !Object.getOwnPropertyNames(value).some((k) => FORBIDDEN_KEYS.has(k));
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.getOwnPropertyNames(obj).every((k) => allowed.has(k));
}

function isExprValue(v: unknown): v is Expr {
  return (typeof v === "number" && Number.isFinite(v))
    || (typeof v === "string" && v.trim().length > 0 && v.length <= 1024);
}

function isExprTuple(v: unknown, len: number): boolean {
  return Array.isArray(v) && v.length === len && v.every(isExprValue);
}

/** Collect all expression strings referenced inside an object's expression fields. */
function collectStrings(obj: unknown, keys: readonly string[], out: string[]) {
  if (!obj || typeof obj !== "object") return;
  const rec = obj as Record<string, unknown>;
  const walk = (v: unknown) => {
    if (typeof v === "string") { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) if (!WORD_KEYS.has(k)) walk(child);
    }
  };
  for (const k of keys) if (k in rec) walk(rec[k]);
}

function collectPartExpressions(part: DesignPart, out: string[]) {
  (part.primitives ?? []).forEach((pr) => collectStrings(pr, GEOMETRY_EXPR_KEYS, out));
  (part.transforms ?? []).forEach((tr) => collectStrings(tr, TRANSFORM_EXPR_KEYS, out));
  (part.cuts ?? []).forEach((c) => collectStrings(c, CUT_EXPR_KEYS, out));
  const h = part.booleanHistory;
  if (h?.A) collectPartExpressions(h.A, out);
  if (h?.B) collectPartExpressions(h.B, out);
}

function collectMaterialExpressions(material: DesignMaterial, out: string[]) {
  collectStrings(material, MATERIAL_EXPR_KEYS, out);
  if (material.dispersion?.model === "djordjevic-sarkar") {
    collectStrings(material.dispersion, ["m1", "m2"], out);
  }
}

/** Stable topological sort: keeps original order unless parameter B's `expr` depends on a later parameter A. */
export function orderParamsByDependency(params: readonly DesignParam[]): DesignParam[] {
  const n = params.length;
  if (n <= 1) return params.map(clone);
  const keySet = new Set(params.map((p) => p.key));
  const deps = params.map((p) => {
    if (p.expr === undefined) return [] as string[];
    return [...namesIn(p.expr)].filter((d) => d !== p.key && keySet.has(d));
  });
  const emitted = new Set<string>();
  const used = new Array<boolean>(n).fill(false);
  const result: DesignParam[] = [];
  while (result.length < n) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      if (deps[i].every((d) => emitted.has(d))) { pick = i; break; }
    }
    if (pick < 0) {
      // Cyclic dependency: emit the earliest remaining item; paramValues() will report the error.
      pick = used.findIndex((u) => !u);
    }
    used[pick] = true;
    emitted.add(params[pick].key);
    result.push(clone(params[pick]));
  }
  return result;
}

/** Build the transfer payload for selected solids (or all solids when `selectedIds` is omitted). */
export function buildSolidTransfer(design: Design, selectedIds?: Iterable<string>): SolidTransferPayload {
  const allParts = design.parts ?? [];
  let chosenParts: DesignPart[];
  if (selectedIds === undefined) {
    chosenParts = allParts.map(clone);
  } else {
    const wanted = new Set<string>();
    for (const raw of selectedIds) wanted.add(String(raw));
    if (wanted.size === 0) {
      const diag: SolidTransferDiagnostic = { code: "solid-invalid", message: "Select at least one solid to export." };
      throw new SolidTransferError(diag.message, [diag]);
    }
    const byName = new Set(allParts.map((p) => p.name));
    for (const id of wanted) {
      if (!byName.has(id)) {
        const diag: SolidTransferDiagnostic = { code: "solid-invalid", message: `Unknown solid '${id}'.`, params: { name: id } };
        throw new SolidTransferError(diag.message, [diag]);
      }
    }
    chosenParts = allParts.filter((p) => wanted.has(p.name)).map(clone);
  }

  // Keep live Insert operand snapshots current with their companion part if present in the design.
  for (const part of chosenParts) {
    const h = part.booleanHistory;
    if (h?.live && h.operation === "insert") {
      const companion = allParts.find((q) => q.name !== part.name && q.name === h.B.name);
      if (companion) h.B = clone(companion);
    }
    if (part.component !== undefined) {
      const trimmed = part.component.trim();
      if (trimmed) part.component = trimmed;
      else delete part.component;
    }
  }

  // Referenced materials in design order.
  const matByName = new Map((design.materials ?? []).map((m) => [m.name, m]));
  const neededMatNames = new Set<string>();
  for (const part of chosenParts) {
    if (!matByName.has(part.material)) {
      const diag: SolidTransferDiagnostic = {
        code: "material-missing",
        message: `Material '${part.material}' is missing from the design.`,
        params: { material: part.material },
      };
      throw new SolidTransferError(diag.message, [diag]);
    }
    neededMatNames.add(part.material);
  }
  const chosenMaterials = (design.materials ?? []).filter((m) => neededMatNames.has(m.name)).map(clone);

  // Transitive closure of referenced parameters from exported solids + exported materials.
  const exprStrings: string[] = [];
  for (const part of chosenParts) collectPartExpressions(part, exprStrings);
  for (const mat of chosenMaterials) collectMaterialExpressions(mat, exprStrings);

  const paramByKey = new Map((design.params ?? []).map((p) => [p.key, p]));
  const neededParamKeys = new Set<string>();
  const queue: string[] = [];
  const enqueue = (key: string) => {
    if (paramByKey.has(key) && !neededParamKeys.has(key)) {
      neededParamKeys.add(key);
      queue.push(key);
    }
  };
  for (const expr of exprStrings) {
    for (const name of namesIn(expr)) enqueue(name);
  }
  while (queue.length > 0) {
    const key = queue.shift()!;
    const param = paramByKey.get(key);
    if (param?.expr !== undefined) {
      for (const dep of namesIn(param.expr)) enqueue(dep);
    }
  }

  const chosenParams = orderParamsByDependency((design.params ?? []).filter((p) => neededParamKeys.has(p.key)));

  return {
    schema: SOLID_TRANSFER_SCHEMA,
    units: "mm/GHz",
    params: chosenParams,
    materials: chosenMaterials,
    parts: chosenParts,
  };
}

/** Export selected solids (or all solids when `selectedIds` is omitted) with transitive parameter & material delta. */
export function exportSolidsJson(design: Design, selectedIds?: Iterable<string>): string {
  return JSON.stringify(buildSolidTransfer(design, selectedIds), null, 2) + "\n";
}

/** Parse and structurally check a `"fairbeam.solid-transfer/1"` JSON string (stripping optional UTF-8 BOM). */
export function parseSolidTransfer(text: string): SolidTransferPayload {
  const clean = String(text).replace(/^\uFEFF/, "");
  if (clean.length > SOLID_TRANSFER_LIMIT) {
    const diag: SolidTransferDiagnostic = {
      code: "file-too-large",
      message: "This solids transfer file exceeds the 4 MB limit.",
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-json",
      message: "JSON is not valid. Check quotes, commas and brackets.",
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, TOP_KEYS)) {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-structure",
      message: "This solids transfer file is incomplete or malformed.",
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  if (raw.schema !== SOLID_TRANSFER_SCHEMA) {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-schema",
      message: `Unsupported schema. Expected "${SOLID_TRANSFER_SCHEMA}".`,
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  if (raw.units !== undefined && raw.units !== "mm/GHz") {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-schema",
      message: 'Unsupported units. Expected "mm/GHz".',
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  const paramsRaw = raw.params === undefined ? [] : raw.params;
  const materialsRaw = raw.materials === undefined ? [] : raw.materials;
  const partsRaw = raw.parts;
  if (!Array.isArray(paramsRaw) || !Array.isArray(materialsRaw) || !Array.isArray(partsRaw)
    || paramsRaw.some((p) => !isPlainObject(p))
    || materialsRaw.some((m) => !isPlainObject(m))
    || partsRaw.some((p) => !isPlainObject(p))) {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-structure",
      message: "Solid transfer file must contain object arrays for params, materials and parts.",
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  if (raw.components !== undefined && (!Array.isArray(raw.components) || raw.components.some((c) => typeof c !== "string"))) {
    const diag: SolidTransferDiagnostic = {
      code: "invalid-structure",
      message: "components must be a list of folder strings.",
    };
    throw new SolidTransferError(diag.message, [diag]);
  }
  return {
    schema: SOLID_TRANSFER_SCHEMA,
    units: "mm/GHz",
    params: clone(paramsRaw) as DesignParam[],
    materials: clone(materialsRaw) as DesignMaterial[],
    parts: clone(partsRaw) as DesignPart[],
  };
}

function validatePrimitiveShape(pr: unknown, path: string): string | null {
  if (!isPlainObject(pr)) return `${path}: shape must be an object`;
  const kind = pr.kind;
  if (typeof kind !== "string" || !PRIMITIVE_KINDS.has(kind)) return `${path}.kind: unsupported shape kind`;
  const baseAllowed = ["kind", "priority", "label", "void"];
  const checkAllowed = (extra: readonly string[]) => hasOnlyKeys(pr, new Set([...baseAllowed, ...extra]));
  if (pr.priority !== undefined && (typeof pr.priority !== "number" || !Number.isFinite(pr.priority))) return `${path}.priority: must be a finite number`;
  if (pr.label !== undefined && typeof pr.label !== "string") return `${path}.label: must be a string`;
  if (pr.void !== undefined && typeof pr.void !== "boolean") return `${path}.void: must be true or false`;

  switch (kind) {
    case "box":
      if (!checkAllowed(["start", "stop"])) return `${path}: unknown box field`;
      if (!isExprTuple(pr.start, 3) || !isExprTuple(pr.stop, 3)) return `${path}: box needs 3-element start and stop coordinates`;
      return null;
    case "cylinder":
      if ("axis" in pr) {
        if (!checkAllowed(["axis", "center", "radius", "inner_radius", "range"])) return `${path}: unknown cylinder field`;
        if (!AXES.has(pr.axis as Axis)) return `${path}.axis: axis must be x, y or z`;
        if (!isExprTuple(pr.center, 2) || !isExprTuple(pr.range, 2) || !isExprValue(pr.radius)) return `${path}: invalid cylinder coordinates or radius`;
      } else {
        if (!checkAllowed(["start", "stop", "radius", "inner_radius"])) return `${path}: unknown cylinder field`;
        if (!isExprTuple(pr.start, 3) || !isExprTuple(pr.stop, 3) || !isExprValue(pr.radius)) return `${path}: invalid cylinder endpoints or radius`;
      }
      if (pr.inner_radius !== undefined && !isExprValue(pr.inner_radius)) return `${path}.inner_radius: invalid inner radius`;
      return null;
    case "sphere":
      if (!checkAllowed(["center", "radius"])) return `${path}: unknown sphere field`;
      if (!isExprTuple(pr.center, 3) || !isExprValue(pr.radius)) return `${path}: invalid sphere center or radius`;
      return null;
    case "cone":
      if (!checkAllowed(["axis", "center", "bottom_radius", "top_radius", "range"])) return `${path}: unknown cone field`;
      if (!AXES.has(pr.axis as Axis)) return `${path}.axis: axis must be x, y or z`;
      if (!isExprTuple(pr.center, 2) || !isExprTuple(pr.range, 2) || !isExprValue(pr.bottom_radius) || !isExprValue(pr.top_radius)) {
        return `${path}: invalid cone geometry`;
      }
      return null;
    case "torus":
      if (!checkAllowed(["axis", "center", "major_radius", "minor_radius"])) return `${path}: unknown torus field`;
      if (!AXES.has(pr.axis as Axis)) return `${path}.axis: axis must be x, y or z`;
      if (!isExprTuple(pr.center, 3) || !isExprValue(pr.major_radius) || !isExprValue(pr.minor_radius)) return `${path}: invalid torus geometry`;
      return null;
    case "polygon":
    case "linpoly": {
      const extra = kind === "linpoly" ? ["normal", "elevation", "length", "points"] : ["normal", "elevation", "points"];
      if (!checkAllowed(extra)) return `${path}: unknown ${kind} field`;
      if (!AXES.has(pr.normal as Axis)) return `${path}.normal: normal must be x, y or z`;
      if (!isExprValue(pr.elevation)) return `${path}.elevation: invalid elevation`;
      if (kind === "linpoly" && !isExprValue(pr.length)) return `${path}.length: invalid extrusion length`;
      if (!Array.isArray(pr.points) || pr.points.length < 3 || !pr.points.every((pt) => isExprTuple(pt, 2))) {
        return `${path}.points: polygon needs at least 3 2D points`;
      }
      return null;
    }
    case "wire":
      if (!checkAllowed(["points", "radius"])) return `${path}: unknown wire field`;
      if (!isExprValue(pr.radius) || !Array.isArray(pr.points) || pr.points.length < 2 || !pr.points.every((pt) => isExprTuple(pt, 3))) {
        return `${path}: wire needs a radius and at least 2 3D points`;
      }
      return null;
    case "polyhedron":
      if (!checkAllowed(["vertices", "faces"])) return `${path}: unknown polyhedron field`;
      if (!Array.isArray(pr.vertices) || pr.vertices.length < 4 || !pr.vertices.every((pt) => isExprTuple(pt, 3))) {
        return `${path}.vertices: polyhedron needs at least 4 3D vertices`;
      }
      if (!Array.isArray(pr.faces) || pr.faces.length < 4
        || !pr.faces.every((f) => Array.isArray(f) && f.length >= 3 && f.every((ix) => Number.isInteger(ix)))) {
        return `${path}.faces: polyhedron needs at least 4 faces of vertex indices`;
      }
      return null;
    default:
      return `${path}.kind: unsupported shape kind`;
  }
}

function validateCutShape(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path}: cut must be an object`;
  const kind = c.kind ?? "rect";
  if (kind === "rect") {
    if (!hasOnlyKeys(c, new Set(["kind", "start", "stop"])) || !isExprTuple(c.start, 3) || !isExprTuple(c.stop, 3)) {
      return `${path}: rectangle cut needs 3-element start and stop`;
    }
    return null;
  }
  if (kind === "circle") {
    if (!hasOnlyKeys(c, new Set(["kind", "normal", "elevation", "center", "radius"]))) return `${path}: unknown circle cut field`;
    if (c.normal !== undefined && !AXES.has(c.normal as Axis)) return `${path}.normal: normal must be x, y or z`;
    if (c.elevation !== undefined && !isExprValue(c.elevation)) return `${path}.elevation: invalid elevation`;
    if (!isExprTuple(c.center, 2) || !isExprValue(c.radius)) return `${path}: circle cut needs center and radius`;
    return null;
  }
  if (kind === "polygon") {
    if (!hasOnlyKeys(c, new Set(["kind", "normal", "elevation", "points"]))) return `${path}: unknown polygon cut field`;
    if (c.normal !== undefined && !AXES.has(c.normal as Axis)) return `${path}.normal: normal must be x, y or z`;
    if (c.elevation !== undefined && !isExprValue(c.elevation)) return `${path}.elevation: invalid elevation`;
    if (!Array.isArray(c.points) || c.points.length < 3 || !c.points.every((pt) => isExprTuple(pt, 2))) {
      return `${path}.points: polygon cut needs at least 3 2D points`;
    }
    return null;
  }
  return `${path}.kind: unsupported cut kind`;
}

function validateTransformShape(tr: unknown, path: string): string | null {
  if (!isPlainObject(tr)) return `${path}: transform must be an object`;
  switch (tr.type) {
    case "move":
      if (!hasOnlyKeys(tr, new Set(["type", "offset"])) || !isExprTuple(tr.offset, 3)) return `${path}: move needs 3-element offset`;
      return null;
    case "rotate":
      if (!hasOnlyKeys(tr, new Set(["type", "axis", "center", "angle", "copies"]))) return `${path}: unknown rotate field`;
      if (!AXES.has(tr.axis as Axis) || !isExprTuple(tr.center, 3) || !isExprValue(tr.angle)) return `${path}: invalid rotate parameters`;
      if (tr.copies !== undefined && !isExprValue(tr.copies)) return `${path}.copies: invalid copies`;
      return null;
    case "translate":
      if (!hasOnlyKeys(tr, new Set(["type", "copies", "step"])) || !isExprValue(tr.copies) || !isExprTuple(tr.step, 3)) {
        return `${path}: translate needs copies and 3-element step`;
      }
      return null;
    case "scale":
      if (!hasOnlyKeys(tr, new Set(["type", "factors", "origin", "copies"])) || !isExprTuple(tr.factors, 3) || !isExprTuple(tr.origin, 3)) {
        return `${path}: scale needs 3-element factors and origin`;
      }
      if (tr.copies !== undefined && !isExprValue(tr.copies)) return `${path}.copies: invalid copies`;
      return null;
    case "mirror":
      if (!hasOnlyKeys(tr, new Set(["type", "plane", "point", "keep"])) || !AXES.has(tr.plane as Axis)) return `${path}: mirror needs plane x, y or z`;
      if (tr.point !== undefined && !isExprTuple(tr.point, 3)) return `${path}.point: mirror point needs 3 coordinates`;
      if (tr.keep !== undefined && typeof tr.keep !== "boolean") return `${path}.keep: keep must be true or false`;
      return null;
    default:
      return `${path}.type: unsupported transform type`;
  }
}

function validatePartShape(pt: unknown, path: string, depth = 0): { code: TransferErrorCode; message: string; name?: string } | null {
  if (depth > 16) return { code: "solid-invalid", message: `${path}: Boolean history is nested too deeply` };
  if (!isPlainObject(pt) || !hasOnlyKeys(pt, PART_KEYS)) {
    return { code: "solid-invalid", message: `${path}: solid contains unknown or malformed fields` };
  }
  if (typeof pt.name !== "string" || !pt.name.trim() || isReservedName(pt.name.trim())) {
    return { code: "solid-name", message: `Solid name '${String(pt.name ?? "")}' is empty or reserved.`, name: String(pt.name ?? "") };
  }
  if (pt.label !== undefined && typeof pt.label !== "string") {
    return { code: "solid-invalid", message: `${path}.label: label must be a string` };
  }
  if (pt.component !== undefined) {
    if (typeof pt.component !== "string") return { code: "solid-invalid", message: `${path}.component: component must be a folder string` };
    const trimmed = pt.component.trim();
    if (trimmed && trimmed.split("/").some((seg) => !seg.trim())) {
      return { code: "solid-invalid", message: `${path}.component: component path '${pt.component}' has an empty folder segment` };
    }
  }
  if (typeof pt.material !== "string" || !pt.material.trim()) {
    return { code: "material-missing", message: `${path}.material: solid needs a material name` };
  }
  if (pt.color !== undefined && !validColor(pt.color)) {
    return { code: "solid-invalid", message: `${path}.color: color must be #rrggbb` };
  }
  if (pt.opacity !== undefined && validOpacity(pt.opacity) === undefined) {
    return { code: "solid-invalid", message: `${path}.opacity: opacity must be between 0.05 and 1` };
  }
  if (!Array.isArray(pt.primitives)) {
    return { code: "solid-invalid", message: `${path}.primitives: primitives must be an array` };
  }
  for (let j = 0; j < pt.primitives.length; j++) {
    const err = validatePrimitiveShape(pt.primitives[j], `${path}.primitives[${j}]`);
    if (err) return { code: "solid-invalid", message: err };
  }
  if (pt.cuts !== undefined) {
    if (!Array.isArray(pt.cuts)) return { code: "solid-invalid", message: `${path}.cuts: cuts must be an array` };
    for (let k = 0; k < pt.cuts.length; k++) {
      const err = validateCutShape((pt.cuts as DesignCut[])[k], `${path}.cuts[${k}]`);
      if (err) return { code: "solid-invalid", message: err };
    }
  }
  if (pt.transforms !== undefined) {
    if (!Array.isArray(pt.transforms)) return { code: "solid-invalid", message: `${path}.transforms: transforms must be an array` };
    for (let k = 0; k < pt.transforms.length; k++) {
      const err = validateTransformShape((pt.transforms as DesignTransform[])[k], `${path}.transforms[${k}]`);
      if (err) return { code: "solid-invalid", message: err };
    }
  }
  if (pt.booleanHistory !== undefined) {
    const h = pt.booleanHistory;
    if (!isPlainObject(h) || !hasOnlyKeys(h, new Set(["operation", "A", "B", "live"])) || !BOOLEAN_OPS.has(h.operation as BooleanOperation)) {
      return { code: "solid-invalid", message: `${path}.booleanHistory: invalid Boolean history` };
    }
    if (h.live !== undefined && typeof h.live !== "boolean") {
      return { code: "solid-invalid", message: `${path}.booleanHistory.live: live must be true or false` };
    }
    const errA = validatePartShape(h.A, `${path}.booleanHistory.A`, depth + 1);
    if (errA) return errA;
    const errB = validatePartShape(h.B, `${path}.booleanHistory.B`, depth + 1);
    if (errB) return errB;
  }
  return null;
}

function validateBooleanExpressions(part: DesignPart, values: Record<string, number>, path: string): string | null {
  const exprs: string[] = [];
  (part.primitives ?? []).forEach((pr) => collectStrings(pr, GEOMETRY_EXPR_KEYS, exprs));
  (part.transforms ?? []).forEach((tr) => collectStrings(tr, TRANSFORM_EXPR_KEYS, exprs));
  (part.cuts ?? []).forEach((c) => collectStrings(c, CUT_EXPR_KEYS, exprs));
  for (const s of exprs) {
    try {
      evaluate(s, values);
    } catch (e) {
      return `${path}: ${(e as Error).message}`;
    }
  }
  const h = part.booleanHistory;
  if (h) {
    return validateBooleanExpressions(h.A, values, `${path}.booleanHistory.A`)
      ?? validateBooleanExpressions(h.B, values, `${path}.booleanHistory.B`);
  }
  return null;
}

function paramExprString(p: DesignParam): string {
  return p.expr !== undefined ? p.expr : p.default !== undefined ? String(p.default) : "";
}

function sameParamValue(a: DesignParam, b: DesignParam): boolean {
  return a.default === b.default
    && a.expr === b.expr
    && (a.unit ?? "") === (b.unit ?? "")
    && (a.description ?? "") === (b.description ?? "");
}

function normalizeMaterialComparable(m: DesignMaterial): string {
  const { library: _library, ...rest } = m;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rest).sort()) {
    const v = (rest as Record<string, unknown>)[k];
    if (v !== undefined) sorted[k] = v;
  }
  return JSON.stringify(sorted);
}

function freeSolidName(base: string, usedNames: Set<string>, usedLabels: Set<string>): string {
  if (!usedNames.has(base) && !usedLabels.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!usedNames.has(candidate) && !usedLabels.has(candidate)) return candidate;
  }
}

/** Validate a solid transfer payload against `destination` and compute a complete preview without mutating anything. */
export function previewSolidTransfer(
  payload: SolidTransferPayload,
  destination: Design,
  options: SolidTransferOptions = {},
): SolidTransferPreview {
  const solidConflict: SolidConflictMode = options.solidConflict ?? "rename";
  const updateExistingParams = options.updateExistingParams === true;
  const updateExistingMaterials = options.updateExistingMaterials === true;

  const errors: SolidTransferDiagnostic[] = [];
  const pushError = (diag: SolidTransferDiagnostic) => { errors.push(diag); return diag; };

  const destParams = clone(destination.params ?? []);
  const destMaterials = clone(destination.materials ?? []);
  const destParts = clone(destination.parts ?? []);

  // ---- 1. Validate & merge parameters
  const existingParamByKey = new Map(destParams.map((p) => [p.key, p]));
  const destParamCounts = new Map<string, number>();
  for (const p of destParams) destParamCounts.set(p.key, (destParamCounts.get(p.key) ?? 0) + 1);

  const seenParamKeys = new Set<string>();
  const validImportedParams = new Map<string, DesignParam>();
  const paramItems: ParamPreviewItem[] = (payload.params ?? []).map((raw): ParamPreviewItem => {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw as unknown as Record<string, unknown>, PARAM_KEYS)) {
      const diag = pushError({ code: "param-value", message: "Parameter entry contains unknown fields." });
      return { key: String((raw as { key?: unknown })?.key ?? ""), kind: "error", expression: "", message: diag.message, diagnostic: diag };
    }
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const badKey = paramKeyError(key);
    if (badKey) {
      const diag = pushError({ code: "param-key", path: `params.${key}`, message: badKey, params: { key } });
      return { key, kind: "error", expression: paramExprString(raw), message: badKey, diagnostic: diag };
    }
    if (seenParamKeys.has(key)) {
      const diag = pushError({ code: "param-duplicate", path: `params.${key}`, message: "Duplicate key in import.", params: { key } });
      return { key, kind: "error", expression: paramExprString(raw), message: diag.message, diagnostic: diag };
    }
    seenParamKeys.add(key);
    if ((destParamCounts.get(key) ?? 0) > 1) {
      const diag = pushError({ code: "param-duplicate", path: `params.${key}`, message: "This key is duplicated in the current design.", params: { key } });
      return { key, kind: "error", expression: paramExprString(raw), message: diag.message, diagnostic: diag };
    }
    const hasExpr = raw.expr !== undefined;
    const hasDefault = raw.default !== undefined;
    if (hasExpr === hasDefault) {
      const diag = pushError({ code: "param-value", path: `params.${key}`, message: "Expression is required.", params: { key } });
      return { key, kind: "error", expression: paramExprString(raw), message: diag.message, diagnostic: diag };
    }
    if (hasExpr && (typeof raw.expr !== "string" || !raw.expr.trim())) {
      const diag = pushError({ code: "param-value", path: `params.${key}`, message: "Expression is required.", params: { key } });
      return { key, kind: "error", expression: String(raw.expr ?? ""), message: diag.message, diagnostic: diag };
    }
    if (hasDefault && (typeof raw.default !== "number" || !Number.isFinite(raw.default))) {
      const diag = pushError({ code: "param-value", path: `params.${key}`, message: "not a finite number", params: { key } });
      return { key, kind: "error", expression: String(raw.default ?? ""), message: diag.message, diagnostic: diag };
    }
    for (const lim of ["min", "max"] as const) {
      const v = raw[lim];
      if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        const diag = pushError({ code: "param-value", path: `params.${key}.${lim}`, message: `Parameter '${key}' ${lim} must be a finite number.`, params: { key } });
        return { key, kind: "error", expression: paramExprString(raw), message: diag.message, diagnostic: diag };
      }
    }
    for (const strKey of ["label", "unit", "description"] as const) {
      if (raw[strKey] !== undefined && typeof raw[strKey] !== "string") {
        const diag = pushError({ code: "param-value", path: `params.${key}.${strKey}`, message: `Parameter '${key}' ${strKey} must be a string.`, params: { key } });
        return { key, kind: "error", expression: paramExprString(raw), message: diag.message, diagnostic: diag };
      }
    }

    const cleanParam: DesignParam = { key };
    if (hasExpr) cleanParam.expr = raw.expr!.trim();
    else cleanParam.default = raw.default!;
    if (raw.label) cleanParam.label = raw.label;
    if (raw.unit) cleanParam.unit = raw.unit;
    if (raw.description) cleanParam.description = raw.description;
    if (raw.min !== undefined && raw.min !== null) cleanParam.min = raw.min;
    if (raw.max !== undefined && raw.max !== null) cleanParam.max = raw.max;

    const old = existingParamByKey.get(key);
    if (!old) {
      validImportedParams.set(key, cleanParam);
      return { key, kind: "added", expression: paramExprString(cleanParam) };
    }
    const existingExpression = paramExprString(old);
    if (sameParamValue(old, cleanParam)) {
      return { key, kind: "unchanged", expression: paramExprString(cleanParam), existingExpression };
    }
    if (!updateExistingParams) {
      return { key, kind: "kept", expression: paramExprString(cleanParam), existingExpression };
    }
    // Merge update while preserving compatible existing metadata when the import omits it.
    const merged: DesignParam = { ...cleanParam };
    if (merged.label === undefined && old.label !== undefined) merged.label = old.label;
    if (merged.min === undefined && merged.max === undefined && (old.min != null || old.max != null)) {
      if (merged.default !== undefined) {
        const loOk = old.min == null || merged.default >= old.min;
        const hiOk = old.max == null || merged.default <= old.max;
        if (loOk && hiOk) {
          if (old.min != null) merged.min = old.min;
          if (old.max != null) merged.max = old.max;
        }
      } else {
        if (old.min != null) merged.min = old.min;
        if (old.max != null) merged.max = old.max;
      }
    }
    validImportedParams.set(key, merged);
    return { key, kind: "updated", expression: paramExprString(merged), existingExpression };
  });

  const mergedParamsRaw: DesignParam[] = destParams.map((p) => {
    const incoming = validImportedParams.get(p.key);
    return incoming && updateExistingParams ? clone(incoming) : clone(p);
  });
  for (const [key, p] of validImportedParams) {
    if (!existingParamByKey.has(key)) mergedParamsRaw.push(clone(p));
  }
  const proposedParams = orderParamsByDependency(mergedParamsRaw);
  const resolvedParams = paramValues(proposedParams);

  for (let i = 0; i < paramItems.length; i++) {
    const item = paramItems[i];
    if (item.kind === "error") continue;
    const err = resolvedParams.errors[item.key];
    if (err) {
      const diag = pushError({ code: "param-expr", checkCode: "expr", path: `params.${item.key}`, message: err, params: { key: item.key } });
      paramItems[i] = { ...item, kind: "error", message: err, diagnostic: diag };
    }
  }

  // ---- 2. Validate & merge materials
  const existingMatByName = new Map(destMaterials.map((m) => [m.name, m]));
  const seenMatNames = new Set<string>();
  const validImportedMaterials = new Map<string, DesignMaterial>();
  const materialItems: MaterialPreviewItem[] = (payload.materials ?? []).map((raw): MaterialPreviewItem => {
    const rawObj = raw as unknown as Record<string, unknown>;
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const mKind: "metal" | "dielectric" = raw?.kind === "metal" ? "metal" : "dielectric";
    if (!isPlainObject(rawObj) || !hasOnlyKeys(rawObj, MATERIAL_KEYS) || !name || (raw.kind !== "metal" && raw.kind !== "dielectric")) {
      const diag = pushError({ code: "material-invalid", path: `materials.${name}`, message: `Material '${name || "?"}' is malformed.` });
      return { name, materialKind: mKind, kind: "error", message: diag.message, diagnostic: diag };
    }
    if (seenMatNames.has(name)) {
      const diag = pushError({ code: "material-duplicate", path: `materials.${name}`, message: `Duplicate material '${name}' in import.`, params: { material: name } });
      return { name, materialKind: mKind, kind: "error", message: diag.message, diagnostic: diag };
    }
    seenMatNames.add(name);
    if (raw.color !== undefined && !validColor(raw.color)) {
      const diag = pushError({ code: "material-invalid", path: `materials.${name}.color`, message: `Material '${name}' color must be #rrggbb.` });
      return { name, materialKind: mKind, kind: "error", message: diag.message, diagnostic: diag };
    }
    if (raw.opacity !== undefined && validOpacity(raw.opacity) === undefined) {
      const diag = pushError({ code: "material-invalid", path: `materials.${name}.opacity`, message: `Material '${name}' opacity must be between 0.05 and 1.` });
      return { name, materialKind: mKind, kind: "error", message: diag.message, diagnostic: diag };
    }
    const dispProblem = descriptorProblem(raw);
    if (dispProblem) {
      const diag = pushError({ code: "material-invalid", checkCode: "dispersion", path: `materials.${name}.dispersion`, message: dispProblem });
      return { name, materialKind: mKind, kind: "error", message: dispProblem, diagnostic: diag };
    }
    for (const field of MATERIAL_EXPR_KEYS) {
      const val = raw[field];
      if (val !== undefined && val !== null && !(typeof val === "string" && !val.trim()) && !isExprValue(val)) {
        const diag = pushError({ code: "material-invalid", path: `materials.${name}.${field}`, message: `Material '${name}' ${field} must be a number or expression.` });
        return { name, materialKind: mKind, kind: "error", message: diag.message, diagnostic: diag };
      }
    }

    const cleanMat: DesignMaterial = { ...clone(raw), name };
    const old = existingMatByName.get(name);
    if (!old) {
      validImportedMaterials.set(name, cleanMat);
      return { name, materialKind: mKind, kind: "added" };
    }
    if (normalizeMaterialComparable(old) === normalizeMaterialComparable(cleanMat)) {
      return { name, materialKind: mKind, kind: "unchanged" };
    }
    if (!updateExistingMaterials) {
      return { name, materialKind: old.kind, kind: "kept" };
    }
    validImportedMaterials.set(name, cleanMat);
    return { name, materialKind: mKind, kind: "updated" };
  });

  const proposedMaterials: DesignMaterial[] = destMaterials.map((m) => {
    const incoming = validImportedMaterials.get(m.name);
    return incoming && updateExistingMaterials ? clone(incoming) : clone(m);
  });
  for (const [name, m] of validImportedMaterials) {
    if (!existingMatByName.has(name)) proposedMaterials.push(clone(m));
  }
  const availableMaterials = new Set(proposedMaterials.map((m) => m.name));

  // ---- 3. Validate & resolve solids
  const usedNames = new Set(destParts.map((p) => p.name));
  const usedLabels = new Set(destParts.map((p) => p.label || p.name));
  const seenImportSolids = new Set<string>();
  const renamedMap = new Map<string, string>();

  const preparedParts: (DesignPart | null)[] = [];
  const solidItems: SolidPreviewItem[] = (payload.parts ?? []).map((raw, idx): SolidPreviewItem => {
    const shapeErr = validatePartShape(raw, `parts[${idx}]`);
    const rawName = typeof raw?.name === "string" ? raw.name.trim() : "";
    const rawMat = typeof raw?.material === "string" ? raw.material.trim() : "";
    if (shapeErr) {
      const diag = pushError({
        code: shapeErr.code,
        path: `parts[${idx}]`,
        message: shapeErr.message,
        ...(shapeErr.name !== undefined ? { params: { name: shapeErr.name } } : {}),
      });
      preparedParts.push(null);
      return { name: rawName, targetName: rawName, label: typeof raw?.label === "string" ? raw.label : undefined, material: rawMat, kind: "error", message: diag.message, diagnostic: diag };
    }
    const name = raw.name.trim();
    if (seenImportSolids.has(name)) {
      const diag = pushError({ code: "solid-duplicate", path: `parts[${idx}].name`, message: `Duplicate solid '${name}' in import.`, params: { name } });
      preparedParts.push(null);
      return { name, targetName: name, label: raw.label, material: raw.material, kind: "error", message: diag.message, diagnostic: diag };
    }
    seenImportSolids.add(name);

    const matName = raw.material.trim();
    if (!availableMaterials.has(matName)) {
      const diag = pushError({
        code: "material-missing",
        path: `parts[${idx}].material`,
        message: `Material '${matName}' is missing from both the file and the current design.`,
        params: { material: matName, name },
      });
      preparedParts.push(null);
      return { name, targetName: name, label: raw.label, material: matName, kind: "error", message: diag.message, diagnostic: diag };
    }

    // Validate expressions inside nested Boolean histories as well.
    if (raw.booleanHistory) {
      const histExprErr = validateBooleanExpressions(raw, resolvedParams.names, `parts[${idx}]`);
      if (histExprErr) {
        const diag = pushError({ code: "design-check", checkCode: "expr", path: `parts[${idx}].booleanHistory`, message: histExprErr });
        preparedParts.push(null);
        return { name, targetName: name, label: raw.label, material: matName, kind: "error", message: histExprErr, diagnostic: diag };
      }
    }

    const cleaned: DesignPart = { ...clone(raw), name, material: matName };
    if (cleaned.component !== undefined) {
      const trimmed = cleaned.component.trim();
      if (trimmed) cleaned.component = trimmed;
      else delete cleaned.component;
    }

    const exists = destParts.some((p) => p.name === name);
    if (!exists) {
      usedNames.add(name);
      usedLabels.add(cleaned.label || name);
      preparedParts.push(cleaned);
      return { name, targetName: name, label: cleaned.label, material: matName, kind: "added" };
    }
    if (solidConflict === "replace") {
      preparedParts.push(cleaned);
      return { name, targetName: name, label: cleaned.label, material: matName, kind: "replaced" };
    }
    const targetName = freeSolidName(name, usedNames, usedLabels);
    renamedMap.set(name, targetName);
    cleaned.name = targetName;
    if (cleaned.label && usedLabels.has(cleaned.label)) {
      cleaned.label = freeSolidName(cleaned.label, usedNames, usedLabels);
    }
    usedNames.add(targetName);
    usedLabels.add(cleaned.label || targetName);
    preparedParts.push(cleaned);
    return { name, targetName, label: cleaned.label, material: matName, kind: "renamed" };
  });

  // Update companion Insert references when both solids were renamed together, and recompute live Booleans.
  for (let i = 0; i < preparedParts.length; i++) {
    const part = preparedParts[i];
    if (!part?.booleanHistory) continue;
    if (part.booleanHistory.operation === "insert" && renamedMap.has(part.booleanHistory.B.name)) {
      part.booleanHistory.B.name = renamedMap.get(part.booleanHistory.B.name)!;
    }
    if (part.booleanHistory.live && Object.keys(resolvedParams.errors).length === 0) {
      try {
        part.primitives = materialiseBoolean(part.booleanHistory, resolvedParams.names);
      } catch (e) {
        const msg = (e as Error).message;
        const diag = pushError({ code: "solid-invalid", path: `parts[${i}]`, message: msg });
        solidItems[i] = { ...solidItems[i], kind: "error", message: msg, diagnostic: diag };
        preparedParts[i] = null;
      }
    }
  }

  // ---- 4. Run Fairbeam's designChecks() on both isolated probe and full candidate design
  if (errors.length === 0) {
    const validParts = preparedParts.filter((p): p is DesignPart => p !== null);
    const probe: Design = {
      schema: "fairbeam.design/1",
      model: { id: "solid-transfer-probe", name: "Solid transfer probe" },
      params: clone(proposedParams),
      materials: clone(proposedMaterials),
      parts: clone(validParts),
      ports: [],
      resistors: [],
      simulation: { f_min: 1, f_max: 2, boundaries: "MUR" },
      mesh: { mode: "auto", cells_per_wavelength: 20 },
      far_field: { enabled: false },
    };
    const probeErrors = designChecks(probe).filter(
      (c) => c.severity === "error" && c.code !== "no-port" && c.code !== "no-metal",
    );
    for (const c of probeErrors) {
      const diag = pushError({ code: "design-check", checkCode: c.code, path: c.path, message: c.message });
      const partMatch = /^parts\[(\d+)\]/.exec(c.path);
      if (partMatch) {
        const idx = Number(partMatch[1]);
        if (solidItems[idx] && solidItems[idx].kind !== "error") {
          solidItems[idx] = { ...solidItems[idx], kind: "error", message: c.message, diagnostic: diag };
        }
        continue;
      }
      const matMatch = /^materials\.([^.[]+)/.exec(c.path);
      if (matMatch) {
        const mIdx = materialItems.findIndex((m) => m.name === matMatch[1]);
        if (mIdx >= 0 && materialItems[mIdx].kind !== "error") {
          materialItems[mIdx] = { ...materialItems[mIdx], kind: "error", message: c.message, diagnostic: diag };
        }
        continue;
      }
      const paramMatch = /^params\[(\d+)\]/.exec(c.path);
      if (paramMatch) {
        const pKey = proposedParams[Number(paramMatch[1])]?.key;
        const pIdx = paramItems.findIndex((p) => p.key === pKey);
        if (pIdx >= 0 && paramItems[pIdx].kind !== "error") {
          paramItems[pIdx] = { ...paramItems[pIdx], kind: "error", message: c.message, diagnostic: diag };
        }
      }
    }
  }

  let candidate: Design | undefined;
  const appliedPartIndices: number[] = [];

  if (errors.length === 0) {
    const nextParts = clone(destParts);
    for (let i = 0; i < preparedParts.length; i++) {
      const pt = preparedParts[i]!;
      if (solidItems[i].kind === "replaced") {
        const existingIdx = nextParts.findIndex((p) => p.name === pt.name);
        if (existingIdx >= 0) {
          nextParts[existingIdx] = clone(pt);
          appliedPartIndices.push(existingIdx);
          continue;
        }
      }
      nextParts.push(clone(pt));
      appliedPartIndices.push(nextParts.length - 1);
    }

    // Recompute any pre-existing live Boolean solids if updating parameters changed their values.
    if (updateExistingParams) {
      const appliedSet = new Set(appliedPartIndices);
      for (let i = 0; i < nextParts.length; i++) {
        if (appliedSet.has(i)) continue;
        const p = nextParts[i];
        if (p.booleanHistory?.live) {
          try {
            p.primitives = materialiseBoolean(p.booleanHistory, resolvedParams.names);
          } catch (e) {
            pushError({ code: "solid-invalid", path: `parts[${i}]`, message: (e as Error).message });
          }
        }
      }
    }

    if (errors.length === 0) {
      const nextDesign: Design = {
        ...clone(destination),
        params: clone(proposedParams),
        materials: clone(proposedMaterials),
        parts: nextParts,
      };
      const normalizeSig = (d: Design, c: { code: string; path: string; message: string }) => {
        const pm = /^params\[(\d+)\](.*)$/.exec(c.path);
        const normPath = pm ? `params:${d.params[Number(pm[1])]?.key ?? pm[1]}${pm[2]}` : c.path;
        return `${c.code}|${normPath}|${c.message}`;
      };
      const beforeErrors = new Set(
        designChecks(destination)
          .filter((c) => c.severity === "error" && c.code !== "no-port" && c.code !== "no-metal")
          .map((c) => normalizeSig(destination, c)),
      );
      const afterErrors = designChecks(nextDesign).filter(
        (c) => c.severity === "error" && c.code !== "no-port" && c.code !== "no-metal" && !beforeErrors.has(normalizeSig(nextDesign, c)),
      );
      for (const c of afterErrors) {
        pushError({ code: "design-check", checkCode: c.code, path: c.path, message: c.message });
      }
      if (errors.length === 0) candidate = nextDesign;
    }
  }

  const counts: SolidTransferCounts = {
    solidsAdded: solidItems.filter((s) => s.kind === "added").length,
    solidsRenamed: solidItems.filter((s) => s.kind === "renamed").length,
    solidsReplaced: solidItems.filter((s) => s.kind === "replaced").length,
    paramsAdded: paramItems.filter((p) => p.kind === "added").length,
    paramsKept: paramItems.filter((p) => p.kind === "kept").length,
    paramsUpdated: paramItems.filter((p) => p.kind === "updated").length,
    paramsUnchanged: paramItems.filter((p) => p.kind === "unchanged").length,
    materialsAdded: materialItems.filter((m) => m.kind === "added").length,
    materialsKept: materialItems.filter((m) => m.kind === "kept").length,
    materialsUpdated: materialItems.filter((m) => m.kind === "updated").length,
    materialsUnchanged: materialItems.filter((m) => m.kind === "unchanged").length,
    errors: errors.length,
  };

  return {
    ok: errors.length === 0,
    solids: solidItems,
    params: paramItems,
    materials: materialItems,
    counts,
    errors,
    candidate,
    appliedPartIndices: errors.length === 0 ? appliedPartIndices : [],
  };
}

/** Validate and apply a solid transfer in-place on `destination` (for one `edit(d => ...)` undo step).
 *  Throws `SolidTransferError` without mutating `destination` if any validation check fails. */
export function applySolidTransfer(
  destination: Design,
  payload: SolidTransferPayload,
  options: SolidTransferOptions = {},
): SolidTransferPreview {
  const snapshot = clone(destination);
  const preview = previewSolidTransfer(payload, snapshot, options);
  if (!preview.ok || !preview.candidate) {
    const first = preview.errors[0] ?? { code: "invalid-structure" as const, message: "Solid import validation failed." };
    throw new SolidTransferError(first.message, preview.errors.length ? preview.errors : [first]);
  }
  destination.params = clone(preview.candidate.params);
  destination.materials = clone(preview.candidate.materials);
  destination.parts = clone(preview.candidate.parts);
  if (preview.candidate.components !== undefined) {
    destination.components = clone(preview.candidate.components);
  }
  return preview;
}

// Re-export nameMap helper reference so unused-import linters stay clean while keeping prototype-free maps handy.
export { nameMap };
