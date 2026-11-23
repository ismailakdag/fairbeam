# Antenna starting dimensions

Open **Antenna starting dimensions** on the Start screen. It works offline and
does not start a simulation. Choose a half-wave dipole, half-wave folded dipole,
quarter-wave monopole, quarter-wave ground-plane (4 radials), 3-element
Yagi-Uda, or rectangular patch, enter frequency in GHz and read dimensions in mm.
Export estimate (JSON) retains the inputs, dimensions, units, `simulated: false`
and assumptions. The file is an estimate record, not a runnable Design.

With the run server connected, **Create editable design** opens a new Design from
the current inputs. An existing unsaved design still gets the normal Save / Don't
save / Cancel prompt. Creation starts a geometry preview, not a simulation. The
frequency and dimensions remain editable parameters; repeated creation chooses
a free file name rather than replacing an existing design. Below `0.1 GHz`,
created drafts set display units to `m` and `MHz`; at `0.1 GHz` and above they
use `mm` and `GHz` (canonical stored values remain `mm` and `GHz`).

## Classical wire and strip starting families

The free-space wavelength is `299.792458 / f_GHz` mm. The adjustable length
factor `k` (`0.5 <= k <= 1`) defaults to `0.95` as an explicit starting
assumption, not a universal measured correction. Feed gaps, conductor width or
radius, mutual coupling, surroundings, insulation and finite ground all change
the final design.

- **Half-wave dipole (`dipole`):** total tip-to-tip length `0.5 * k * wavelength`;
  each arm is `L / 2`. The draft builds two PEC strips (`width = wavelength / 125`)
  separated by a center feed gap (`wavelength / 125`, included in `L`) with an
  unmatched `50 Ω` discrete port.
- **Half-wave folded dipole (`folded_dipole`):** total loop length
  `0.5 * k * wavelength` and parallel conductor center-to-center spacing
  `s = 0.01 * wavelength` (`~292 Ω` thin-wire free-space nominal impedance).
  The draft builds two parallel PEC strips (`width = s / 3`) joined by end
  bridges with an unmatched `300 Ω` discrete port across the center feed gap.
- **Quarter-wave monopole (`monopole`):** radiator length `0.25 * k * wavelength`
  assuming an ideal infinite PEC ground plane. The draft uses a PEC strip above
  a finite square PEC ground `0.8 * wavelength` wide with an unmatched `50 Ω`
  discrete port across the base gap, so it differs from the infinite-ground
  estimate.
- **Quarter-wave ground-plane (`ground_plane`):** vertical radiator length
  `0.25 * k * wavelength` and four orthogonal horizontal radial lengths
  `0.25 * k * wavelength` in free space. Horizontal radials yield a lower feed
  resistance than `50 Ω`; the draft places an unmatched `50 Ω` discrete port
  between the central radial hub and the vertical radiator base so radial length
  and radiator height can be tuned.
- **3-element Yagi-Uda (`yagi`):** free-space textbook starting ratios along `+x`:
  reflector `0.495 * wavelength`, driven element `0.473 * k * wavelength`,
  director `0.440 * wavelength`, reflector-to-driven spacing `0.20 * wavelength`,
  driven-to-director spacing `0.15 * wavelength`, and total boom length
  `0.35 * wavelength`. The draft builds parameterized PEC strips with an
  unmatched `50 Ω` discrete port across the driven element's center gap so
  element lengths and spacings can be swept or optimized in the designer.

## Rectangular patch starting dimensions

The patch estimate uses the rectangular TM10 transmission-line formulas:

```
W = wavelength / 2 * sqrt(2 / (epsilon_r + 1))
epsilon_eff = (epsilon_r + 1)/2 + (epsilon_r - 1)/(2*sqrt(1 + 12*h/W))
delta_L = 0.412*h*(epsilon_eff + 0.3)*(W/h + 0.264) /
          ((epsilon_eff - 0.258)*(W/h + 0.8))
L = wavelength / (2*sqrt(epsilon_eff)) - 2*delta_L
```

Reference: IIT Bombay's [Virtual Electromagnetics Laboratory formulas](https://www.ee.iitb.ac.in/course/~vel/apps/RMSA/Pages/RMSA_Formulae.html),
which cite Balanis, *Antenna Theory*, third edition. Fairbeam's patch starter
already uses these equations. The calculator implements them independently of
the run server, with a conservative thin-substrate admission boundary:
`1 <= epsilon_r <= 20`, positive `h <= wavelength/(20*sqrt(epsilon_r))`, and
`W/h >= 1`. Outside that boundary it requests a full model instead of showing
unqualified dimensions. This boundary is an application restriction, not a
claim that the approximation is exact inside it. Patch drafts use a lossless
substrate, a finite PEC ground, and an editable discrete probe port at `L/3`
from the center.

Frequency is limited to 1 kHz–1 THz; the length factor is 0.5–1. Empty, nonfinite
and out-of-range inputs hide results and disable export. Inputs and exported
numbers use decimal points in both English and Turkish.

These calculations do not solve a feed, matching, losses, radiation, bandwidth,
mutual coupling, finite-ground effects or manufacturing constraints. Inspect the
geometry and check mesh and domain convergence before relying on simulated
results.
