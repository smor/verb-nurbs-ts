// Build the swept objects (a knot pipe and a twisted ring), validate them with manifold-3d and write STL files.
//
//   npm run build && node examples/swept-objects.mjs [outDir]

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Module from "manifold-3d";
import { SweptObjectsRecipe } from "../dist/index.js";

const outDir = process.argv[2] ?? "out";
mkdirSync(outDir, { recursive: true });
const wasm = await Module();
wasm.setup();

let ok = true;
for (const name of ["knotPipe", "twistedRing"]) {
  const t0 = performance.now();
  const obj = SweptObjectsRecipe[name]();
  const ms = Math.round(performance.now() - t0);
  const solid = new wasm.Manifold(new wasm.Mesh(obj.mesh.toManifoldMesh()));
  const report = { buildMs: ms, triangles: obj.mesh.triangles.length, ...obj.report, manifold3d: { status: solid.status(), genus: solid.genus(), volume: solid.volume() } };
  console.log(name, JSON.stringify(report, null, 2));
  if (solid.status() !== "NoError" || !obj.report.manifold.closedManifold) ok = false;
  writeFileSync(join(outDir, name + ".stl"), obj.mesh.toSTL(name));
}
if (!ok) { console.error("an object is not a valid manifold"); process.exit(1); }
console.log("wrote " + join(outDir, "{knotPipe,twistedRing}.stl"));
