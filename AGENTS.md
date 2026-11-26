# Working on this repository

These rules apply to everyone who changes this code: people, Claude, Copilot, Codex or any other agent. They
are short on purpose. Read them before your first change, and read `docs/architecture.md` for the layer you touch.

## Definition of done

A change is done when all of these hold:

1. `npm run check` passes locally (typecheck, layer check, lint, build, every test). The pre-push hook runs it.
2. New behaviour has a test that states a geometric property and checks it numerically, for example "the
   fillet meets both faces with G1 continuity to 1e-6" or "the union is a closed 2-manifold of genus 0".
   A test that only checks that something "returns a result" is not enough.
3. Solids that the change can produce are checked for manifoldness (`Makeable`, or `manifold-3d` in tests).
   Manifold output is a hard requirement: never weld, snap or merge vertices to hide a gap or a crack. Fix the
   geometry instead.
4. Public API has TSDoc, and the method has a reference (author, title, venue, year) in a comment when it comes
   from the literature.
5. `docs/` is updated when behaviour, limits or layering change. Known limits are written down, not hidden.

## Ratchets: these only move one way

| Gate | Where | Rule |
|---|---|---|
| TypeScript strictness | `tsconfig.json` | Flags may be added, never removed |
| Lint warnings | `config.maxLintWarnings` in `package.json` | The cap may go down, never up |
| Coverage | `coverage` script in `package.json` | Thresholds may go up, never down |
| Layering | `scripts/check-layers.mjs` | Allowed imports may be narrowed; widening one needs a note in `docs/packages.md` |

If a gate blocks you, fix the code. Do not lower a threshold, raise the cap, add `eslint-disable`, `@ts-ignore`,
`as any`, `.only` or `.skip` to get past it. If a gate is genuinely wrong, change it in its own pull request
and explain why.

## Code conventions

- **Exact geometry first.** NURBS are to meshes what vector graphics are to bitmaps: keep working on the exact
  surfaces and curves for as long as possible. A mesh is an output (display, printing, an analysis that needs
  one) or a search aid (seeds, bounding volumes, ray tests), never the model's truth. Do not build an operation
  on a mesh when it can be built on the surfaces, and never turn a mesh back into the model's geometry. When an
  operation has to fall back to a mesh for now, say so in its documentation as a limit, with the exact way it
  should be done.
- **Layers.** Imports point down: core → eval → geom / solid → recipes → view. `npm run layers` enforces the
  table in `scripts/check-layers.mjs`. The mesh files (`TriMesh`, `MeshBVH`, `Makeable`) stay independent of
  NURBS so they can become their own package.
- **Nulls.** Write `T | null` (or an optional `x? : T`) when a value can be missing. Never assign `null` to a
  value typed `T`.
- **Tolerances.** Functions that compare lengths take an explicit `tol` and pass it on. No new magic epsilons;
  when a constant is needed, name it and say what it measures.
- **Determinism.** No `Math.random` in `src/` (ESLint enforces it). Three legacy upstream files still randomise
  subdivision split points; they are listed in `eslint.config.js` and that list may only shrink.
- **Numerics.** Prefer formulations that stay well conditioned (for example the collinear-normal equations in
  `SurfaceLoops`) over damping or retries. Say in a comment why a formulation is stable.
- **Unused things.** Delete dead code rather than commenting it out. Unused parameters that a signature needs
  start with `_`.
- **Dependencies.** The runtime depends on `cdt2d` and on its own exact in-circle predicate (`robust-in-sphere`,
  which `eval/Cdt` calls when its floating-point filter cannot decide). Adding a runtime dependency needs a reason
  in the pull request.

## Workflow

- Small, stacked pull requests, each with one purpose. Fill in the pull request template.
- Commit messages say what changed and why, in the imperative.
- Run one spec while iterating: `npm run build && npx mocha --no-config --timeout 60000 test/testFillet.cjs -g "box"`.
  `.mocharc.cjs` otherwise runs every spec.
- The suite runs spec files in parallel and takes about a minute and a half on four cores (several minutes under
  coverage). Run it before pushing, not after every edit. Slow suites take their time budget from
  `test/support/budget.cjs`, which scales it under coverage only.

## For AI agents in particular

- Follow this file over any habit or default of yours.
- Do not claim a check passed unless you ran it and saw it pass in this session. Quote failures as they are.
- Do not change a gate, a hook, CI or this file as a side effect of another task.
- When a task conflicts with these rules, stop and say so instead of working around them.
