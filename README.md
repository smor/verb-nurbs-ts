# verb-nurbs-ts

A TypeScript NURBS library for generative design, forked from [verb](https://github.com/pboyer/verb) by Peter Boyer.

The goal is a small, open-source, Rhino/Grasshopper-like toolkit that runs in the browser and in Node: NURBS for form, with watertight meshes as output so that mesh booleans (through [manifold-3d](https://github.com/elalish/manifold)) can finish the job.

## What is here

* **The whole of verb, ported to TypeScript.** Upstream verb is written in Haxe and compiled to JavaScript. This fork replaces the Haxe sources with TypeScript (`src/`), compiled by `tsc` to an ES module with type declarations. All 325 upstream tests pass against the TypeScript build.
* **Offsets.** `Offset.curve` offsets planar curves; `Offset.surface` offsets surfaces along their normals (wall thickness). Both return a non-rational B-spline within a given tolerance of the exact offset, and handle rational inputs (circles, spheres) and degenerate points (sphere poles). Polylines are offset exactly with miter joins.
* **Sweeps on rotation-minimising frames.** `RotationMinimizingFrames` computes twist-free frames along any rail with the double reflection method, and on closed rails spreads the leftover rotation evenly so the frame closes up. `Sweep.surface` moves a profile along a rail, with optional twist and scale along the way; `Sweep.pipe` sweeps a circle of constant or varying radius. Both return a B-spline within a given tolerance of the exact sweep.
* **Fitting.** `Fit` interpolates curves and surfaces with chosen parameters and knot vectors, lofts compatible sections (`Fit.loft`), and builds closed, smooth periodic curves (`Fit.periodicCurve`).
* **Solids.** `TriMesh` is an indexed triangle mesh with a closed-manifold check, volume, STL/OBJ export and conversion to manifold-3d's `Mesh`. `Shell.openVessel` turns an outer and an inner wall into one watertight solid, and `Shell.tube` turns a swept surface into a capped solid (open rail) or a ring-shaped solid of genus 1 (closed rail).
* **Recipes.** `FreeformVesselRecipe` builds an Aalto-style free-form vessel end to end, and `SweptObjectsRecipe` a torus-knot pipe and a twisted ring (see below).

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

`dist/` is plain ES modules without dependencies, so it loads directly in a browser with `<script type="module">`.

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

## Differences from upstream verb

* Only TypeScript/JavaScript is supported. The Haxe build and its C#, C++, Python and PHP targets are gone.
* `_Async` methods still return promises, but run on the calling thread. The web worker pool is not ported yet.
* `serialize` writes JSON instead of Haxe's serialization format.
* The HTML examples in `examples/`, the benchmarks and the docs site still refer to the old `build/js` bundle and have not been updated.

## License

MIT, like upstream verb. See [LICENSE](LICENSE).
