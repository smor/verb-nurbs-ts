# Mechanism design tools

Measurements that mechanism design needs on exact solids (#150): clearance and contact between posed solids, mass
properties, then solid offsets and swept envelopes. Each works on a result's exact B-rep shell
(`Graph.shellOf`), not on its mesh.

## Clearance and contact

`Graph.clearance( doc, a, b, { poseA, poseB } )` measures two solids of a graph document (outputs or nodes), each
under a pose (a turn about an axis through a point, then a move). It returns the least distance, its witnesses (the
nearest points, their face names, parameters and outward normals), the contact normal from `a` to `b`, and a lower
bound. When the solids overlap, it returns the interference: its volume on its exact shell, its box, and its deepest
point (the centre of the largest ball inside it) with that ball's radius. `Clearance.between( shellA, shellB )` is the
same on two shells in one frame.

**Method.** The search runs on meshes, the answer on the faces. Both shells are meshed by tolerance (`ShellMesher`,
0.02 mm by default), and a branch-and-bound descent over a box tree of each mesh finds the least triangle distance.
Every face pair with a triangle pair within that distance plus both meshes' deviations is refined on the exact
faces by alternating projections (von Neumann's method): the nearest point of one face to the other's point, then
back, until neither moves. A projection outside its face's loops is replaced by the nearest point of the face's
edges, put onto both of the edge's faces, so a witness can sit on an edge or a vertex. Overlap is decided on the
meshes, by triangles that cross or a vertex of one inside the other.

**Accuracy.** The witnesses are points on the exact faces, so the distance is exact to rounding where the nearest
points lie inside faces or on edges where exact faces meet (tests: two cylinders 1.5 apart side to side, 1 apart
across, rims √2 apart, a box's edge to a side, all to 1e-12). `lower` is the meshes' distance less their deviations,
which are measured at sample points, so it is an estimate rather than a guarantee. The interference's volume is on
its shell (within about 3e-4 of exact at the default tolerance); its depth is measured on its print mesh (within
0.02 mm).

**Limits.** Two face pairs whose nearest points fall between the search mesh's sample points by more than the mesh's
deviation could be missed; that needs a deviation larger than the gap's own variation, which the print preset keeps
small. There is no graph node yet.

### Along a motion

`Graph.closestApproach( doc, a, b, { motionA, motionB, from, to, tol } )` gives the least distance over an interval of
time, the time it happens, and `bound`, a lower bound on the distance at every time of the interval, within `tol`
(1e-3 by default) of the least distance found. A motion turns a solid about an axis by `degrees(t)` and moves it by
`at(t)`, each with a bound on its rate. `Clearance.along` is the same on two bodies (`Clearance.body`) with their
transforms over time and a bound on their points' speeds.

**Method.** Each solid's points move no faster than its turn's rate times their farthest distance from the axis, plus
its move's rate, so the distance between the solids changes no faster than the sum of their speeds L. Over [a, b] it
stays above (d(a) + d(b) - L (b - a)) / 2. The interval with the least such bound is split at its middle and measured
there, until that bound comes within `tol` of the least distance measured (Piyavskii's method, 1972; Shubert, 1972).
Each measurement is a clearance at a pose; the search meshes are made once and moved, the shells are not (points are
taken into a solid's own frame to be projected).

**Guarantee.** The bound holds if the rates given bound the motions' true rates and each measured clearance is the true
one (see above). If the solids overlap at some time measured, the result says so, with that time; the first time of
contact is not searched for.

**Cost.** Near a smooth minimum the distance is quadratic in time while the bound is linear, so the evaluations grow
like L / sqrt(tol κ), with κ the distance's second derivative there: a few hundred for the tests (10 to 20 seconds).
A bound on the distance's rate along the contact normal, rather than on any point's speed, would cut this.

## Mass properties

`Graph.massProperties( result, density )` and `MassPropertiesOf.shell( shell, density )` return the volume, the mass,
the centre of mass, the inertia tensor about the centre of mass (in the solid's axes, products of inertia with their
minus sign) and its principal moments and axes. `MassPropertiesOf.combine( parts )` adds parts of different
densities: the masses add, the centres of mass average by mass, and the tensors move to the common centre by the
parallel axis theorem. Parts that overlap count twice, so combine disjoint solids (a part and the nuts pressed into
it: cut the pockets from the part first).

**Method.** The divergence theorem turns each volume integral into a surface integral over the shell, and Green's
theorem turns each face's surface integral into a line integral round its loops, over the edges' p-curves. Only the
faces and the p-curves are evaluated, by Gauss–Legendre quadrature, with no mesh: it is `ShellBuilder.volume` carried
to the ten moments up to the second order (∫x dV = ½∮x² nx dA, ∫x² dV = ⅓∮x³ nx dA, ∫xy dV = ½∮x²y nx dA, ...;
Mirtich, "Fast and accurate computation of polyhedral mass properties", Journal of Graphics Tools, 1996, for the chain
of reductions). Polynomial faces and p-curves take enough points to be exact; rational ones take 12 per knot span. The
principal axes come from Jacobi rotations of the tensor.

**Accuracy.** The integrals follow the shell's p-curves, which are fitted to half the shell's tolerance. At the graph's
default tolerance (0.01 mm) a cylinder's volume and moments are within about 1e-4 of the exact ones; a shell fitted to
1e-5 brings them within 1e-6 (test "MassPropertiesOf", cylinder). Faces bounded by straight edges are exact.

**Limits.** Uniform density per solid. Infill fractions and regions of different densities are not weighted yet.
There is no graph node yet: this is an API on `Graph` and in `solid`.

## Offset

The `finish/offset` node (model feature `{ type : "offset", of, distance }`) grows a solid by a distance, or shrinks
it when the distance is negative: every point of the result's faces lies at that distance from the solid's. It is
built from the solid's own features (Rossignac and Requicha, "Offsetting operations in solid modelling", Computer
Aided Geometric Design 3, 1986), so planes stay planes and the faces stay exact where they can:

- **Box.** Grown: the box grown by the distance on each side, its edges rounded to the distance with ball corners (the
  box swept by a ball). Shrunk: the smaller box.
- **Cylinder.** Grown: the longer, wider cylinder with its rims rounded to the distance. Shrunk: the smaller cylinder.
- **Extrusion.** The profile offset in its plane (`ProfileOffset.region`: lines move parallel, arcs keep their centres,
  cubics are offset by Tiller and Hanson's construction within 1e-4, gaps at corners are filled by arcs round them and
  overlaps trimmed), extruded the distance further at each end. A **twisted** extrusion's sides are screw surfaces,
  whose offsets are screw surfaces of the same pitch: the offset section is where the offset surface meets the base
  plane (each point moved along the surface's normal, then down its helix), fitted by cubics within 1e-4, with the
  section of the pipe round each corner's helix filling the gaps. A grown extrusion keeps sharp rims on its caps (the
  rounds cannot yet run over a twisted or curved side), so there the result is the offset up to the rim. A tapered
  extrusion is refused.
- **Transform.** Through rigid and uniformly scaled transforms (the distance divided by the scale).
- **Union, intersection, difference.** The offset of each part, combined. A union grown and an intersection shrunk are
  exact; the other way round they are the usual approximation of CSG offsets (Rossignac and Requicha), exact where the
  parts' faces do not meet at the offset. A difference is the first part grown, less the others shrunk.
- Nested offsets of the same sign add. Other features are refused with the feature's name.

**Accuracy.** Boxes and plain extrusions are exact; cylinders' rounds and twisted sides are within about 2e-4 at the
graph's default tolerance (test "ProfileOffset", by distances measured both ways between the exact shells with
`Clearance.distanceTo`).

## Swept envelope

The `finish/sweep` node (model feature `{ type : "sweep", of, along }`) is the room a solid takes moving along a path:
the union of all its positions, as a solid usable in Booleans (cut it from a part to make the groove or the channel
it runs in). The node moves the solid by (x, y, z) at the samples of t from 0 to 1, along the smooth curve through
them; the feature takes those points as `along`.

- **Ball.** The catalogue's sphere, through rigid or uniformly scaled transforms. A ball's envelope is the canal
  surface of its centre's path (Monge): the pipe of its radius round the path, closed by hemispheres at the ends. Along
  a straight path that is a capsule, exact (an exact cylinder and two exact hemispheres). Along a curve, the pipe is
  `Sweep.pipe`'s, within its fit, and the domes take their rims from its end sections, so they meet it along the very
  same curves (`BrepSolid.roundedTube`). The pipe model feature takes the same ends as `ends : "round"`.
- Other solids are refused for now. The envelope of a cone or another solid of revolution under a rigid motion (a
  barrel cam's follower) comes next.

**Accuracy.** Along a line, every point lies at the radius from the centre's path within 1e-9 and the volume is the
capsule's within the shell's tolerance. Along half a circle of radius 30 through 24 samples, within 5e-4, most of it
the cubic through the samples departing from the circle near its ends (test "sweeps").

**Limits.** The path must bend less sharply than the radius and must not come back within a diameter of itself, or
the pipe folds.
