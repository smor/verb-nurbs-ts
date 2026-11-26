# Differential growth

`Growth` grows organic sheets (ruffles, frills, blisters, ridges) the way leaves and petals do. The sheet then becomes
a solid that can be made. The approach follows Nervous System's Floraform (2014) and the mechanics of growing leaves
(Liang and Mahadevan, PNAS 106, 2009).

```js
const sheet = Growth.disc(20, 1.5);                    // or Growth.rectangle(w, h, edge), or any open TriMesh
const grown = Growth.grow(sheet, {
  zones: [{ kind: "edge", rate: 0.01, reach: 4 }],     // where and how fast it grows
  steps: 200, bending: 0.3, pin: m => Math.hypot(m[0], m[1]) < 4,   // a stiff, pinned centre
});
const solid = Growth.thicken(grown, 1.2);              // a closed solid, walls 1.2 thick
solid.separate;                                        // no folds fused
Makeable.check(solid.mesh, "sls");                     // the fabrication verdict
```

## Growth zones: partial and typed growth

Zones are measured in **material coordinates**: where a point was on the sheet as laid out. A zone therefore stays
on the same stretch of material however much the sheet buckles. Each zone has a `rate` (the relative growth of rest
lengths per step at its heart) and a Gaussian falloff over `reach`. The rates add up.

| `kind` | Grows | Looks like |
|---|---|---|
| `edge` | along the free boundary | ruffles: lettuce, kale, a petal's rim |
| `point` | round points `at` | a single frill or cup where it is placed: partial growth |
| `line` | along a polyline `at` | a fasciated ridge |
| `everywhere` | all over | crumpling |

`direction` makes a zone anisotropic. An edge grows by the rate times cos² of its angle to the direction, so the
sheet lengthens one way only, as in a stretching frill. Different zones can have different kinds, rates, reaches and
directions, so one sheet can ruffle at its rim and blister in two places. `pin` holds material still, like a stem or
a base.

## Method

Each edge of the triangle mesh is a spring with a rest length. Every step does three things:

1. **Grow.** Each rest length is multiplied by 1 + its rate. The rate is the zones' rates at the edge's ends,
   averaged, times its alignment for directed zones.
2. **Split.** Edges longer than `split` at rest are cut at their middle, longest first, together with the triangles
   beside them. This keeps the resolution as the sheet grows. Floraform splits the longest edges the same way. The
   new edge to the opposite corner gets the median's rest length.
3. **Relax.** Position-based dynamics (Müller et al., 2007), repeated `iterations` times:
   - **Edge-length projection.**
   - **Bending.** Each vertex is pulled a little toward its neighbours' mean, along its normal only. This resists
     folding without shrinking the sheet.
   - **Collision.** Vertices not within two edges of each other are pushed to the `collision` distance, using a
     spatial hash. The default distance exceeds the longest edge, so no triangle slips between two vertices.

A flat sheet is a balance that growth alone never tips, so the first step adds a tiny seeded ruffle (2% of an edge)
across the plane. The same input always grows the same shape.

## Makeable

`thicken` takes every point within half the thickness of the sheet. It meshes that set by marching tetrahedra on its
distance field and relaxes the result (`Implicit`), so the output is always a closed 2-manifold with rounded rims.
`separate` checks two things: that the solid is one piece, and that its genus is the one a thickened copy of the
sheet has (1 − the sheet's Euler characteristic: 0 for a disc). Two folds that fused, or a fold through another,
would add a handle. Collision keeps folds apart by more than the thickness, which is what makes that hold.
`Makeable.check` gives the verdict, for SLS nylon or a cast, which is how Nervous System makes theirs.

## How it is checked (test/testGrowth.cjs)

* **Sheets.** The disc and rectangle sheets are one piece with one boundary (Euler characteristic 1).
* **Buckling.** A rim-growing disc more than doubles its area and buckles out of plane, by more than a third of its
  radius. It stays one piece with one boundary.
* **Partial growth.**
  - Pinned material stays put.
  - New vertices appear by the rim, where the material grew: more than 3 times as many there.
  - Near the centre there are hardly any.
* **Determinism.** The same input grows to identical vertices.
* **Directed growth.** Edges along the direction lengthen by more than 25%; across it, by less than 10%.
* **Makeable.** The thickened solid:
  - is closed;
  - has genus 0, as expected;
  - is one piece;
  - is makeable in SLS nylon;
  - has a median wall within 5% of the thickness asked.

## Gallery

`growth/growth-types.png` in the project files shows each kind of growth. The ruffle, the ridge, the mixed disc and
the one-point rim all thicken (1.2 mm) into solids that are separate, of genus 0, and makeable in SLS nylon.

## Limits (next steps)

* **Strong directed growth makes slivers.** Splits only halve long edges, so cells stretched one way stay thin across.
  - At a rate of 0.012, the frill crushed: its gap fell to 0.28. `thicken` caught it (the genus was wrong) and the
    verdict found sealed voids.
  - At 0.007 it holds, but it looks rough.

  Edge flips, as in Floraform, would fix this.

* **Vertex-to-vertex collision only.** It is enough while edges stay shorter than the collision distance, which the
  splits ensure. `separate` catches any failure.
* **Bending is an umbrella term, not the dihedral energy of Discrete Shells.** Folds come out a little crinkled at the
  scale of a triangle. Thickening and relaxing smooths that out.
* **No gravity or contact with a body yet.** Floraform uses both for its jellyfish pieces and its pieces that wrap a
  finger.
