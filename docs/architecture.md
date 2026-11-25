# Architecture

This guide is for an engineer taking over the code. It explains how the library is layered, how data moves
through it, which invariants hold everywhere, and where to start reading for each feature.

## The layers

```
                 ┌───────────────────────────────────────────────┐
   apps          │ viewer/ playground/   (three.js, web workers) │
                 └───────────────────────▲───────────────────────┘
                 ┌───────────────────────┴───────────────────────┐
   view          │ Inspect: objects → plain display layers       │
                 └───────────────────────▲───────────────────────┘
                 ┌───────────────────────┴───────────────────────┐
   recipes       │ parametric objects (vessels, mug, appliance)  │
                 └───────────────────────▲───────────────────────┘
                 ┌───────────────────────┴───────────────────────┐
   solid         │ Brep, SurfaceIntersect, BrepBoolean, Fillet,  │
                 │ FilletCorner, BrepEdges, Shell                │
                 │ TriMesh, MeshBVH, Makeable  (mesh side)       │
                 └───────────────────────▲───────────────────────┘
                 ┌───────────────────────┴───────────────────────┐
   geom          │ NurbsCurve, NurbsSurface, primitives          │
                 └───────────────────────▲───────────────────────┘
                 ┌───────────────────────┴───────────────────────┐
   core + eval   │ data types, Vec/Mat, evaluation, fitting,     │
                 │ intersection, tessellation, sweeps, offsets,  │
                 │ transfinite patches                           │
                 └───────────────────────────────────────────────┘
```

Imports only point down. `docs/packages.md` records how these layers become separate packages, and the rules
that keep that split possible. `npm run layers` (`scripts/check-layers.mjs`) enforces it on every commit and in
CI, so a wrong import fails the build rather than waiting for a reviewer to spot it.

## Data model

* **Plain data at the bottom.** `NurbsCurveData` and `NurbsSurfaceData` (`src/core/Data.ts`) hold the degree,
  knots and **homogeneous** control points (`[w·x, w·y, w·z, w]`). Every function in `eval/` is a static, pure
  function of that data, which is what lets the worker dispatcher (`exe/`) run any of them off the main thread.
* **Objects for convenience.** `geom/` wraps the data in classes (`NurbsCurve`, `NurbsSurface`, `Circle`, ...)
  with methods and `…Async` variants. Nothing below `geom/` depends on these wrappers.
* **B-reps.** A `BrepSolid` (`src/solid/Brep.ts`) is a list of `BrepFace`s. Each face is a NURBS surface plus
  trim loops in its own (u, v) domain. Neighbouring faces share seams **vertex for vertex**. This is the invariant
  that makes every tessellated result watertight without welding.
* **Meshes.** `TriMesh` is an indexed triangle mesh. It is the only output that leaves the library for
  fabrication (STL/OBJ, manifold-3d).

## How a Boolean with fillets runs

1. **Surface/surface intersection** (`SurfaceIntersect`): seed points from a subdivision of both faces, march
   each branch, and refine every point onto both surfaces to about 1e-9.
2. **Trimming** (`BrepBoolean`): branches become trim curves in each face's domain. Faces are split, and every
   piece is classified as inside or outside the other solid.
3. **Fillets** (`Fillet`): along each new edge, a rolling ball traces contact curves on both faces. The cross-section
   is a circular arc (G1), a curvature-matching quintic (G2), or a chamfer line. The radius may vary along the edge.
4. **Corners** (`FilletCorner`): where three fillets meet, a sphere triangle (equal radii, convex) or a setback
   patch (any radii, mixed convexity). Setback patches are six-sided transfinite surfaces (`eval/Transfinite.ts`),
   exported as six four-sided B-spline surfaces.
5. **Own edges** (`BrepEdges`): a solid's existing edges can be filleted too, alone or together with the
   Boolean's new edges.
6. **Tessellation**: each face is meshed inside its trims with constrained Delaunay triangulation (cdt2d), sharing
   seam vertices with its neighbours. The result is checked as a closed 2-manifold.

`docs/booleans.md` describes each step's method, its checks and its known limits.

## Invariants worth protecting

* **Watertightness by construction.** Two faces that meet always use the same seam points. Never weld afterwards
  to hide a gap. A gap means a seam was built twice.
* **Tolerance flows down.** Public entry points take a `tol` and pass it on. Don't add new magic epsilons; use
  `Constants` or a parameter.
* **Makeable is opt-in.** Free-form, open or self-crossing geometry is legal. `Makeable.check` decides whether a
  mesh can be fabricated on a given machine.
* **No rendering in the library.** `view/Inspect` returns plain arrays. three.js lives only in `viewer/` and
  `playground/`.

## Where to start reading

| You want to change | Start in |
|---|---|
| NURBS evaluation, knots, derivatives | `src/eval/Eval.ts`, `src/eval/Modify.ts` |
| Fitting, lofting, approximation | `src/eval/Fit.ts` |
| Sweeps, rotation-minimising frames | `src/eval/Sweep.ts` |
| Offsets | `src/eval/Offset.ts` |
| n-sided patches | `src/eval/Transfinite.ts` |
| Surface/surface intersection | `src/solid/SurfaceIntersect.ts` |
| Booleans | `src/solid/BrepBoolean.ts` |
| Fillets, chamfers | `src/solid/Fillet.ts` |
| Vertex blends | `src/solid/FilletCorner.ts` |
| Meshes, fabrication checks | `src/solid/TriMesh.ts`, `src/solid/Makeable.ts` |
| Display data | `src/view/Inspect.ts` |

## Tests

Tests are mocha specs in `test/*.cjs` that run against the built `dist/`. Geometry tests check **properties**,
not snapshots. Examples: a fillet's volume against Pappus' theorem, normals that agree across a seam to a stated
tolerance, a Boolean's result accepted by manifold-3d. Follow that style. A new feature comes with a test that
states the geometric property it guarantees.

## Code style

* TypeScript `strict` (including `strictNullChecks`), ESLint with `typescript-eslint` (`npm run lint`).
* Functions that can fail return `null` and say so in their type (`T | null`). Callers check.
* The code from upstream verb keeps its original layout and comments. New code uses the same spacing so diffs
  stay readable.
* Comments explain *why* and cite the method: paper, section, or the property being guaranteed.
