// Build the NURBS Boolean objects (a mug and a pierced vessel), validate them with manifold-3d and write STL files.
//
//   npm run build && node examples/boolean-objects.mjs [outDir]

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Module from "manifold-3d";
import { BooleanObjectsRecipe } from "../dist/index.js";

const outDir = process.argv[2] ?? "out";
mkdirSync(outDir, { recursive: true });
const wasm = await Module();
wasm.setup();
const toManifold = (mesh) => new wasm.Manifold(new wasm.Mesh(mesh.toManifoldMesh()));

let ok = true;
for (const name of ["mug", "pierced"]) {
  const t0 = performance.now();
  const obj = BooleanObjectsRecipe[name]();
  const ms = Math.round(performance.now() - t0);
  const r = obj.result;
  const solid = toManifold(r.mesh);
  // the same expression evaluated by manifold-3d on the tessellated operands, for comparison
  const ops = name === "mug" ? [obj.body, obj.handle, obj.cavity] : [obj.body, obj.cavity, ...obj.tools];
  const m = ops.map((s) => toManifold(s.tessellate()));
  const ref = name === "mug" ? m[0].add(m[1]).subtract(m[2]) : m.slice(1).reduce((a, b) => a.subtract(b), m[0]);
  const report = {
    buildMs: ms, triangles: r.mesh.triangles.length, trimmedFaces: r.faces.length, ...r.report,
    manifold3d: { status: solid.status(), genus: solid.genus(), volume: solid.volume() },
    manifold3dOnMeshes: { genus: ref.genus(), volume: ref.volume() },
  };
  console.log(name, JSON.stringify(report, null, 2));
  if (solid.status() !== "NoError" || !r.report.manifold.closedManifold || solid.genus() !== ref.genus()) ok = false;
  writeFileSync(join(outDir, name + ".stl"), r.mesh.toSTL(name));
}
if (!ok) { console.error("an object is not a valid manifold"); process.exit(1); }
console.log("wrote " + join(outDir, "{mug,pierced}.stl"));
