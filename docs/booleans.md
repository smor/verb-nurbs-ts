# NURBS booleans: method, sources and limits

`BrepBoolean` (in `src/solid/BrepBoolean.ts`) combines closed solids bounded by NURBS faces. It produces two things:

* trimmed faces: each original surface with the loops (in its own `(u, v)` parameters) that bound the part kept, and
  each fillet blend and corner patch on its own surface, trimmed the same way
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
     resolve. A closed loop smaller than a grid cell can be missed, so step 1b looks for those separately.
   * **1b. Detect small loops** (`SurfaceLoops`). By Sinha's theorem (Sinha, Klassen and Wang, ACM Symposium on
     Computational Geometry, 1985), two surfaces that meet in a closed loop have, inside the loop, a pair of points
     whose normals are parallel, a *collinear normal point* (Kriezis, Patrikalakis and Wolter, CAD 24(1), 1992):
     - Both domains are split into cells. Only pairs whose boxes meet and whose sampled normal cones admit parallel
       normals are kept.
     - Newton's method solves the four collinear-normal equations from each kept pair. These exclude the trivial
       solutions along a transversal crossing.
     - At a critical point a positive distance apart, the loop around it is found by walking the isocurves through
       it until the signed distance changes sign. The loop is then traced by marching (`SurfaceIntersect.trace`).
     - A critical point at zero distance is a **point where the surfaces touch** without crossing. It is reported
       (`SurfaceIntersect.analyze(...).touching`), not lost.
     - A loop that the grid finds but resolves with fewer than 24 vertices is traced again, finer, so it can trim a
       face.
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
5. **Classify.** Each region is tested against every other solid:
   * **At a seam, exactly** (`BrepBoolean.seamSides`). For a region bounded by a seam with another solid, step from
     the seam into the region. The step is taken in the tangent plane of the region's face, across the seam. The
     region is inside the other solid when that step points against the other face's outward normal. This does not
     depend on how finely either solid is tessellated, which matters when two solids overlap by less than the
     tessellation's chord error. Every seam edge votes, and a clear majority (90%) decides.
   * **Elsewhere, by ray parity** (`TriMesh.containsPoint`) against the other solid's tessellation. Three rays in
     unrelated directions vote, from each of the region's five largest triangles.
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

**Fillets that crowd each other.** Two closed blends on the same face, such as the two handle joints of a short mug
or two holes close together, can have contact curves that come close or cross on that face. Crossing contact curves
cut the face into pieces that belong to neither blend, and the result is not a solid. Where two contact curves come
within a tenth of the smaller radius of each other (segment against segment, in space), both blends are rebuilt at
0.8 times their radius, up to six times. Each blend made smaller is counted in `report.filletsReduced`, and one that
still cannot keep clear is left sharp and counted in `report.filletsFailed`.

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
jump, the look of class-A surfaces; a circular fillet's curvature jumps from 0 to 1/r at its edges. Where three such
blends meet, the corner is a G2 setback vertex blend (below), even for equal radii: a sphere cannot be G2 with sections
that are not circular arcs. (`filletCorner : "ball"` asks for ball corners instead, and they are the fallback should the
setback construction fail: a ball corner bent so its sides
meet the three end sections, each side's departure from the ball's arc carried inside with Nielsen's side-vertex
weights (w_j w_k)^2: G1 only.)

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
faces, and the corner is a **setback vertex blend** (T. Várady and A. Rockwood, "Geometric construction for
setback vertex blending", Computer-Aided Design 29(6):413–425, 1997):

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
  plane, so it is G1 with the blends and the faces all round.
* with curvature-continuous blends (`filletShape : "curvature"`) the corner is G2 as well. Each ribbon also carries
  the second derivative across its side: along a blend, the second difference of its sections; on a face, the face's
  second derivative along the cross direction (its normal part is the face's normal curvature that way). The
  transfinite blends become cubes, whose first and second derivatives vanish across each side, and each ribbon gets a
  second-order term corrected for the side parameter's drift across the side (see `Transfinite`). On a box with
  radii 1, 2 and 3, the corner's normal curvature across its sides stays under 0.1 / r where the neighbours have
  none, against 2.3 to 4 / r for the same corner built G1. The corner is carried by six four-sided bicubic B-spline
  surfaces, the usual CAD form of an n-sided patch: the hexagon is split into six quadrilaterals (a vertex, the
  midpoints of its two sides, the centre), each mapped bilinearly from the unit square and fitted to the patch, so
  neighbours meet along their shared sides to within the fit's tolerance. (A single square mapped radially onto the
  hexagon was tried first: the map's kinks along the diagonals showed up as creases in the fit.)
* the corner stays **flush**: never past the faces it rounds. The patch is a convex combination of its ribbons, each
  carried on from its side into the patch; carried on without limit (to the far side of the hexagon) a ribbon runs
  out past the faces round the corner, and the patch takes a share of it: on a 40 x 28 x 20 box with radii 3, 4 and 5
  the corners stuck out by 0.11 (circular) and 0.17 (G2). Each ribbon gets a **reach** (`Ribbon.reach`): it is
  followed at `reach tanh(d / reach)` in place of the distance `d` from its side, the same to second order at the side
  (so every continuity there stays, G2 included) and never further than `reach`. The longest reach that keeps every
  sample of the patch behind all three faces is found by a scan and bisection; corners that already fit are left
  alone. Both kinds of corner now stay inside exactly. (Shortening the cross derivatives instead, the first fix,
  flattened the patch at its sides and, for G2 corners, let the second-order terms take over: it left 0.04 of bulge
  and tripled the curvature jump across the sides.)
* a circular corner also stays within its **blends' envelopes**: each blend carried on straight past its end section
  (a quarter cylinder, on a box). Behind the faces alone it still stuck out of them by up to 0.22, a visible blob past
  the fillets. The ribbons are first bent in (`Ribbon.third`, a third derivative across each side towards the blends'
  centres, which leaves G1 and G2 at the sides alone), by the least bend, found by scan and bisection, that keeps the
  patch behind the faces and within the envelopes. Where no bend does it without a dent, the corner is held within the
  faces only, with a reach as above. On the box, 7 of 12 edges meet flush corners and the rest stick out by 0.064 at
  most. G2 corners keep the faces-only rule: held within the envelopes as well, their reach had to shrink so far
  that it dented them.

The setback makes the corner a smooth "pillow" in place of the crease a ball corner would need between unequal
blends.
`Transfinite` is general: any n-sided hole bounded by curves with cross-derivative ribbons can be filled with it (n-sided
hole filling, the base of later vertex blends with more edges).

The mitre is found on the blends' meshes (column polylines through the other blend's triangles), so it is as accurate
as the tessellation. A notch's four edges are rounded together: if one corner cannot be built (the fillets would swallow
a rim narrower than two radii), the four stay sharp.

