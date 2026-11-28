# Mechanism design tools

Measurements that mechanism design needs on exact solids (#150): mass properties, then clearance and contact
between posed solids, solid offsets and swept envelopes. Each works on a result's exact B-rep shell
(`Graph.shellOf`), not on its mesh.

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
