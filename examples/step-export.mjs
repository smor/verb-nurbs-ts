// Build three solids and write them as STEP files: a box with curvature-continuous fillets and setback corners, a
// rod on a disc with a filleted foot, and the mug (genus 1). Open them in any CAD system (FreeCAD, Fusion, Onshape...).
//
//   npm run demo:step [outDir]        (default: out/step)

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrepSolid, BrepEdges, BrepBoolean, BooleanObjectsRecipe, Make, Step, Sweep } from "../dist/index.js";

const outDir = process.argv[2] ?? join("out", "step");
mkdirSync(outDir, { recursive: true });

const line = (a, b) => Make.rationalBezierCurve([a, b]);
const models = {
  "rounded-box": () => {
    const box = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
    const edges = BrepEdges.all(box).map((e, k) => ({ solid: 0, faces: e.faces, radius: [3, 4, 5][k % 3] }));
    return BrepBoolean.evaluate([box], (f) => f[0], { filletShape: "curvature", edges });
  },
  boss: () => {
    const disc = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, -5], [0, 0, 5]), 30).surface, [8, 96]);
    const rod = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, 0], [0, 0, 30]), 8).surface, [24, 96]);
    return BrepBoolean.union([disc, rod], { fillet: 4 });
  },
  mug: () => BooleanObjectsRecipe.mug({ divsU: 32, divsV: 128 }).result,
};

let ok = true;
for (const [name, build] of Object.entries(models)) {
  const t0 = performance.now();
  const r = build();
  const text = Step.write(r, { name });
  const M = Step.model(r);
  const file = join(outDir, name + ".step");
  writeFileSync(file, text);
  const closed = r.report.manifold.closedManifold;
  ok &&= closed;
  console.log(JSON.stringify({
    file, closed, genus: r.report.manifold.genus, volume: Math.round(r.report.volume * 10) / 10,
    faces: M.faces.length, edges: M.edges.length, vertices: M.vertices.length,
    kB: Math.round(text.length / 1024), ms: Math.round(performance.now() - t0),
  }));
}
if (!ok) { console.error("a solid is not closed"); process.exit(1); }