Limits:

* A corner is rounded where two rounded edges that share a face meet a sharp edge, or where three rounded edges meet:
  a ball for one radius and one kind (convex or concave), a setback vertex blend otherwise, including mixed corners
  (a convex fillet flaring into two concave ones, as where a rounded boss's vertical edge meets the fillets round its
  base). More than three edges are left sharp and counted in `report.filletsSkipped`, with the other edges around
  the same corners.
* A rounded edge that meets two sharp ones **runs out** onto the third face there (the vertical edges of a box under a
  sharp top, a slot's rim where it leaves the block, the inside corners of an open tray at the rim). The blend ends
  at its section by that face: each column of the blend where it crosses the face, from one contact curve on the
  first sharp edge to the other on the second, and that section is cut into the face. On a convex edge the face's
  corner outside the section is cut off; on a concave one it is filled in, on the side the rest of the face is kept.
  The third face may be a face of either solid, met at a slant. Where the section leaves the third face's surface
  (a fillet at a narrow step's foot, running off its side into the air) the face would have to be carried on past its
  edge: that is not done, and the edge is left sharp and counted.
* Where contact curves cross beyond a blend's end (two concave fillets round a convex edge, at a boss's base), they
  are carried on straight past their ends to find the crossing, for mitres as for setbacks.
* An own edge that a Boolean's branch ends on (a boss's vertical edge, where it enters the base) is split there; each
  piece is rounded only if it is an edge of the result, and its end is the corner the branches meet at.
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
the pipe's surface), and remove Pappus's volume to within the chords' sag. Open edges end at the solid's vertices: their end
points are shared (snapped) with the other edges there, so they meet at corners like a Boolean's runs, and the corners
above apply. `BrepSolid.box` with all twelve edges rounded at one radius gets eight ball corners and the volume of the
Minkowski sum of the inner box and the ball (to within the chords, 0.3% low at r = 2); with three radii, setback
corners where they differ; chamfered, flat and faceted corners.

## Shells as operands

A Boolean result's exact shell (`ShellBuilder.fromResult`) can be an operand of the next Boolean, through
`ShellBuilder.solid(shell, mesh)`. Its faces keep their whole surfaces, trimmed to their loops, and its edges join the
branches as cuts. A branch is clipped where it crosses an edge, at the point where the edge meets the branch's other
surface, and the faces keep only what lies inside their trims. So a rounded part can be drilled or united without
rounding it again. See [exact-booleans.md](exact-booleans.md), step A3.

