# verb-nurbs-ts

A TypeScript NURBS library for generative design, forked from [verb](https://github.com/pboyer/verb) by Peter Boyer.

The goal is a small, open-source, Rhino/Grasshopper-like toolkit that runs in the browser and in Node: NURBS for form, NURBS booleans with exact trimmed seams, and watertight meshes as output, checked against [manifold-3d](https://github.com/elalish/manifold).

## What is here

* **The whole of verb, ported to TypeScript.** Upstream verb is written in Haxe and compiled to JavaScript. This fork replaces the Haxe sources with TypeScript (`src/`), compiled by `tsc` to an ES module with type declarations. All 325 upstream tests pass against the TypeScript build.
* **Offsets.** `Offset.curve` offsets planar curves; `Offset.surface` offsets surfaces along their normals (wall thickness). Both return a non-rational B-spline within a given tolerance of the exact offset, and handle rational inputs (circles, spheres) and degenerate points (sphere poles). Polylines are offset exactly with miter joins.
* **Sweeps on rotation-minimising frames.** `RotationMinimizingFrames` computes twist-free frames along any rail with the double reflection method, and on closed rails spreads the leftover rotation evenly so the frame closes up. `Sweep.surface` moves a profile along a rail, with optional twist and scale along the way; `Sweep.pipe` sweeps a circle of constant or varying radius. Both return a B-spline within a given tolerance of the exact sweep.
* **Fitting.** `Fit` interpolates curves and surfaces with chosen parameters and knot vectors, lofts compatible sections (`Fit.loft`), and builds closed, smooth periodic curves (`Fit.periodicCurve`).
* **Solids.** `TriMesh` is an indexed triangle mesh with a closed-manifold check, volume, STL/OBJ export and conversion to manifold-3d's `Mesh`. `Shell.openVessel` turns an outer and an inner wall into one watertight solid, and `Shell.tube` turns a swept surface into a capped solid (open rail) or a ring-shaped solid of genus 1 (closed rail).
* **NURBS booleans.** `BrepSolid` is a closed solid bounded by NURBS faces (capped tubes, capped walls). `BrepBoolean` computes union, intersection, difference, or any Boolean expression over any number of solids. Seams are surface/surface intersection curves refined onto both faces (to about 1e-9), carried as trim curves in each face's parameters, and shared vertex for vertex by the two faces, so the result is watertight. Seams may run across the edges between faces and meet at triple points, as in a notch through a rim. See [docs/booleans.md](docs/booleans.md) for the method and its current limits.
* **Free form or makeable.** Nothing forces a shape to be a solid: open sheets and self-crossing sweeps are fine for visual work (`Shell.sheet`). When a shape is meant to be fabricated, `Makeable.check(mesh, machine)` says whether it can be: a closed, outward-facing solid that fits the machine's build volume, with no wall thinner than the machine holds. Wall thickness is measured by inward ray casts through a bounding volume hierarchy (`MeshBVH`). Machine presets cover FDM, resin, SLS, 3-axis CNC and ceramic slip casting, and you can pass your own.
* **Primitive solids.** `Primitives` builds about seventy parameterised solids as exact closed B-reps: boxes and wedges, prisms over any profile (polygons, stars, rounded shapes, hearts, structural sections; straight, tapered, twisted or oblique), pyramids and frusta, cones, cylinders, spheres and their caps, zones and sectors, ellipsoids, capsules, paraboloids, lenses, tori, tubes, eggs and ogives, and the Platonic, Archimedean and Catalan polyhedra. Conics and quadrics are rational, so exact. They take part in Booleans, edge rounding and STEP export as they are. `Nodes` adds the surface builders of Grasshopper on curves (Plane Surface, 4Point Surface, Boundary Surfaces, Loft, Sweep1, Sweep2, Pipe with open, flat or round caps), each with a capped solid where the sections are closed. See [docs/primitives.md](docs/primitives.md).
* **Node graphs.** `Graph` compiles a JSON graph of nodes (numbers, math, every catalogued primitive, transforms, Booleans, rounds, shells) into a model document and builds it, rebuilding only what an edit changed; `npm run editor` is its visual editor. A graph can export several named parts and take parameters from outside. See [docs/visual-programming.md](docs/visual-programming.md); the file formats, their JSON Schemas and their stability rules are in [docs/formats.md](docs/formats.md).
* **Models.** `Model` regenerates a JSON document of parameters and features (boxes, cylinders, pipes, revolves, transforms, Booleans, rounds selected by edge name) into a solid, deterministically. Faces keep persistent names across edits, only what an edit changes is rebuilt, and every result says whether it is buildable or visual, and why. See [docs/model.md](docs/model.md).
* **STEP export.** `Step.write(result)` writes any closed B-rep result (Booleans, fillets, corners) as a STEP solid of trimmed NURBS faces with shared B-spline edges that lie on both faces. See [docs/step.md](docs/step.md).
* **Recipes.** `FreeformVesselRecipe` builds an Aalto-style free-form vessel end to end, `SweptObjectsRecipe` a torus-knot pipe, a twisted ring and a ribbon knot (a bare sheet at zero thickness), and `BooleanObjectsRecipe` a mug and a pierced vessel with NURBS booleans (see below).

## Install and build

```
npm install
npm run build     # tsc -> dist/
npm test          # build, then run all mocha tests
```

## Usage

```ts
import { Circle, SphericalSurface, Offset, FreeformVesselRecipe } from "verb-nurbs-ts";

// offset a circle outward by 1.5 (positive is to the right of the direction of travel)
const ring = new Circle([0, 0, 0], [1, 0, 0], [0, 1, 0], 5).offset(1.5);

// offset a surface 0.5 along its normal, to within 0.001, and see how close the fit is
const sphere = new SphericalSurface([0, 0, 0], 3);
const { result, maxError } = Offset.surface(sphere.asNurbs(), 0.5, { tolerance: 0.001 });

// a complete solid, ready for printing or for manifold-3d booleans
const vessel = FreeformVesselRecipe.build({ height: 180, wallThickness: 2.5 });
vessel.report.manifold.closedManifold; // true
const stl = vessel.mesh.toSTL();
```

The upstream namespace layout still works on the default export, so code written for verb keeps running:

```js
import verb from "verb-nurbs-ts";
const crv = verb.geom.NurbsCurve.byPoints([[0, 0, 0], [1, 1, 0], [2, 0, 0]], 2);
```

`dist/` is plain ES modules. The runtime dependencies are [cdt2d](https://github.com/mikolalysenko/cdt2d) (constrained Delaunay triangulation, used to tessellate trimmed faces) and its exact in-circle predicate robust-in-sphere; bundle it with esbuild or use an import map to load the library in a browser.

## Demo: a free-form vessel, validated as a manifold

```
npm run demo:vessel
```

This builds a vessel in the spirit of Alvar Aalto's 1936 glass vases: seven horizontal sections, each a closed C2 B-spline following an irregular folded outline that drifts with height, lofted into the outer wall. The inner wall is the outer wall offset inward by 3 mm, cut at a 4 mm floor. `Shell.openVessel` meshes the walls, the floors and the rim into a single watertight solid, which is checked twice: by `TriMesh.checkClosedManifold` (every edge shared by exactly two oppositely oriented triangles, genus 0) and by manifold-3d (status `NoError`). The STL, OBJ and a JSON report are written to `out/`.

All of its parameters (height, radii, lean, outline harmonics, wall and floor thickness, mesh resolution) can be passed to `FreeformVesselRecipe.build`.

## Demo: swept objects

```
npm run demo:sweeps
```

`SweptObjectsRecipe.knotPipe()` sweeps a circle whose radius swells and thins along a trefoil knot; `SweptObjectsRecipe.twistedRing()` sweeps a rounded-square section along a wavy ring with one full turn of twist. Both rails are closed, so both objects are genus 1 solids, checked by `TriMesh` and by manifold-3d.

## Demo: NURBS booleans

```
npm run demo:booleans
```

`BooleanObjectsRecipe.mug()` evaluates (body + handle) − cavity: the body is the solid inside a free-form outer wall, the handle a pipe swept along a C-shaped rail whose ends go through the wall, and the cavity the solid inside the inner wall, running a little above the rim. Subtracting the cavity opens the top and trims the handle's ends flush with the inner wall. `BooleanObjectsRecipe.pierced()` subtracts the cavity and 18 round tools from a vessel, and can notch its rim (`notches`). Both results are checked by `TriMesh` (watertight, genus 1 and genus 18) and by manifold-3d, whose own mesh boolean of the same operands gives the same genus and a volume within 0.02%.

New edges can be rounded with rolling-ball fillets: `BrepBoolean.union(solids, { fillet : 2 })`, or a function that
gives each edge its own radius. Concave edges are filled, as at the mug's handle joint (`mug({ fillet : 3 })`), and
convex ones are rounded off, as at the edges of the holes (`pierced({ fillet : 0.8 })`). The results stay watertight.
See [docs/booleans.md](docs/booleans.md#rolling-ball-fillets) for the method and its checks.

```ts
import { BrepSolid, BrepBoolean, Sweep, Make } from "verb-nurbs-ts";
const rod = (a, b, r) => BrepSolid.cappedTube(Sweep.pipe(Make.rationalBezierCurve([a, b]), r).surface, [24, 64]);
const a = rod([-30, 0, 0], [30, 0, 0], 10), b = rod([0, -30, 1], [0, 30, 1], 6);
const r = BrepBoolean.difference(a, [b]);
r.mesh;          // watertight TriMesh, genus 1
r.faces;         // trimmed faces: surface + trim loops in (u, v)
r.curves;        // the intersection curves, with parameters on both faces
// any expression: inside(body or handle) and not inside(cavity)
BrepBoolean.evaluate([body, handle, cavity], f => (f[0] || f[1]) && !f[2]);
```

## Demo: STEP export

```
npm run demo:step
```

Writes `out/step/rounded-box.step` (a box with curvature-continuous fillets and setback corners),
`out/step/boss.step` (a rod on a disc, its foot filleted) and `out/step/mug.step` (genus 1). Open them in any CAD
system. Each is a closed solid of the exact NURBS faces with shared B-spline edges; OpenCascade reads all three as
valid. See [docs/step.md](docs/step.md).

## Demo: an appliance in four parts

`ApplianceRecipe.build()` is an original kitchen-appliance study made of four separate solids, each checked as
makeable on its own:

* **the base**, which is (tapered block − sloped slab − conical seat − key pocket) + carry arch. The block is a loft
  of rounded-square sections. The sloped top is the flat end of a wide cylinder used as a cutting tool. The seat is
  the bowl's own cone, widened by the clearance. The arch is a soft rectangular section swept over the back. All five
  new edges are rolling-ball fillets: the top edge, the seat's edge and the pocket's edge are convex, the arch's feet
  concave.
* **the bowl**, a conical vessel with a sculpted grip and a keyed foot. The grip is a variable-section sweep: a soft
  superellipse, wider across the handle than it is thick, that swells halfway along (`MugParams.handleSection` and
  `handleSwell`). Three ribs grow out of the inner wall (`MugParams.ribs`): each narrows and dives into the wall at its ends, so it meets the wall in one closed loop, rounded by a concave fillet. The foot is a prism of an uneven three-lobed outline, joined with `MugParams.addons`. It drops into
  a pocket that is the same outline pushed out by the clearance, so the bowl only fits one way round.
* **the lid**, (plate + plug) − hollow − hole. The plate is a loft of a round outline with a three-lobed tab, drawn in
  at the top and bottom for a soft edge. The plug is a tapered ring that drops inside the rim. Both edges of the
  central hole are rounded.
* **the measuring cup**, (flange + body) − cavity. A teardrop flange (a soft-edged loft, drawn out into a pouring
  lip) rests on the lid; the tapered body plugs the hole with the clearance.

manifold-3d checks the fits: no overlap in place; a collision as soon as the bowl is pushed 1 mm deeper, turned by a
third of a turn, or the lid or the cup is moved 1 mm.

```ts
const a = ApplianceRecipe.build({ clearance : 0.6, topFillet : 10, gripSwell : 1.2 });
a.base.mesh; a.bowl.result.mesh; a.lid.mesh; a.cup.mesh;   // four watertight solids
a.bowlOffset;                                               // where the bowl (with its lid and cup) sits on the base
a.assembly;                                                 // all four, for display
```

## Node editor

```
npm run editor       # writes editor/dist/index.html, a single self-contained file
```

A visual programming editor on React Flow: number, math, primitive, transform, Boolean, round and shell nodes, wired
into a graph that is saved as JSON and built by `Graph` in a web worker. Only the nodes downstream of an edit are
rebuilt. It opens with a box that has a truncated cone taken out of it and its edges rounded. See
[docs/visual-programming.md](docs/visual-programming.md).

## Playground

```
npm run playground   # writes playground/dist/index.html, a single self-contained file
```

Open the file in a browser to shape the vessel, the knot pipe, the twisted ring, the mug, the pierced vessel, the ribbon knot, the four-part appliance, a block and a grown sheet with sliders. In **Free form** mode anything goes; in **Makeable** mode each final model is checked for the chosen machine, problems are listed in plain words, and the files can be downloaded only when the check passes. Each change builds a quick preview in a web worker, then a full-resolution model a moment later. The page shows the watertightness check, genus, volume and fit error, and downloads the solid as a binary STL.

* **B-rep models** (the mug, the pierced vessel, the appliance's four parts, the block) are judged in Makeable mode by
  the model verdict (`Model.verdict`, [docs/model.md](docs/model.md)): closed, outward, every fillet in place, and the
  machine's check. They also download as **STEP**. **Prove seams** runs the intersection certificate on them, which
  proves no seam between two faces was missed; it takes from half a minute to a few minutes, so it runs only when asked.
* The **block** is a model document (`Model`), not a recipe: a box with a bore, rounded by rules over its faces'
  persistent names, hollowed into an open tray or filled with a lattice inside a skin. Only the features a slider
  touches are rebuilt.
* The **grown sheet** is differential growth (`Growth`, [docs/growth.md](docs/growth.md)): a disc that grows at its
  rim, round its centre or everywhere, buckles into ruffles, and is thickened into a closed solid for the final model.

## Inspector

```
npm run viewer   # writes viewer/dist/index.html, a single self-contained file
```

A viewer that shows each kind of object as what it is:

* **NURBS curves**: the control polygon, control points (with their weights), knots on the curve, and a curvature comb.
* **NURBS surfaces**: the control net, knot lines (the edges of the polynomial patches), isocurves, normals, poles
  (sides of the domain that collapse to a point), and Gaussian or mean curvature as colour.
* **B-reps**: each trimmed face in its own colour and fillets in gold. Edges are told apart as trims, natural edges and
  seams, and fillets' contact curves are drawn. Click a face to list its surface's facts and see its control net.
  **Download STEP** saves the solid on show as a STEP file for any CAD system (see [docs/step.md](docs/step.md)).
* **Meshes**: the wireframe, open edges, non-manifold edges, and wall thickness as colour.

It comes with examples of each kind, and you can drop your own STL or OBJ mesh, or a NURBS curve or surface as
verb JSON. What it draws is built by `Inspect` (`Inspect.curve`, `.surface`, `.brep`, `.mesh`), which returns plain
arrays of layers and pickable items, so other front ends can use it too. A B-rep can be drawn on its export mesh
instead of its dense analysis mesh, `Inspect.brep( r.result, title, { mesh : r.export } )` after
`graph.evaluate( doc, { mesh : "view" } )`: the same faces, facts and picking, with its lines sampled to the mesh's
tolerance, about 25 times lighter (507's flywheel: 0.43 MB against 11.8 MB).

## Development

```
npm ci
npm run check      # strict typecheck, lint, build, and the full test suite (416 tests)
npm run coverage   # line coverage of src/ (about 95%), HTML report in coverage/
npm run docs       # API reference in docs/api/
```

CI runs the same steps on Node 20, 22 and 24, builds the demos and both web apps, and publishes the coverage report
and API docs as build artifacts. To take the code over, start with [docs/architecture.md](docs/architecture.md),
then read [CONTRIBUTING.md](CONTRIBUTING.md).

## Differences from upstream verb

* Only TypeScript/JavaScript is supported. The Haxe build and its C#, C++, Python and PHP targets are gone.
* `_Async` methods still return promises, but run on the calling thread. The web worker pool is not ported yet.
* `serialize` writes JSON instead of Haxe's serialization format.
* The HTML examples in `examples/`, the benchmarks and the docs site still refer to the old `build/js` bundle and have not been updated.

## License

MIT, like upstream verb. See [LICENSE](LICENSE).
