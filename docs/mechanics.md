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
small. A motion over time (closest approach over an interval) is not there yet. There is no graph node yet.

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
