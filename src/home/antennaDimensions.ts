/** Starting dimensions, not simulated performance. See docs/ANTENNA-CALCULATOR.md. */
export type AntennaKind = 'dipole' | 'folded_dipole' | 'monopole' | 'ground_plane' | 'yagi' | 'patch';
export interface CalculatorInput { kind: AntennaKind; frequencyGHz: number; shortening: number; epsilonR: number; heightMm: number }
export interface AntennaDimensions {
  wavelengthMm: number;
  lengthMm: number;
  armMm?: number;
  spacingMm?: number;
  radialMm?: number;
  reflectorMm?: number;
  directorMm?: number;
  reflectorSpacingMm?: number;
  directorSpacingMm?: number;
  boomMm?: number;
  widthMm?: number;
  effectivePermittivity?: number;
  fringeMm?: number;
}
export type CalculatorError = 'frequency' | 'shortening' | 'substrate' | 'thickness';
export type CalculatorResult = { ok: true; dimensions: AntennaDimensions } | { ok: false; error: CalculatorError };

const ASSUMPTIONS: Record<AntennaKind, string> = {
  dipole: 'Free-space half-wave total length; shortening factor explicitly selected; feed gap not included.',
  folded_dipole: 'Free-space half-wave two-conductor folded loop (0.01 wavelength center spacing, ~292 ohm nominal thin-wire impedance); shortening factor explicitly selected; starting dimensions only, not simulated or matched.',
  monopole: 'Quarter-wave estimate above ideal infinite PEC ground; shortening factor explicitly selected.',
  ground_plane: 'Free-space quarter-wave vertical radiator with four horizontal quarter-wave radials; shortening factor explicitly selected; starting dimensions only, not simulated or matched to 50 ohm.',
  yagi: 'Free-space 3-element Yagi-Uda textbook starting ratios (0.495/0.473k/0.440 wavelength elements, 0.20/0.15 wavelength spacings); shortening factor applied to driven element; starting dimensions only, not simulated or matched.',
  patch: 'Thin uniform substrate; rectangular TM10 transmission-line estimate; feed and finite ground not solved.',
};

export function antennaDimensions(input: CalculatorInput): CalculatorResult {
  const { kind, frequencyGHz: f, shortening: k, epsilonR: er, heightMm: h } = input;
  if (!Number.isFinite(f) || f < 0.000001 || f > 1000) return { ok: false, error: 'frequency' };
  const wavelengthMm = 299.792458 / f;
  if (kind !== 'patch') {
    if (!Number.isFinite(k) || k < .5 || k > 1) return { ok: false, error: 'shortening' };
    if (kind === 'dipole') {
      const lengthMm = wavelengthMm * k / 2;
      return { ok: true, dimensions: { wavelengthMm, lengthMm, armMm: lengthMm / 2 } };
    }
    if (kind === 'folded_dipole') {
      return { ok: true, dimensions: { wavelengthMm, lengthMm: wavelengthMm * k / 2, spacingMm: 0.01 * wavelengthMm } };
    }
    if (kind === 'monopole') {
      return { ok: true, dimensions: { wavelengthMm, lengthMm: wavelengthMm * k / 4 } };
    }
    if (kind === 'ground_plane') {
      const lengthMm = wavelengthMm * k / 4;
      return { ok: true, dimensions: { wavelengthMm, lengthMm, radialMm: lengthMm } };
    }
    const reflectorSpacingMm = 0.2 * wavelengthMm, directorSpacingMm = 0.15 * wavelengthMm;
    return {
      ok: true,
      dimensions: {
        wavelengthMm,
        lengthMm: 0.473 * k * wavelengthMm,
        reflectorMm: 0.495 * wavelengthMm,
        directorMm: 0.44 * wavelengthMm,
        reflectorSpacingMm,
        directorSpacingMm,
        boomMm: reflectorSpacingMm + directorSpacingMm,
      },
    };
  }
  if (!Number.isFinite(er) || er < 1 || er > 20 || !Number.isFinite(h) || h <= 0) return { ok: false, error: 'substrate' };
  const widthMm = wavelengthMm / 2 * Math.sqrt(2 / (er + 1));
  // Limit this transmission-line estimate to thin substrates and W/h >= 1.
  if (h > wavelengthMm / (20 * Math.sqrt(er)) || widthMm / h < 1) return { ok: false, error: 'thickness' };
  const effectivePermittivity = (er + 1) / 2 + (er - 1) / (2 * Math.sqrt(1 + 12 * h / widthMm));
  const fringeMm = .412 * h * (effectivePermittivity + .3) * (widthMm / h + .264) / ((effectivePermittivity - .258) * (widthMm / h + .8));
  const lengthMm = wavelengthMm / (2 * Math.sqrt(effectivePermittivity)) - 2 * fringeMm;
  if (!(lengthMm > 0) || !Number.isFinite(lengthMm)) return { ok: false, error: 'thickness' };
  return { ok: true, dimensions: { wavelengthMm, widthMm, lengthMm, effectivePermittivity, fringeMm } };
}

export function calculatorRecord(input: CalculatorInput) {
  const result = antennaDimensions(input);
  if (!result.ok) throw Error(result.error);
  const inputs = { kind: input.kind, frequencyGHz: input.frequencyGHz,
    ...(input.kind === 'patch' ? { epsilonR: input.epsilonR, heightMm: input.heightMm } : { shortening: input.shortening }) };
  return { schema: 'fairbeam.antenna-estimate/1', inputs, dimensions: result.dimensions,
    units: { frequency: 'GHz', length: 'mm' }, simulated: false,
    assumptions: ASSUMPTIONS[input.kind] };
}
