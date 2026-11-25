# Splitting into packages

The plan is for this library to become several packages in a monorepo. This note records the current module
boundaries and how they would map to packages, so new code respects them now.

## Layers today

| Folder | What it holds | Depends on |
|---|---|---|
| `core`, `eval` | NURBS data, evaluation, fitting, intersection, tessellation (upstream verb, plus `Fit`, `Sweep`, `Offset`) | each other |
| `geom` | object wrappers (`NurbsCurve`, `NurbsSurface`, …) | core, eval, exe |
| `exe` | the worker dispatcher | nothing |
| `solid` | B-reps, surface/surface intersection, Booleans, fillets, triangle meshes, makeability checks | core, eval |
| `recipes` | parametric objects (vessels, mug, appliance, …) | core, eval, solid |
| `view` | `Inspect`, display data for curves, surfaces, B-reps and meshes | core, eval, solid |
| `playground/`, `viewer/` | single-file web apps (three.js) | the library |

Dependencies only point down this table: no folder imports from one below it.

## Proposed packages

1. **nurbs**: `core`, `eval`, `geom`, `exe`. `core` and `eval` import each other (the bounding box trees in `core` use
   `eval`), as they did upstream, so they belong in one package.
2. **mesh**: `TriMesh`, `MeshBVH`, `Makeable`. These three depend only on `core/Data`, `core/Vec` and each other, so they can
   serve any mesh, not just ours.
3. **brep**: `Brep`, `SurfaceIntersect`, `BrepBoolean`, `Fillet`, `Shell`. Depends on nurbs and mesh.
4. **recipes**: depends on nurbs and brep.
5. **inspect**: `view/Inspect.ts`, which turns objects into plain layers. Depends on nurbs, brep and mesh.
6. **apps**: the playground and the viewer, which depend on everything above and on three.js.

## Rules to keep the split easy

* Don't import from a layer above (for example `solid` must not import from `recipes` or `view`).
* `TriMesh`, `MeshBVH` and `Makeable` import nothing from the B-rep code.
* Rendering code (three.js) stays in the apps; `Inspect` returns plain arrays.
* `src/index.ts` is generated; each package would get its own index the same way.
