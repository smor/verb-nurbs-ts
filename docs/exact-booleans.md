# Plan: Booleans on any solid, rounded ones included

Status: A1 and A2 built (below); the rest is a plan. When a step lands, its section says so and points to the code and the
tests.

## The goal

A commercial kernel (Parasolid, ACIS, Open CASCADE) lets any solid be an operand of any operation: fillet a part,
then drill it; union two rounded parts; round an edge between a fillet and a face. Ours cannot yet. `BrepBoolean`
takes **primitives**, closed solids whose faces are whole NURBS surfaces, and evaluates a whole CSG tree in one pass
over them, fillets included (docs/booleans.md). Its result has **trimmed** faces and blends, so it cannot be fed back
in. `Model` lives with it by making a round the last feature (docs/model.md, "Limits").

Two routes lead to Booleans on any solid. This plan takes both, in order:

* **Route A, Booleans on trimmed B-reps.** Operands are B-reps whose faces are trimmed NURBS surfaces with exact
  edges between them, like the result. This is what commercial kernels do, and it keeps everything exact. It comes
  first.
* **Route B, watertight untrimming.** A trimmed result is rebuilt as a gap-free set of untrimmed spline patches
  (hierarchical, THB, where detail is needed). Such a solid is good for analysis (IGA) and exchange. It comes second,
  on top of A.

Both follow the project's rule, "exact geometry first" (AGENTS.md): meshes stay search aids and outputs.

## What we have to build on

