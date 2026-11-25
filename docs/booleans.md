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

## Rolling-ball fillets

`BooleanOptions.fillet` rounds the new edges: one radius for every edge, or a function of the edge (its solids and
faces) that returns a radius, or 0 to leave it sharp. `src/solid/Fillet.ts` builds each blend.

The blend is the surface swept by a ball of radius r that rolls while touching both faces (Choi and Ju,
"Constant-radius blending in surface modelling", *Computer-Aided Design* 21(4), 1989). The ball's centre runs along
the intersection of the two faces offset by r. The textbook route intersects the offset surfaces. Here each centre is
found directly instead, with no offset surfaces: at a vertex p of the edge, with tangent t, Newton's method solves
four equations in the four contact parameters (a on face A, b on face B):

    A(a) + s r nA(a) = B(b) + s r nB(b)        (both offsets reach the same centre)
    (A(a) + s r nA(a) - p) . t = 0              (the centre lies in the plane across the edge at p)

Here n is the result's outward normal and s says where the ball rolls. On a concave edge (s = +1) it rolls in the
air, so the fillet adds material, as at the mug's handle joint. On a convex edge (s = -1) it rolls in the material,
so the fillet removes some, as at the edges of a hole. The sign follows from which side of the edge each face keeps,
and that comes from the same CSG evaluation as step 5. The start for Newton is the centre that the two tangent planes
at p would give.

Each section is an exact circular arc from one contact point to the other, written as a rational quadratic. The blend
surface is the loft of those arcs. The contact curves become extra cuts on the two faces, with a section placed
exactly where a contact curve crosses a periodic seam. The strip of each face between the edge and its contact curve
is dropped: it is the region bounded by both curves. The blend's mesh uses the contact points themselves on its two
boundary rows, so it welds to the faces and the result stays watertight.

Checks: a disc with a hole and a rod through a disc have exactly known fillet volumes (Pappus: the corner region of
area (1 - pi/4) r^2 swept around the hole). The volume removed or added agrees to 0.3% at 256 divisions around, and to
1.5% at 128, converging as the tessellation refines. The ball is at distance r from both contact points, along both
normals, to 1e-8. The mug and the pierced vessel stay watertight with the same genus, and manifold-3d accepts them.

### Variable radius and curvature-continuous sections

The `fillet` callback may return a function of the position along the edge (0 at its start, 1 at its end, by
length) instead of a number: the ball's radius then changes along the edge (Newton's method takes the radius at each
section). On a disc and a rod with r = 2 + sin(2 pi t), the added volume matches the integral of Pappus' formula to 3%.

`filletShape : "curvature"` keeps the ball's contact curves but replaces each circular section by a quintic that is
tangent to both faces and has each face's normal curvature where it meets it (G2), computed from the second
fundamental form along the section's direction. Its control points lie on the two tangent lines towards their meeting
point, at 0.35 and 0.7 of the way, the second ones lifted off the tangent line by 5/4 k l^2, which is what gives the
end curvature k. Against a plane the section starts with zero curvature, so reflections run on into the blend with no
jump, the look of class-A surfaces; a circular fillet's curvature jumps from 0 to 1/r at its edges. Ball corners
follow: the sphere patch is bent so its sides meet the three G2 end sections, each side's departure from the ball's arc
carried inside with Nielsen's side-vertex weights (w_j w_k)^2.

### Chamfers

`filletShape : "chamfer"` cuts the edge with a straight section between the ball's contact points (a bevel; on a
square edge it cuts back the radius on both faces). Everything else is shared with the fillets: open edges, mitres,
variable radius. Where three equal chamfers meet the corner is the flat triangle between the ball's feet; where they
differ it is a setback facet: straight cuts across each face, and a six-sided transfinite patch whose ribbons all lie in
the plane that best fits its boundary, so it comes out nearly flat.

### Corners

