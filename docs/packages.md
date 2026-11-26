# Splitting into packages

The plan is for this library to become several packages in a monorepo. This note records the current module
boundaries and how they would map to packages, so new code respects them now.

## Layers today

| Folder | What it holds | Depends on |
|---|---|---|
| `core`, `eval` | NURBS data, evaluation, fitting, intersection, tessellation (upstream verb, plus `Fit`, `Sweep`, `Offset`, `Transfinite`, `Fair`, `THB`, `IGA`) | each other |
| `geom` | object wrappers (`NurbsCurve`, `NurbsSurface`, …) | core, eval, exe |
| `exe` | the worker dispatcher | nothing |
| `solid` | B-reps, surface/surface intersection, Booleans, fillets (new edges and own edges, `BrepEdges`), triangle meshes, makeability checks, implicit solids and lattices (`Implicit`) | core, eval |
| `recipes` | parametric objects (vessels, mug, appliance, …) | core, eval, solid |
| `model` | the feature tree: documents of parameters and features regenerated into named solids (`Model`, `Expr`) | core, eval, solid |
| `io` | file formats: STEP export of B-rep results (`Step`) | core, eval, solid |
| `view` | `Inspect`, display data for curves, surfaces, B-reps and meshes | core, eval, solid |
| `playground/`, `viewer/` | single-file web apps (three.js) | the library |

Dependencies only point down this table: no folder imports from one below it.

## Proposed packages

1. **nurbs**: `core`, `eval`, `geom`, `exe`. `core` and `eval` import each other (the bounding box trees in `core` use
   `eval`), as they did upstream, so they belong in one package.
2. **mesh**: `TriMesh`, `MeshBVH`, `Makeable`, `Implicit`. These depend only on `core/Data`, `core/Vec` and each other, so they
   can serve any mesh, not just ours.
3. **brep**: `Brep`, `SurfaceIntersect`, `BrepBoolean`, `Fillet`, `Shell`. Depends on nurbs and mesh.
4. **recipes**: depends on nurbs and brep.
5. **model**: `model/`. Depends on nurbs and brep. The modelling front end that recipes and apps build on.
6. **io**: `io/Step.ts`. Depends on nurbs and brep. It could live in brep; on its own it keeps file formats out of the
   modelling package, and new formats (IGES, 3MF) join it.
7. **inspect**: `view/Inspect.ts`, which turns objects into plain layers. Depends on nurbs, brep and mesh.
8. **apps**: the playground and the viewer, which depend on everything above and on three.js.

## Rules to keep the split easy

* Don't import from a layer above (for example `solid` must not import from `recipes` or `view`).
* `TriMesh`, `MeshBVH`, `Makeable` and `Implicit` import nothing from the B-rep code.
* Rendering code (three.js) stays in the apps; `Inspect` returns plain arrays.
* `src/index.ts` is generated; each package would get its own index the same way.

The first two rules are checked by `npm run layers` (`scripts/check-layers.mjs`), on every commit and in CI. The
table in that script is the source of truth: narrowing it is always fine, widening it needs a line here saying
why.
