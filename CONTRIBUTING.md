# Contributing

## Setup

```
npm ci
npm run check      # typecheck, layer check, lint, build and the full test suite
```

`npm ci` also points git at the hooks in `.githooks/` (see below). Contributors of every kind, people and AI
agents alike, follow [AGENTS.md](AGENTS.md): the definition of done and the rules that keep the baseline.

Node 20 or later. The runtime dependencies are `cdt2d` and its exact predicate `robust-in-sphere`. `manifold-3d` is a dev dependency that independently
checks that solids are valid manifolds.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | `tsc` → `dist/` (ES modules, declarations, source maps) |
| `npm run typecheck` | strict type check without emitting |
| `npm run layers` | checks that every import points down the layer table in `scripts/check-layers.mjs` |
| `npm run ratchets` | checks that no gate was loosened relative to `origin/main` (or a base given as argument) |
| `npm run lint` | ESLint (`eslint.config.js`). Warnings are capped: the cap may go down, never up |
| `npm test` | build, then every mocha spec in `test/` |
| `npx mocha --no-config --timeout 60000 test/testFillet.cjs -g "box"` | one spec file, filtered by test name (after a build) |
| `npm run coverage` | tests with c8 coverage, mapped back to `src/` (`coverage/index.html`); fails below the thresholds |
| `npm run docs` | API reference with TypeDoc → `docs/api/` |
| `npm run viewer` / `npm run playground` | build the single-file web apps |

## Making a change

1. Read `docs/architecture.md` for the layer you are touching, and keep imports pointing down
   (`docs/packages.md`).
2. Write the test first. State the geometric property you guarantee, such as "the fillet meets both faces with G1
   continuity to 1e-6", and check it numerically.
3. Keep tolerances explicit: take a `tol` and pass it on.
4. `npm run check` must pass. CI runs the same steps, plus the demos, the apps and the API docs: on Node 22 for a pull
   request, and on Node 20, 22 and 24 on main, on release tags and on demand. Coverage (`npm run coverage`, which fails
   below its thresholds) runs on main, release tags and on demand; run it locally before a change that may lower it.

## Pull requests

Work is delivered as small, stacked pull requests. Each PR has one purpose and passing CI, and its description
explains the method, with a reference when there is one.

## Gates

Every gate runs locally and in CI, so a change that passes on your machine passes in CI.

| Gate | Local | CI |
|---|---|---|
| Strict type check | pre-commit hook, `npm run check` | `static` job |
| Layering | pre-commit hook, `npm run check` | `static` job |
| Lint, with a warning cap | pre-commit hook, `npm run check` | `static` job |
| No gate loosened | `npm run ratchets` | `static` job, on pull requests, against the target branch |
| Full test suite, no `.only` | pre-push hook, `npm run check` | `test` job: Node 22 on pull requests; 20, 22, 24 on main and releases |
| Coverage thresholds | `npm run coverage` | `test` job on Node 22, on main and releases |
| Demos, apps, API docs build | `npm run build`, `viewer`, `playground`, `docs` | `demos` job |

The thresholds are ratchets: the lint cap and the list of files exempt from the determinism rule only shrink,
coverage thresholds and compiler strictness only grow. When you improve a number, tighten its gate in the same
pull request so the gain is kept.

### Hooks

`.githooks/pre-commit` runs the type check, the layer check and lint (a few seconds). `.githooks/pre-push` runs
`npm run check`. `npm ci` installs them through the `prepare` script; to install them by hand, run
`git config core.hooksPath .githooks`. Use `--no-verify` only for a work-in-progress commit you will not push.

### Branch protection (maintainer)

The hooks can be skipped; CI cannot. To make CI binding, protect `main` on GitHub (Settings → Branches → Add
rule, or a ruleset):

- Require a pull request before merging. While there is one maintainer, set required approvals to 0: GitHub
  counts whoever's account pushed the commits (including an agent working through that account) as the author,
  and an author cannot approve their own pull request. With a second reviewer, require one approval and review
  from Code Owners (`.github/CODEOWNERS`).
- Require status checks to pass: `typecheck, layers, lint, ratchets`, `test (node 20)`, `test (node 22)`,
  `test (node 24)` and `demos, apps and API docs`. Require branches to be up to date before merging.
- Require conversation resolution, and block force pushes and deletions.
- Apply the rules to administrators too.