## Seams of surfaces of revolution

When both faces are perfectly round about the same axis, their seams can cross a branch at the very same point. The
intersection then returns that point two or three times, each copy flagged for one face's seam, and an unflagged copy
sat on the seam was taken for the wrong end of the domain. `BrepBoolean.cleanSeams` flags every vertex that lies
exactly on a periodic seam and merges repeated vertices, combining their flags. `facePieces` reads which end of the
domain a seam vertex stands for from the first neighbour that is not itself on the seam.

## Coincident faces

Solids placed flush with each other are everyday modelling: a slot through a plate, a boss standing on a face, two
parts sharing a face. Three things make them work.

* **On-classification (regularised set operations, after Requicha).** A region of a face that lies on a face of
  another solid is neither inside nor outside it. Just behind the region, that solid is inside where its face points
  the same way and outside where it points against; just in front, the reverse. The region is a face of the result
  where the expression differs across it, and of all the solids sharing it, the first keeps it. Coincidence is
  decided at the centres of the region's largest triangles, projected exactly onto the other solid's faces
  (`SurfaceIntersect.project`: a grid seed, then Newton).
* **Sides lying on faces.** When a side of one face's domain lies on the other surface along its whole length (a
  tube ending on a plane, a box's edge on another box's face), the meshes touch along an edge and their intersection
  breaks up. `SurfaceIntersect.sidesOn` gives that branch exactly (the side, sampled, and its projection), and the
  pieces found along it are dropped. A cut that lies along a face's side gives that side its points (the grid nodes
  inside it are left out), and the face across that edge of the same solid gets the same cut, so the three faces
  that meet there share their vertices.
