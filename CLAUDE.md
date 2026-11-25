# CLAUDE.md

Read and follow [AGENTS.md](AGENTS.md). It holds the rules for every contributor, human or AI, including the
definition of done and the gates that may only get stricter.

Quick reference:

- `npm run check` before every push (the pre-push hook runs it).
- One spec: `npm run build && npx mocha --no-config --timeout 60000 test/<file>.cjs -g "<name>"`.
- Architecture: `docs/architecture.md`. Package boundaries: `docs/packages.md`.
