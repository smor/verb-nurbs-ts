# STEP export

`Step.write(result, options)` turns a `BooleanResult` (a Boolean, a filleted solid, any closed B-rep the library
builds) into an ISO 10303-21 file that CAD systems open as a solid: a `MANIFOLD_SOLID_BREP` whose `CLOSED_SHELL`
holds one `ADVANCED_FACE` per result face.

```js
import { BrepSolid, BrepEdges, BrepBoolean, Step } from "verb-nurbs-ts";
import { writeFileSync } from "node:fs";

const box = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
const edges = BrepEdges.all(box).map(e => ({ solid: 0, faces: e.faces, radius: 4 }));
const r = BrepBoolean.evaluate([box], f => f[0], { filletShape: "curvature", edges });
writeFileSync("box.step", Step.write(r, { name: "rounded box", tolerance: 0.01 }));
```

## What is in the file

| Entity | From |
|---|---|
| `B_SPLINE_SURFACE_WITH_KNOTS` (a complex entity with `RATIONAL_B_SPLINE_SURFACE` when weighted) | each face's surface, untouched |
| `ADVANCED_FACE` + `FACE_BOUND`s | the face, `same_sense` from a vote of its triangles' normals against the surface normal |
| `EDGE_LOOP` of `ORIENTED_EDGE`s | the face's boundary loops, face on the left |
| `EDGE_CURVE` on `B_SPLINE_CURVE_WITH_KNOTS` | an edge between two faces, shared by both |
| `VERTEX_POINT` | a point where three or more faces meet (or one point of a closed edge), where an edge crosses a seam, or a pole |
| `FACE_OUTER_BOUND` | the loop that bounds the largest area of the face's parameter rectangle |

The schema named is AP214 (`AUTOMOTIVE_DESIGN`), which every reader supports; these entities are the same in AP203
and AP242. Units are millimetres. The context carries the tolerance as its uncertainty.

## How edges are found and made exact

The B-rep written is the result's exact shell, built in `solid/` (`ShellBuilder.fromResult`, `src/solid/BrepShell.ts`;
see [exact-booleans.md](exact-booleans.md), step A2). `Step.writeShell` writes any shell as it is.

1. **Topology from the welded mesh.** Neighbouring faces share their boundary vertices exactly in the result's
   mesh. Each run of mesh edges between the same two faces, from a point where three or more faces meet to the next,
   is one edge. Loops follow from the edges' ends. The result passes Euler–Poincaré, `V − E + F − (L − F) = 2(1 − g)`
   (tested).
2. **Curves on the faces, not on the mesh.** A run is refined: between two points whose chord strays from the faces,
   a point is put on both faces by alternating projections onto the two surfaces. A projection starts from the
   nearest of samples placed uniformly and three to each knot span (a cap on a rounded rectangle, whose long sides
   take a tenth of its domain, is otherwise sampled once along a whole side), then follows Gauss–Newton steps that go
   down hill, stop just past a breakpoint where the surface is only C0, and slide along a side of the domain. Then a cubic B-spline is fitted to
   the refined run. Each step takes a quarter of the tolerance, so the curve lies within half of it of both faces.
3. **End points exact.** Each curve starts and ends exactly at its vertices, so the shell is closed by construction.
4. **Seams** (`src/solid/Seams.ts`). A surface closed in one direction (a pipe, a wall of revolution, a disc with a pole
   at its centre) is written with its closed flag set, and each face on it is cut along the surface's seam, where its
   parameter jumps from the end of the domain back to the start. Where a loop crosses the seam a vertex goes on its
   edge; the stretches of the seam inside the face (bounded by those crossings, or by a pole) become seam edges, which
   the face uses twice, once on each side of the cut. Every face is then a region of its parameter rectangle, which
   is what kernels expect: without the cut, OpenCascade read the mug as four shells. A cut can split a face in two:
   a ring round a hole that the seam passes through is cut above and below the hole into two halves. Each region
   (an outer loop that turns the way the largest loop does, with the holes inside it) is then written as a face of its
   own, and the seam stretches between them become ordinary edges between two faces on one surface. Without that,
   OpenCascade found the shelled mug's two rings round its handle's bore not closed.
   A surface closed in both directions (a torus) is cut along the one seam its face's loops go round, if only one: a
   belt groove's band round a pulley's axis (#116). A face whose loops go round both, or neither, is not cut.

The faces' own surfaces do not quite meet everywhere: a setback corner's parts are B-spline fits of a transfinite
patch, within 1e-3 of the largest radius. Its sides follow the neighbouring fillets' section curves (their exact
tangents go into the patch's ribbons), so where a corner meets a fillet the gap is a few micrometres. The tests check
every edge curve against both faces at 0.01 mm.

## Checking a file

What OpenCascade says (cadquery-ocp 8.0.1), reading each file with `STEPControl_Reader`. Volumes are
`BRepGProp.VolumeProperties` at eps 1e-6 against `report.volume`, which comes from the mesh.

| Model | Faces | Shells | `BRepCheck_Analyzer` | Seam edges | Volume | Max edge tolerance |
|---|---|---|---|---|---|---|
| Box with G2 fillets of radii 3, 4, 5 and setback corners | 66 | 1, closed | valid | 0 | +0.31% | 0.0082 |
| Rod on a disc, filleted | 6 | 1, closed | valid | 1 per face | +0.07% | 0.0055 |
| Mug (genus 1) | 8 | 1, closed | valid | 6 | +0.16% | 0.0029 |

`ShapeFix_Shape` changes none of them.

The volume gaps come from the mesh, not the file. The mesh is a chordal approximation, so its volume converges as
it is refined. The mug's mesh volume extrapolates to within 0.03% of OpenCascade's value, and the two surface areas
agree to 0.02%.

OpenCascade's default integration precision is too coarse on these B-spline faces: it gave +2.5% on the mug.

`test/testStep.cjs` checks the topology (each edge used once each way, loops closed, Euler's formula), the edge
curves (on both faces, ends at the vertices) and the file (every reference resolves, every `EDGE_CURVE` used once
forward and once reversed, every real written with a decimal point). A reader's own check is the final word:
OpenCascade's `STEPControl_Reader` with `BRepCheck_Analyzer`, and the volume from `BRepGProp` against
`report.volume`.

## Limits

* No p-curves written (`SURFACE_CURVE`/`PCURVE`): readers compute them from the 3D edges. The shell has them
  (`ShellEdge.pcurves`), so writing them is a matter of entities.
* One solid per file, no colours, no assembly structure.
* Faces on surfaces closed in both directions (a torus) are not cut; their loops are all written as `FACE_BOUND`.
