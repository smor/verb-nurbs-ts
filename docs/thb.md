# THB-splines: local refinement

A tensor-product B-spline surface can only gain detail along whole knot lines, across the entire surface. `THB`
refines where it is needed: truncated hierarchical B-splines (THB-splines) on nested domains.

```js
let S = THB.space([3, 3], [0, 0.25, 0.5, 0.75, 1], [0, 0.25, 0.5, 0.75, 1]);   // bicubic, 4 × 4 cells
S = THB.refineWhere(S, 0, (u0, u1, v0, v1) => u0 < 0.5 && v0 < 0.5);          // halve the spans in one corner
const B = THB.basis(S);                       // the truncated basis
const P = THB.fit(B, samples);                // least-squares control points, one per function
const surface = THB.surface(B, P);            // the same surface, exactly, as a B-spline of the finest level

// or let the shape decide where to refine
const { space, basis, points, error } = THB.adaptiveFit(THB.space([3, 3], quarters, quarters), samples, { tolerance: 1e-3 });
```

## How it works

* **Levels.** Level 0 is a tensor-product B-spline space on the given breakpoints. Each level l + 1 halves level l's
  spans (dyadic refinement) and lives on a subdomain Ω_{l+1} ⊆ Ω_l, a union of cells of level l
  (`space.omega[l]`, a mark per cell). `refine` adds cells of a level to the next level's domain.
* **Active functions** follow Kraft (1997). A B-spline of level l is active when its support lies in Ω_l but not in
  Ω_{l+1}. These functions are linearly independent and span nested spaces.
* **Truncation** follows Giannelli, Jüttler and Speleers, "THB-splines: the truncated basis for hierarchical splines",
  CAGD 29 (2012):
  * Each active function is written in the next level's B-splines, using the two-scale relation computed by knot
    insertion (Boehm).
  * The parts on B-splines whose support lies in Ω_{l+1} are dropped.
  * The same is repeated at each finer level.

  The truncated functions:
  * are non-negative;
  * sum to one (a partition of unity, so the surface lies in the convex hull of its control points);
  * stay linearly independent;
  * span the same space as Kraft's;
  * overlap less.
* **Exact conversion.** Each function is stored as its coefficients in the finest level's B-splines. A THB surface is
  therefore exactly a B-spline surface of the finest level (`surface`). Evaluation, tessellation, intersection,
  fairing and export all work on it unchanged.
* **Fitting.** `fit` solves the least-squares normal equations by preconditioned conjugate gradients. A tiny ridge
  (1e-9 of the diagonal) keeps functions that few samples see in check. `transfer` moves a surface to a finer
  hierarchy exactly, since the spaces are nested. `adaptiveFit` works in rounds:
  1. Fit.
  2. Refine the deepest cell holding each sample that misses the tolerance, together with its neighbours in that
     level's domain.
  3. Fit again. Stop when every sample is within the tolerance, or the deepest level is reached.

## How it is checked (test/testTHB.cjs)

* **Partition of unity and non-negativity.** For degrees 2 and 3, on three levels refined towards a corner and then
  round a point, at 1500 points: the functions sum to 1 within 1e-12 and none is negative.
* **Linear independence.** The Gram matrix of the functions' finest coefficients is positive definite: every
  Cholesky pivot is above 1e-6.
* **Supports.** A refined inner cell is too small to hold a level-1 cubic, so the space stays level 0's 49 functions.
  A refined corner cell holds 4 level-1 cubics, because the open knots shrink supports there.
* **Nestedness.** A surface refined elsewhere and transferred keeps its shape within 1e-9.
* **Exact conversion.** The THB sum equals the finest-level B-spline surface within 1e-12.
* **Adaptive fitting.** A sharp ridge (a tanh step of width 0.03 along a sine curve) is fitted within 2e-3, using
  less than half the functions of the coarsest uniform refinement that reaches the same tolerance.

  At 1e-3 on a finer sample grid (161 × 161, a 0.015 step), the gap is wider: 3508 functions against 17161 for
  uniform level 5. Uniform level 4 (4489 functions) still misses, at 3.2e-3.

## Limits (next steps)

* **Admissibility is not enforced.** Buffa and Giannelli's admissible meshes bound how many levels overlap at a point,
  and with it the condition number and the locality of refinement. The adaptive fit refines a cell's neighbours,
  which keeps meshes graded in practice, but nothing checks it.
* **Non-rational only.** Weights would need a rational THB (a weight function in the same space).
* **No T-splines.** THB-splines cover the same need (local refinement with a partition of unity and linear
  independence) and nest exactly. Analysis-suitable T-splines are left out.