Branches that meet at triple points are split there into runs, the edges of the result; a run is an edge only where
its two faces are both kept (judged at its middle). A rounded edge that ends at a corner meets another rounded edge
there. `src/solid/FilletCorner.ts` handles the common case: two rounded edges sharing a face b (a notch's tube) run
into a sharp edge between their other faces a1 and a2 (the vessel's rim). Each blend is computed along its whole edge,
with the ball allowed a little past the end of a face that stops there (NURBS end spans carry on), and two more sections
past each end. Then:

* X, where the two contact curves on b cross, starts the mitre;
* on a symmetric corner (a box corner) the mitre runs from X along the line where the blends meet, to a point Q on the
  sharp edge, so the sharp edge carries on as a crease across the corner. With equal radii on a box corner the mitre
  is the quarter ellipse where the two cylinders meet;
* on a lopsided one (the vessel's wavy rim) one blend leans over: it reaches the other blend's contact curve with a2
  (at Y) before the sharp edge. From Y it runs on into a2, which is cut along their intersection down to the sharp
  edge;
* each blend's mesh is a constrained triangulation of its (along, across) rectangle between its two trims, its
  boundary the contact points shared with the faces' cuts and the mitre points shared with the other blend, so the
  result stays watertight.

Where three rounded edges of one radius meet, all convex or all concave, the corner is a **ball corner**: the ball
that touches all three faces (its centre found by Newton's method on the three faces' offsets, six unknowns) stops
each blend at the section through its centre. The corner is the spherical triangle on that ball between the three
end arcs (great-circle arcs, since each is centred on the ball's centre), and each face's two contact curves meet at
the ball's foot on it. The patch is tangent to all three blends along their end arcs. On the pierced vessel with its
inner rim rounded too, each notch has two ball corners (tube, rim top, inner wall) and two mitres (tube, rim top,
outer wall, whose edge stays sharp).

Where three rounded edges of **different radii** meet (again all convex or all concave), no ball touches all three
faces, and the corner is a **setback vertex blend** (Várady and Rockwood, "Vertex blending based on the setback
split", 1995):

* on each face, the two contact curves that run onto it cross at a point X; each blend stops a setback short of the
  nearer of its two crossings, 0.6 times the largest radius by default (`FilletCorner.setbackFactor`), and no more
  than a quarter of the room left to its edge's other end. Contact curves are carried on straight past their ends to
  find X, since a small blend can stop before its contact meets its large neighbour's;
* on each face a cubic curve, tangent to both contact curves (Hermite in the face's parameters, its end tangents scaled
  to the chord), joins their ends and cuts the face;
* the corner is the six-sided patch between the three end sections and the three face curves: a transfinite surface
  (`src/eval/Transfinite.ts`, Kato's side-based patch in the ribbon form of Salvi, Várady and Rockwood 2014). Each
  side carries a ribbon, its boundary and the derivative across it: along a blend's end section, the blend's own
  derivative along the edge; along a face curve, the direction in the face's tangent plane square to the curve, the
  way the blends' sections leave the face. The patch interpolates every boundary and matches every ribbon's tangent
  plane, so it is G1 with the blends and the faces all round. The corner is carried by six four-sided bicubic B-spline
  surfaces, the usual CAD form of an n-sided patch: the hexagon is split into six quadrilaterals (a vertex, the
  midpoints of its two sides, the centre), each mapped bilinearly from the unit square and fitted to the patch, so
  neighbours meet along their shared sides to within the fit's tolerance. (A single square mapped radially onto the
  hexagon was tried first: the map's kinks along the diagonals showed up as creases in the fit.)

The setback makes the corner a smooth "pillow" in place of the crease a ball corner would need between unequal
blends.
`Transfinite` is general: any n-sided hole bounded by curves with cross-derivative ribbons can be filled with it (n-sided
hole filling, the base of later vertex blends with more edges).

The mitre is found on the blends' meshes (column polylines through the other blend's triangles), so it is as accurate
as the tessellation. A notch's four edges are rounded together: if one corner cannot be built (the fillets would swallow
a rim narrower than two radii), the four stay sharp.

Limits:

* A corner is rounded where two rounded edges that share a face meet a sharp edge, or where three rounded edges of one
  kind (convex or concave) meet: a ball for one radius, a setback vertex blend for different radii (see above). Three
  edges of mixed kinds, more than three edges, or a rounded edge meeting an unrounded one, are left sharp and counted
  in `report.filletsSkipped`, with the other edges around the same corners.
* A setback needs room: on a short edge between two corners (a notch top across a thin rim) the two trims can overlap,
  and the edge and its partners stay sharp.
* If the ball does not fit (the radius is larger than the room between the faces), the edge is left sharp and
  counted in `report.filletsFailed`.
* Fillets of nearby edges must not overlap: keep the radius under half the distance between edges, for example half
  the wall thickness for hole edges.
* Sweeps of closed profiles (pipes among them) are fitted on a periodic knot structure in the profile's direction,
  then clamped by knot insertion, so they are as smooth across their seam as anywhere else (the tangent turns by
  about 1e-6 degrees there; a clamped fit left a 0.35 degree crease). Where the seams of both faces cross the contact
  curve at the same point, the section put there is flagged as on both seams.

## Rounding a solid's own edges

`BooleanOptions.edges` rounds edges that the solids already have, between two of their own faces (a disc's rims, a
rod's ends), alone or together with the new edges of a Boolean. `BrepEdges` finds them: a face is a NURBS surface over
its whole domain, so its edges are the sides of the domain that are not seams and do not collapse to a point, and two
faces share an edge where every sample of a side of one lies on a side of the other (refined by Newton's method along
that side). The edge becomes a curve on both faces, like an intersection branch, and goes through the same rolling
ball: the faces' outward normals are their own, and the edge is convex or concave as one face's kept side runs behind
the other or in front of it. Only the contact curves cut the faces (the edge already lies on their sides); the strip
of each face between its side and the contact curve is the region bounded by the contact curve that reaches that
side, and is dropped. Every section shape works (circular, curvature-continuous, chamfer).

`BrepBoolean.evaluate([solid], f => f[0], { edges : [...] })` rounds one solid with no Boolean at all. On a disc of
radius 30, both rims rounded with r = 2 give exact tori (every blend vertex r from its centre circle, to the fit of
the pipe's surface), and remove Pappus's volume to within the chords' sag. Closed edges only for now; open ones (a
box's) need the corners above, between own edges.

## Seams of surfaces of revolution

When both faces are perfectly round about the same axis, their seams can cross a branch at the very same point. The
intersection then returns that point two or three times, each copy flagged for one face's seam, and an unflagged copy
sat on the seam was taken for the wrong end of the domain. `BrepBoolean.cleanSeams` flags every vertex that lies
exactly on a periodic seam and merges repeated vertices, combining their flags. `facePieces` reads which end of the
domain a seam vertex stands for from the first neighbour that is not itself on the seam.

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
