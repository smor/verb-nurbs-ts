# Fairing

`Fair` makes a non-rational B-spline curve or surface smoother, keeping it close to where it was and keeping its
ends or boundary. Degrees and knots are kept; only free control points move.

```js
const smooth = Fair.curve(curve, { smoothness: 100, order: 3, keep: 1 });     // G1 ends
const plate = Fair.surface(surface, { smoothness: 1, keep: 1 });            // boundary and cross tangents kept
Fair.curvatureExtrema(smooth);     // a fair curve has few
```

## What is minimised

The deviation from the given control points plus `smoothness` times an energy:

| | Energy | Order |
|---|---|---|
| curves | ∫ \|C⁽ʳ⁾(u)\|² du | `order` 3 (default): minimum variation of curvature, after Moreton and Séquin; 2: bending |
| surfaces | ∫ \|S_uu\|² + 2\|S_uv\|² + \|S_vv\|² | the thin plate |

Both energies are quadratic in the control points through the Gram matrices of the basis functions' derivatives.
These are integrated exactly by Gauss-Legendre quadrature on each knot span, so each fairing is one linear solve. Curves
use dense LU. Surfaces use conjugate gradients on the thin plate's Kronecker sum of the two directions' Gram matrices,
which is never formed. `smoothness` is scaled by the energy's mean diagonal, so a value does the same on any curve.

## Ends and boundaries

`keep` fixes `keep + 1` control points at each end, or rows along each side:

* 0: the point or curve (G0);
* 1: the tangent too (G1);
* 2: the curvature too (G2).

A surface's `sides` choose which sides are kept (u = 0, u = 1, v = 0, v = 1). A free side moves with the rest.

## Measures

* `Fair.curvatureExtrema`: the number of turns of the curvature, ignoring wiggles below a tolerance. A fair curve has
  few, after Farin, *Curves and Surfaces for CAGD*, chapter 23.
* `Fair.curvature`: the curvature, with arc length, for combs.
* `Fair.curveEnergy` and `Fair.surfaceEnergy`: the energies above.

On one period of a sine through 41 points with 0.15 of noise, the fitted curve has 51 curvature extrema. Faired with
smoothness 1000, order 3 and G1 ends, it has 4 (a clean sine has 3), and stays within 0.25 of the clean sine. On a
noisy dome, the thin plate at smoothness 1 brings the surface 23% nearer, in RMS, to the dome the noise was added to.

## Limits

* Non-rational only: every weight must be 1.
* The energies are parametric. They track geometric fairness where the parametrisation is near arc length, as it is
  for chord-length fits.
* Too much smoothness flattens real features (a dome sinks towards the plate its boundary spans). Keep it to the size
  of the noise.

References:

* H. P. Moreton and C. H. Séquin, "Functional optimization for fair surface design", SIGGRAPH 1992.
* G. Greiner, "Variational design and fairing of spline surfaces", *Computer Graphics Forum* 13(3), 1994.
