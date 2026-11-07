/** Display units. A design always stores lengths in mm and frequencies in GHz; the user can pick
 * other units for showing and typing them. A design may save its own choice (`units` in the design
 * file; the status bar's "mm · GHz" menu and the design's Properties set it); Settings holds the
 * default, used for new designs and for designs that have no choice of their own. A plain number
 * typed in a length or frequency field is read in the chosen unit and stored converted; a number
 * with a unit ("1 cm", "7.1 MHz") is read in that unit whatever the choice. Expressions (w/2,
 * f0*0.6) stay as typed: parameters hold canonical mm and GHz values. */
import { createSignal } from "solid-js";

export const LENGTH_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, mil: 0.0254 } as const;
export const FREQUENCY_UNITS = { kHz: 1e-6, MHz: 1e-3, GHz: 1 } as const;
export type LengthUnit = keyof typeof LENGTH_UNITS;
export type FrequencyUnit = keyof typeof FREQUENCY_UNITS;
export interface DisplayUnits { length: LengthUnit; frequency: FrequencyUnit }

export const DISPLAY_UNITS_KEY = "fairbeam.displayUnits";
export const CANONICAL: DisplayUnits = { length: "mm", frequency: "GHz" };

/** The valid parts of a stored choice (a design file or the Settings value): unknown units are dropped. */
export function validUnits(v: unknown): Partial<DisplayUnits> {
  const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: Partial<DisplayUnits> = {};
  if (typeof x.length === "string" && Object.hasOwn(LENGTH_UNITS, x.length)) out.length = x.length as LengthUnit;
  if (typeof x.frequency === "string" && Object.hasOwn(FREQUENCY_UNITS, x.frequency)) out.frequency = x.frequency as FrequencyUnit;
  return out;
}

function read(): DisplayUnits {
  try {
    return { ...CANONICAL, ...validUnits(JSON.parse(localStorage.getItem(DISPLAY_UNITS_KEY) ?? "{}")) };
  } catch {
    return { ...CANONICAL };
  }
}

const [defaults, setDefaultsSignal] = createSignal<DisplayUnits>(read());
/** The Settings default: new designs, and designs without their own choice. */
export const defaultUnits = defaults;
export function setDefaultUnits(next: Partial<DisplayUnits>): void {
  const value = { ...defaults(), ...next };
  setDefaultsSignal(value);
  try { localStorage.setItem(DISPLAY_UNITS_KEY, JSON.stringify(value)); } catch { /* optional storage */ }
}

// The open design's own choice, registered by the designer store (no design open: null).
let designGet: () => Partial<DisplayUnits> | null = () => null;
let designSet: ((u: DisplayUnits) => void) | null = null;
export function registerDesignUnits(get: () => unknown | null, set: (u: DisplayUnits) => void): void {
  designGet = () => { const v = get(); return v === null ? null : validUnits(v); };
  designSet = set;
}

/** The units in effect: the open design's choice over the Settings default. */
const units = (): DisplayUnits => ({ ...defaults(), ...(designGet() ?? {}) });
export const displayUnits = units;
/** A design is open: the status bar menu changes that design's units (saved with it). */
export const designUnitsOpen = () => designGet() !== null;

/** Pick units where they apply: the open design (an edit, saved with it), else the Settings default. */
export function setDisplayUnits(next: Partial<DisplayUnits>): void {
  if (designSet && designGet() !== null) designSet({ ...units(), ...next });
  else setDefaultUnits(next);
}

type Kind = "length" | "frequency";
/** The kind of a canonical unit label: "mm" is a length, "GHz" a frequency, anything else neither. */
export function kindOf(canonical: string | undefined): Kind | null {
  return canonical === "mm" ? "length" : canonical === "GHz" ? "frequency" : null;
}

const factor = (kind: Kind, unit: string): number | undefined =>
  kind === "length" ? (LENGTH_UNITS as Record<string, number>)[unit] : (FREQUENCY_UNITS as Record<string, number>)[unit];

/** The unit label shown for a field whose canonical unit is `canonical` ("mm" → "cm"). */
export function shownUnit(canonical: string | undefined, u: DisplayUnits = units()): string | undefined {
  const kind = kindOf(canonical);
  return kind ? u[kind] : canonical;
}

const tidy = (x: number) => Number(x.toPrecision(15));

/** A canonical number in the chosen unit (10 mm → 1 in cm); other values unchanged. */
export function toShown(value: number, canonical: string | undefined, u: DisplayUnits = units()): number {
  const kind = kindOf(canonical);
  if (!kind) return value;
  return tidy(value / factor(kind, u[kind])!);
}

const NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const WITH_UNIT = new RegExp(`^(${NUMBER})\\s*([A-Za-z]+)?$`);
const UNIT_ALIASES: Record<string, string> = { mm: "mm", cm: "cm", m: "m", in: "in", inch: "in", mil: "mil", khz: "kHz", mhz: "MHz", ghz: "GHz" };

/** Typed text of a length or frequency field as stored: a number (with an optional unit of the
 * field's kind) becomes the canonical number; anything else is returned unchanged for the caller's
 * own parsing (an expression, or an unknown unit, which then reads as an unknown name). */
export function fromTyped(text: string, canonical: string | undefined, u: DisplayUnits = units()): number | null {
  const kind = kindOf(canonical);
  if (!kind) return null;
  const m = WITH_UNIT.exec(text.trim().replace(",", "."));
  if (!m) return null;
  const unit = m[2] ? UNIT_ALIASES[m[2].toLowerCase()] : u[kind];
  const f = unit === undefined ? undefined : factor(kind, unit);
  if (f === undefined) return null;
  return tidy(Number(m[1]) * f);
}

/** A parameter's unit label as stored: any length unit is saved as "mm" and any frequency unit as
 * "GHz", because the value itself is always in those units (the label then shows the chosen unit);
 * other labels (Ω, deg, a note) are kept as typed. */
export function storedUnitLabel(typed: string): string {
  // case matters for lengths ("M" is not meters); frequencies are read in any case (mhz, MHz)
  const x = typed.trim();
  if (Object.hasOwn(LENGTH_UNITS, x) || x === "inch") return "mm";
  if (["khz", "mhz", "ghz"].includes(x.toLowerCase())) return "GHz";
  return typed;
}
