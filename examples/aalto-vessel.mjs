// Build the free-form vessel, validate it with manifold-3d, and write it out as STL and OBJ.
//
//   npm run build && node examples/aalto-vessel.mjs [outDir]

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Module from "manifold-3d";
import { FreeformVesselRecipe } from "../dist/index.js";

const outDir = process.argv[2] ?? "out";
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const vessel = FreeformVesselRecipe.build();
const ms = performance.now() - t0;

const wasm = await Module();
wasm.setup();
const solid = new wasm.Manifold(new wasm.Mesh(vessel.mesh.toManifoldMesh()));

const report = {
  buildMs: Math.round(ms),
  vertices: vessel.mesh.vertices.length,
  triangles: vessel.mesh.triangles.length,
  ...vessel.report,
  manifold3d: { status: solid.status(), genus: solid.genus(), volume: solid.volume(), surfaceArea: solid.surfaceArea() },
};
console.log(JSON.stringify(report, null, 2));

if (solid.status() !== "NoError" || !vessel.report.manifold.closedManifold) {
  console.error("vessel is not a valid manifold");
  process.exit(1);
}

writeFileSync(join(outDir, "aalto-vessel.stl"), vessel.mesh.toSTL("aalto-vessel"));
writeFileSync(join(outDir, "aalto-vessel.obj"), vessel.mesh.toOBJ());
writeFileSync(join(outDir, "aalto-vessel.report.json"), JSON.stringify(report, null, 2));
console.log("wrote " + join(outDir, "aalto-vessel.{stl,obj,report.json}"));
