# Contributing

## Setup

```
npm ci
npm run check      # typecheck, lint, build and the full test suite
```

Node 20 or later. The only runtime dependency is `cdt2d`. `manifold-3d` is a dev dependency that independently
checks that solids are valid manifolds.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | `tsc` → `dist/` (ES modules, declarations, source maps) |
| `npm run typecheck` | strict type check without emitting |
| `npm run lint` | ESLint (`eslint.config.js`). Warnings are capped: the cap may go down, never up |
| `npm test` | build, then every mocha spec in `test/` |
| `npx mocha --no-config --timeout 60000 test/testFillet.cjs -g "box"` | one spec file, filtered by test name (after a build) |
| `npm run coverage` | tests with c8 coverage, mapped back to `src/` (`coverage/index.html`) |
| `npm run docs` | API reference with TypeDoc → `docs/api/` |
| `npm run viewer` / `npm run playground` | build the single-file web apps |

## Making a change

1. Read `docs/architecture.md` for the layer you are touching, and keep imports pointing down
   (`docs/packages.md`).
2. Write the test first. State the geometric property you guarantee, such as "the fillet meets both faces with G1
   continuity to 1e-6", and check it numerically.
3. Keep tolerances explicit: take a `tol` and pass it on.
4. `npm run check` must pass. CI runs the same steps on Node 20, 22 and 24, plus the demos, the apps and the API
   docs.

## Pull requests

Work is delivered as small, stacked pull requests. Each PR has one purpose and passing CI, and its description
explains the method, with a reference when there is one.