More than it seems. The Boolean already works the way boundary evaluation does (Requicha and Voelcker, "Boolean
operations in solid modeling: boundary evaluation and merging algorithms", Proc. IEEE 73(1), 1985): intersect faces,
split them along the branches, classify the pieces, keep those on the result's boundary. What ties it to primitives
is narrower:

| Part | Today | For trimmed operands |
|---|---|---|
| Faces of the result | operands' faces: surface + loops in `(u, v)` (polylines) | the same |
| Fillets and corners | real NURBS surfaces (`FilletResult.surface`, corner patches), but no loops: `loops : []`, `cornerUV` null, meshed in space | trimmed faces like the others |
| Edges | implicit in the welded mesh; recovered and fitted exactly only by `Step.write` (docs/step.md) | explicit, exact, shared by two faces |
| Intersection | whole face against whole face; branches run to the domain's sides | clipped to each face's trim loops; branches end on the operand's edges |
| Splitting faces | a grid plus constrained Delaunay, cuts as constraints | the same, with the face's own trim loops as constraints too |
| Classification | exact at seams, ray parity against the other operand's mesh elsewhere | the same (any closed mesh works) |
| Edges of an operand that branches cross | domain sides only (`BrepEdges`) | any edge: a triple point of the branch with the edge's two faces (step 2 of the pipeline already solves F = G = H) |

## Route A, step by step

Each step is a pull request with its own tests, and leaves the library working.

### A1. Every face of a result is a trimmed NURBS face

Fillets and corners get what operands' faces have: their loops in their own `(u, v)`, and parameters for every
triangle (`cornerUV`). A blend is already parameterised across and along its edge, and its mesh is triangulated in
that rectangle, so its loops are its two contact curves and its end trims mapped into it. Ball corners lie on a
sphere patch; setback corners on six B-spline pieces. Corners stop being "meshed in space".

Tests: for every triangle of a rounded box and of the filleted mug, the surface evaluated at its corner parameters
gives the mesh vertex to 1e-9; every face's loops are closed and bound the face's triangles.

Built: `BrepBoolean.evaluate` gives blends and corners their `cornerUV` and `loops` (`FilletResult.uv`,
`CornerPatch.uv` and `parts[k].uv`, `Transfinite.quadParameters`); test "gives every face of a rounded solid its
trimmed NURBS surface" in `test/testFillet.cjs`. What it measures: closed blends 1e-14 (the filleted mug), open blends
4e-9 (their trim points lie between the lofted sections, so 1e-8 is the bound tested), ball corners 3e-9; setback
corners within 1e-3 of their radius, the tolerance their six B-spline parts are fitted to (`patchXY` keeps the exact
patch). The loops enclose the triangles' area in `(u, v)` to 1e-9. On the way: a loft gives every column of control
points the same v (Piegl and Tiller, eq. 9.8; each column had its own and the last one's knots, which made the
closed blends' surfaces wrong, NaN for some), a sphere keeps its poles when the axis is a rounding error off them, and
the closest point on a surface is found on its edges.

### A2. Exact topology: shells with vertices, edges and loops

A `BrepShell` type: faces (surface, loops), edges (an exact 3D curve and a p-curve on each of its two faces, a
tolerance), vertices. Built from a Boolean result by moving the edge recovery that `Step.write` does today (welded
mesh runs, refined onto both faces, fitted) from `io/` down into `solid/`, and adding the p-curves. `Step.write`
then writes the shell as it is.

Tolerances are local, as in Parasolid: an edge carries the distance within which it lies on both faces, which covers
setback corners (fitted to 1e-3 of the largest radius) and fillet ends (D. J. Jackson, "Boundary representation
modelling with local tolerances", ACM Symposium on Solid Modeling and Applications, 1995).

Tests: Euler–Poincaré on every result in the suite; each edge within its tolerance of both faces; p-curves map to
the 3D curve within the tolerance; STEP files unchanged in content.

Built: `ShellBuilder.fromResult` (`src/solid/BrepShell.ts`, with `Seams` moved to `src/solid/`) gives a `BrepShell`:
vertices; edges with their curve, a p-curve on each face over the curve's own parameter (a seam edge's are the seam's
two sides, exactly), and their tolerance (the largest distance from the curve to either face at its p-curve, found by
sampling and golden sections); faces with their source face and name. `Step.write` writes it through
`Step.writeShell`. Moving the code left the STEP files byte for byte the same on six parts. Checking the shells then
found point projection unreliable on surfaces whose knot spans differ widely in length (a cap on a rounded rectangle):
the slotted block's edges were up to 0.5 mm off its caps. Projection now seeds by knot spans and takes Gauss–Newton
steps that respect breakpoints and domain sides, and p-curves get triple knots where they cross a breakpoint: those
edges are within 1.3e-3, and the six STEP files keep their entities, with control points moved by that correction.
Tests in `test/testShell.cjs`: each edge used once each way, Euler–Poincaré against the mesh's genus, edges within
their tolerance of both faces by independent projection, p-curves giving the curve, tolerances within half the
fitting tolerance (plus 5e-3 at setback corners), on rounded boxes (ball and setback), a ring on a seam, the
filleted mug and three 507 parts.

Not yet: the wheels of 507 (A, and D cut one window at a time) give shells that fail Euler–Poincaré. Their caps,
discs with a pole at the centre, come out of the Boolean in several faces on one surface with slivers round the pole,
and the seam cut makes seam stretches of zero length there. Edges between exact faces have tolerances of about 1e-3,
not 1e-9: their curves are fitted to a quarter of the tolerance, as the STEP export always did.

### A3. Booleans take shells

`BrepBoolean.evaluate` accepts shells as well as primitives:

* **Intersect trimmed faces.** Branches between two surfaces are traced as now, then clipped to both faces' loops.
  Where a branch leaves a face across one of the operand's edges, its end is the point where three faces meet (the
  branch's two faces and the face across the edge), refined by the triple-point Newton step the pipeline already
  has. The branch continues on the neighbouring face from there.
* **Split faces with their own trims.** The face mesher takes the face's loops as constraints alongside the new
  cuts.
* **Classify** as now: by seam sides, and by ray parity against the other operand's mesh.

The literature for this step is boundary evaluation on sculptured solids: S. Krishnan, D. Manocha and co-authors,
"BOOLE: a boundary evaluation system for Boolean combinations of sculptured solids", International Journal of
Computational Geometry and Applications 11(1), 2001; and Hoffmann (1989), ch. 4 and 7, as for the current pipeline.

Tests: a rounded box minus a cylinder through a fillet and through a face, against the same solid built in one pass
where both can be (volumes to the mesh tolerance, the same face names); unions of two rounded parts are closed
2-manifolds with the expected genus; a part drilled through a setback corner.

### A4. `Model` evaluates in stages

A tree whose Boolean has a rounded operand is evaluated in stages: the rounded subtree first, as now, its result
made a shell, then the Boolean over it. Every stage is cached by content hash like any feature. Face names keep
their history: a face of the rounded operand keeps its name (`round(box.+x|box.+y)`) under the operand's path.
`Model.liftRound` remains, since moving a solid needs no Boolean.

Tests: a model rounded then drilled rebuilds only the drill when the hole moves; the round's fillet faces keep their
names through the cut.

### A5. Rounding any edge

Rolling-ball fillets between any two faces of a shell, a fillet's face included (a fillet across a fillet, a rounded
hole's rim). The rolling ball already runs on any pair of NURBS faces; what changes is that the edge comes from the
shell's topology rather than from a branch or a domain side.

### Out of scope for route A

Boolean regularisation stays as it is (docs/booleans.md, "Coincident faces"). Tangent contacts, branches through a
vertex, and more than three edges at a corner stay the known limits they are now.

## Route B, after A

Rebuild a trimmed shell as watertight untrimmed patches, so that no face has trims and neighbours meet exactly:

* T. W. Sederberg et al., "Watertight trimmed NURBS", ACM Transactions on Graphics
  27(3) (SIGGRAPH), 2008;
* B. Urick et al. (T. J. R. Hughes's group), "Watertight Boolean operations:
  a framework for creating CAD-compatible gap-free editable solid models", Computer-Aided Design 115, 2019;
* B. Marussig and T. J. R. Hughes, "A review of trimming in isogeometric analysis", Archives of Computational Methods
  in Engineering 25, 2018, for the survey;
* the THB-splines already in the library (docs/thb.md; Giannelli, Jüttler and Speleers, CAGD 29(7), 2012) for local
  refinement along seams and fillets, where the rebuilt patches need detail.

What it gives: solids for isogeometric analysis (docs/iga.md) with no trimming, exchange files with no gaps, and a
second, independent way to feed results back into the current primitive Boolean.

The references above are cited from memory and are checked against the papers before the step that uses them is
built.
