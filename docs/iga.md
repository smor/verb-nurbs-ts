# Isogeometric analysis

`IGA` solves the Poisson equation, -Δu = f with u = g on the boundary, on a planar domain given exactly by a NURBS
surface. The solution lives in a spline space of that same parameter rectangle (Hughes, Cottrell and Bazilevs,
CMAME 194, 2005). The domain is exact at every refinement, and there is no mesh to generate.

```js
const geometry = Make.loftedSurface([Make.arc(O, X, Y, 1, 0, Math.PI / 2), Make.arc(O, X, Y, 2, 0, Math.PI / 2)], 1);
const s = IGA.poisson({ geometry, space: THB.space([2, 2], breaks, breaks), source: (x, y) => f, boundary: (x, y) => g });
IGA.value(s, [u, v]);                       // { x, y, u, grad }
IGA.errors(s, exact, exactGradient);        // { l2, h1 }
IGA.estimate(s);                            // a residual indicator per cell
const rounds = IGA.adaptive(problem, { steps: 10, fraction: 0.5 });   // solve, estimate, mark, refine
```

## Method

* **Space.** The space is THB-splines on the parameter rectangle ([thb.md](thb.md)), pushed forward by the geometry
  map. A one-level space is an ordinary tensor-product B-spline space. More levels refine locally, as in Buffa and
  Giannelli, "Adaptive isogeometric methods with hierarchical splines", M3AS 26 (2016).
* **Galerkin.** The stiffness entries are ∫ ∇R_i · ∇R_j, and the load entries are ∫ f R_i. Each integral uses
  Gauss-Legendre on the cells of the hierarchy that no finer cell covers. Every function is one polynomial on such
  a cell. Each direction gets one point more than the degree needs, for the rational map.
* **Boundary values** are imposed strongly. The functions that do not vanish on the boundary take the least-squares
  fit of g along the four sides. The remaining system is symmetric positive definite and is solved by conjugate
  gradients.
* **Estimator.** The indicator per cell is η_K² = h_K² ∫_K (f + Δu_h)². Splines of degree 2 or more are C¹ across
  cells, so there are no flux jumps. Δu_h in x and y uses the Hessians of the functions and of the map:
  H_x = J⁻ᵀ (H_uv − Σ_k ∂u/∂x_k H_uv(x_k)) J⁻¹.
* **Adaptivity.** Cells are marked by Dörfler's rule: the largest indicators that make up `fraction` of the estimate.
  The marked cells are refined.

## How it is checked (test/testIGA.cjs)

* **Optimal convergence** on the quarter annulus, with u = (r² − 1)(r² − 4) x y. The rates, from 8 × 8 to 16 × 16
  cells, are:

  | Degree | L2 | H1 |
  |---|---|---|
  | 2 | 3.03 | 2.01 |
  | 3 | 4.04 | 2.96 |

  The optimal rates are p + 1 and p.
* **Patch test.** A linear solution is reproduced to 1e-9 on a bilinear quadrilateral, with its boundary values.
* **Estimator.** η / ‖∇(u − u_h)‖ stays between 5 and 30 under refinement, and varies by less than 1.5 times.
* **Adaptivity.** The test problem is an internal layer, u = atan(60 (r − 1.5)). After 10 rounds the H1 error is
  below that of uniform level 2 (324 functions), with less than half the functions.

  Run longer, the gap grows:

  | | Functions | H1 error |
  |---|---|---|
  | Adaptive, 13 rounds | 392 | 0.46 |
  | Uniform | 4356 | 0.47 |
  | Adaptive, 18 rounds | 2077 | 0.099 |

## Limits (next steps)

* **Poisson only, on one planar patch.** The next steps are:
  - elasticity, through a vector field and a different bilinear form;
  - shells, on a surface rather than the plane;
  - several patches, glued along shared edges.
* **Geometry and solution are refined separately.** The geometry map stays as it is, and only the solution space is
  refined. This is exact for the domain, but not isoparametric.
* **Linear solver.** Jacobi-preconditioned CG is fine up to a few thousand functions. Multigrid would scale further.