* **Stretches of sides on faces.** `sidesOn` finds runs, not only whole sides: a box's edge lies on a wider
  cylinder's cap only between the points where the cap's rim crosses it. The run's ends are found by bisection. Where
  a side of B lies along the same run too (two tubes end to end), the faces meet edge to edge and no branch is made.
  When the two sides match end to end, the pieces the meshes found along them are dropped too; when one covers only a
  stretch of the other (a box flush with a wider box's edge), they stay, and cut the longer side where the shorter
  one ends.
* **Surfaces that coincide over an area are not intersected.** Two copies of one cylinder (each window of a wheel
  bringing its own hub) would have meshes crossing everywhere, at great cost and with nothing to find.
  `SurfaceIntersect.coincide` looks for a 2 by 2 block of samples of one surface lying on the other with parallel
  normals (a line of contact holds none); such a pair only has its sides on each other (`sidesOn`). For this to hold,
  copies must be the same surface: a cylinder is an exact rational one, not a swept approximation.
* **Broken branches are traced again.** Where both grid meshes put vertices on the branch (a bore at exactly half a
  coaxial cap's radius), their intersection breaks into pieces that end inside both domains or overlap. A branch ends
  only where it leaves a domain or closes, so such pieces are only seeds: the branches are traced again from their
  points by marching (Barnhill and Kersey), each once.
* **One cut per curve.** Two coincident faces crossing a third face (a boss's cap on a box's top, both crossed by a
  bore) give two branches along the same curve. The third face is cut by the first of them only. A branch lying
  along a stretch of another (a pin's cap crossing a window's wall only where it overhangs) does not cut that face
  either.
* **Cuts reach the face's edge.** An open cut ends on the edge of its domain or on another cut. An end refined to a
  hair inside the edge is put on it, and an end at a pole (the centre of a cap) takes its neighbour's parameter there,
  so that no sliver triangle bridges the cut. Regions are joined across the tessellation's own edges, not by welded
  points, so two cut points close enough to weld do not join the regions on either side.

The test "BrepBoolean degenerate configurations" runs 25 such cases (flush slots, notches, pockets, equal solids,
boxes touching at a vertex, bores through a corner or along an edge, bosses, stacked cylinders, counterbores): each
is closed, with the exact volume, and a tangent cylinder keeps its volume and is reported. Before this work, 21 of the
25 failed.

## Proving that no branch was missed

`IntersectionCertificate.check(A, B, curves)` proves, or fails to prove, that `curves` holds every branch of the
intersection of two surfaces, closed loops included. It follows Sederberg and Meyers ("Loop detection in
surface patch intersections", CAGD 5, 1988), with Sinha's theorem as above:

1. Both domains are split into cells (4 × 4 by default). Each cell is cut out of its surface exactly, as rational
   Bézier patches, by knot insertion. Its control points bound it: their box contains the cell.
2. Each cell gets a **rigorous normal cone**. The numerators of the rational partial derivatives,
   `w P_u − w_u P` and `w P_v − w_v P`, are polynomial patches whose Bézier coefficients come from products of
   Bernstein bases; every normal of the cell is a positive combination of the cross products of their coefficients.
3. A pair of cells whose boxes are apart cannot meet. A pair whose cones (and their opposites) are apart cannot
   have parallel normals, so by Sinha's theorem no closed loop lies inside it: every branch through it crosses an
   edge of one of the two cells. Those crossings are computed (each isocurve against the whole other surface, once)
   and each must lie on a given curve. One that does not is reported in `missed`, as a start point on the branch.
4. Any other pair is split, the cell whose normals turn most first, up to `depth` times. A pair still undecided is
   counted in `unresolved`: the surfaces may be tangent there, or a loop smaller than the cells may hide there.

The result is `proven` only when nothing is unresolved and nothing was missed. Cells round a pole (a cap's centre)
have wide cones however small they get, so pairs may be split 8 times by default. A cell already less than half the
size of the other is not split again; the other one is, until the boxes part.

With `certify: true`, `BrepBoolean` runs the check on every pair of faces whose boxes meet, and reports
`report.certificate`: the pairs, how many are proven, and the others with their counts. A model document with
`certify: true` passes it on, and its verdict notes either that every intersection is proven complete or how many
pairs are not. The test suite runs it as a gate on reference models, and every pair is proven:
- the mug's union: 3 pairs;
- a filleted boss: 3 pairs;
- a shelled and rounded tray: 4 pairs;
- slot rims: 8 pairs.

The shelled mug is proven in all 20 pairs, but that takes 20 s (its offset surfaces have many spans), so it is not
in the suite. A plane through a cylinder or a
sphere is proven complete in about 0.15 s. Dropping the curve reports start points all around it. A sphere grazing a
plane (a loop of radius 0.014) is not proven, with or without that loop: the normals there are nearly parallel by
nature, which is the honest answer.

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

The plan for the largest one, Booleans whose operands are themselves results (a rounded solid drilled, two rounded
parts joined), is [exact-booleans.md](exact-booleans.md).

* **Branches through a vertex of a solid.** A branch may cross an edge between two faces, and two branches may cross
  inside a face. A branch that passes exactly through a corner where three faces of one solid meet is not handled.
* **More than two branches crossing at one point** (four or more faces meeting) is not handled.
* **Tangent faces.** A branch along which the two faces' normals stay parallel (a cylinder lying on a plane) is a
  line of contact, not of crossing. It is left out of the branches and counted in `report.tangentContacts`. The two
  solids then touch along that line: the volume is right, but the result is not a manifold there (it is not, in
  exact arithmetic either), and the Model verdict calls it visual. Near-tangent pairs that do cross are traced as
  usual.
* **Topology is certified on request, not by default.** Broken-up branches are detected (an end inside both domains,
  a piece lying on another, after Barton, Elber and Hanniel's single-component count, or a piece that turns straight
  back on itself, which the meshes' intersection produces where they cross at a grazing angle) and traced again. A
  branch whose two ends lie on sides of a domain stays open even when its ends are closer than a mesh edge (a narrow
  notch across a rim).
  `certify: true` (a Boolean option, or a model document's flag) runs `IntersectionCertificate.check` (below) on
  every pair of faces that meet. It is off by default because it costs a fraction of a second per pair. Pairs it
  leaves unresolved, near tangency, are where a missed loop could still hide.
* **Small loops** are found from collinear normal points. The normal cones that select their candidate cells are
  sampled; the certificate's cones are rigorous, and could replace them.
* **Every face is trimmed NURBS.** Blends and corner patches are faces like the operands' faces: `cornerUV` gives
  each of their triangles its corners' parameters, and `loops` bound them. A closed blend is lofted through its
  sections, which are its isocurves, so its vertices lie on it to rounding; an open blend's trim points lie between
  its sections and are within 4e-9 of its loft. A ball corner lies on its sphere, placed so that the corner crosses
  neither its seam nor a pole. A setback corner's six parts are B-splines fitted to its exact transfinite patch to a
  thousandth of its radius, and its vertices are within that of them (`patchXY` still gives the exact patch).
* **Trim curves are polylines** in `TrimmedFace.loops` (dense, in `(u, v)`). `Step.write` fits exact 3D edge curves
  for export (see [step.md](step.md)); p-curves are left to the reader.
* **Narrow fillets meeting a sharp edge.** A blend that ends in a mitre at a sharp edge (a rim notch filleted with the
  rim left sharp) can overlap its neighbour there when it is much narrower than the tessellation of the faces around
  it (a 0.2 mm fillet on a notch meshed in millimetre steps).
* **Speed.** Classification casts rays against the whole tessellation of each other solid. A bounding volume
  hierarchy would make it scale to many tools.
