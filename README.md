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

`dist/` is plain ES modules. The only runtime dependency is [cdt2d](https://github.com/mikolalysenko/cdt2d) (constrained Delaunay triangulation, used to tessellate trimmed faces); bundle it with esbuild or use an import map to load the library in a browser.

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

## Playground

```
npm run playground   # writes playground/dist/index.html, a single self-contained file
```

Open the file in a browser to shape the vessel, the knot pipe, the twisted ring, the mug, the pierced vessel and the ribbon knot with sliders. In **Free form** mode anything goes; in **Makeable** mode each final model is checked for the chosen machine, problems are listed in plain words, and the STL can be downloaded only when the check passes. Each change builds a quick preview in a web worker, then a full-resolution model a moment later. The page shows the watertightness check, genus, volume and fit error, and downloads the solid as a binary STL.

## Differences from upstream verb

* Only TypeScript/JavaScript is supported. The Haxe build and its C#, C++, Python and PHP targets are gone.
* `_Async` methods still return promises, but run on the calling thread. The web worker pool is not ported yet.
* `serialize` writes JSON instead of Haxe's serialization format.
* The HTML examples in `examples/`, the benchmarks and the docs site still refer to the old `build/js` bundle and have not been updated.

## License

MIT, like upstream verb. See [LICENSE](LICENSE).
