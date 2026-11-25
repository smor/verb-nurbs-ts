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

1. **Topology from the welded mesh.** Neighbouring faces share their boundary vertices exactly in the result's
   mesh. Each run of mesh edges between the same two faces, from a point where three or more faces meet to the next,
   is one edge. Loops follow from the edges' ends. The result passes Euler–Poincaré, `V − E + F − (L − F) = 2(1 − g)`
   (tested).
2. **Curves on the faces, not on the mesh.** A run is refined: between two points whose chord strays from the faces,
   a point is put on both faces by alternating projections onto the two surfaces. Then a cubic B-spline is fitted to
   the refined run. Each step takes a quarter of the tolerance, so the curve lies within half of it of both faces.
3. **End points exact.** Each curve starts and ends exactly at its vertices, so the shell is closed by construction.
4. **Seams** (`src/io/Seams.ts`). A surface closed in one direction (a pipe, a wall of revolution, a disc with a pole
   at its centre) is written with its closed flag set, and each face on it is cut along the surface's seam, where its
   parameter jumps from the end of the domain back to the start. Where a loop crosses the seam a vertex goes on its
   edge; the stretches of the seam inside the face (bounded by those crossings, or by a pole) become seam edges, which
   the face uses twice, once on each side of the cut. Every face is then a region of its parameter rectangle, which
   is what kernels expect: without the cut, OpenCascade read the mug as four shells.

The faces' own surfaces do not quite meet everywhere: a setback corner's parts are B-spline fits of a transfinite
patch, within 1e-3 of the largest radius. Its sides follow the neighbouring fillets' section curves (their exact
tangents go into the patch's ribbons), so where a corner meets a fillet the gap is a few micrometres. The tests check
every edge curve against both faces at 0.01 mm.

## Checking a file

What OpenCascade 7.8 (cadquery-ocp) says, reading each file with `STEPControl_Reader`:

| Model | Faces | `BRepCheck_Analyzer` | Volume against `report.volume` | Max edge tolerance |
|---|---|---|---|---|
| Box, G2 fillets of radii 3, 4, 5 and setback corners | 66 | valid | +0.31% (the mesh's volume is a chordal approximation) | 0.0082 |
| Rod on a disc, filleted | 6 | valid | −0.04% | 0.0054 |
| Mug (genus 1) | 8 | see the PR | | |


`test/testStep.cjs` checks the topology (each edge used once each way, loops closed, Euler's formula), the edge
curves (on both faces, ends at the vertices) and the file (every reference resolves, every `EDGE_CURVE` used once
forward and once reversed, every real written with a decimal point). A reader's own check is the final word:
OpenCascade's `STEPControl_Reader` with `BRepCheck_Analyzer`, and the volume from `BRepGProp` against
`report.volume`.

## Limits

* No p-curves (`SURFACE_CURVE`/`PCURVE`): readers compute them from the 3D edges.
* One solid per file, no colours, no assembly structure.
* Faces on surfaces closed in both directions (a torus) are not cut; their loops are all written as `FACE_BOUND`.
