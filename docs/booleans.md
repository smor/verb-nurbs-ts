# NURBS booleans: method, sources and limits

`BrepBoolean` (in `src/solid/BrepBoolean.ts`) combines closed solids bounded by NURBS faces. It produces two things:

* trimmed faces: each original surface with the loops (in its own `(u, v)` parameters) that bound the part kept
* a watertight triangle mesh, in which the two faces on either side of every seam share vertices

This note explains how it works, which papers it follows, and what it does not handle yet.

## Pipeline

The structure is the one used by CAD kernels (Parasolid, ACIS, Open CASCADE's Boolean Operations algorithm). The
textbook account is Hoffmann, *Geometric and Solid Modeling* (1989), ch. 4 and 7.

1. **Intersect faces** (`SurfaceIntersect.surfaces`). Every pair of faces from different solids whose control-point
   boxes overlap is intersected. The method follows Patrikalakis and Maekawa, *Shape Interrogation for Computer Aided
   Design and Manufacturing* (2002), ch. 5, and Barnhill and Kersey, "A marching method for parametric
   surface/surface intersection" (CAGD 7, 1990):
   * **Find every branch.** Intersect two grid triangulations of the faces. This finds every branch the grids
     resolve. A branch smaller than a grid cell can be missed. Kernels close that gap with subdivision and
     loop-detection tests (Sederberg and Meyers, CAGD 5, 1988), which are not implemented here.
   * **Refine each point.** The three-plane Newton step moves the point to where the two tangent planes and the plane
     normal to both meet, then maps that move back to `(u, v)` on each surface. The iteration keeps the parameters on
     both surfaces. These parameter-space images of the curve are the "pcurves" that trimming needs. Periodic
     parameters are wrapped and the others clamped, so a point can never leave the domain.
   * **Densify.** Insert refined points until consecutive points are about one tessellation cell apart. The
     interpolation takes the short way across periodic seams.
   * **Run to the edge.** A branch that leaves a face through one of its edges gets an exact end vertex there.
     It is found by Newton's method on that edge's isocurve against the other surface. The branch on the
     neighbouring face computes the same point from its side, and the two ends are joined.
   * **Split at seams.** Wherever a branch crosses the seam of a periodic face, insert an exact vertex there. It is
     found by Newton's method on the isocurve at the seam against the other surface.
2. **Triple points.** Where two branches cross inside a face, three faces meet. The crossing of the two polylines
   is refined by Newton's method on F(a) = G(b) = H(c) (six equations, six unknowns) and inserted into all three
   branches. This is how a notch through a rim works: the rim, the inner wall and the tool meet at one point.
3. **Split faces** (`FaceMesher`). Each face is tessellated in its parameter domain:
   * Cells of a regular grid away from the cuts are split into two triangles each.
   * Cells near a cut, or holding a cut's end, are re-triangulated by a constrained Delaunay triangulation (cdt2d,
     which uses Shewchuk's robust predicates). The cuts are constrained edges, and so is the border with the regular
     cells.
   * The domain is scaled to the face's mean edge lengths, so the triangulation is not distorted by the
     parameterisation.
   * Both faces of a cut use the same 3D points, and a hash grid welds all vertices. As a result, seams, periodic
     edges and the edges between faces of one solid all close up.
4. **Group regions.** Within each face, triangles are joined across every edge that is not a cut (a union-find over
   the welded edges), so a region continues across periodic seams.
5. **Classify** (`TriMesh.containsPoint`). Each region is tested against every other solid by ray parity:
   * Three rays in unrelated directions vote.
   * The region's five largest triangles vote.
6. **Evaluate the expression.** This is CSG boundary evaluation (Requicha and Voelcker, "Boolean operations in solid
   modeling: boundary evaluation and merging algorithms", Proc. IEEE 73(1), 1985). Let a region belong to solid *i*.
   Evaluate the expression twice, once with solid *i* taken as inside and once as outside, and the other solids at
   their classified values:
   * If both answers agree, the region is not on the boundary of the result, and it is dropped.
   * Otherwise it is kept, facing the side where the expression is false.

   This handles any expression over any number of solids in one pass. `union`, `intersection` and `difference` are
   one-line wrappers, and the mug is `(body || handle) && !cavity`.

## How it is checked

* The intersection points lie on both surfaces to about 1e-9 (`report.maxCurveError`).
* Two rods: the common volume agrees with numerical integration of the exact solids to within the tessellation's
  chord error. Inclusion-exclusion holds as well: |A| + |B| = |A ∪ B| + |A ∩ B|.
* The genus and volume of every result agree with manifold-3d's own mesh boolean of the same tessellated operands, to
  within 0.02%. manifold-3d accepts every result as a valid manifold.
* The mug is genus 1 (the handle). The pierced vessel is genus 18 (one per hole).
* Rods crossing at the end of one rod: every branch crosses the edge between wall and cap. Union, intersection and
  difference are all watertight and agree with manifold-3d.
* Rim notches: branches meet at triple points. The result is watertight, and manifold-3d agrees on its genus and
  volume.

## Limits (next steps)

* **Branches through a vertex of a solid.** A branch may cross an edge between two faces, and two branches may cross
  inside a face. A branch that passes exactly through a corner where three faces of one solid meet is not handled.
* **More than two branches crossing at one point** (four or more faces meeting) is not handled.
* **Tangent and coincident faces.** Faces that touch tangentially, or that overlap, are not detected. Leave tools long
  and let the Boolean cut them, as the mug does with its handle and cavity, rather than placing faces flush.
* **Small branches.** A loop smaller than the search grid can be missed.
* **Trim curves are polylines.** `TrimmedFace.loops` are dense polylines in `(u, v)`. Fitting them with B-splines
  (`Fit.curve`) would give IGES 142/144 or STEP style trimmed surfaces for export.
* **Speed.** Classification casts rays against the whole tessellation of each other solid. A bounding volume
  hierarchy would make it scale to many tools.
