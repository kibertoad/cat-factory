# AGENTS.md

This repository's canonical agent guidance lives in **[`CLAUDE.md`](./CLAUDE.md)**: the
working rules (PR/branch discipline, "keep the runtimes symmetric", the no-N+1 rule, formatting,
changesets) and the cross-cutting runtime-flow narratives (execution, bootstrap, blueprints,
requirements review, the merge/gate lifecycle, telemetry). **Read `CLAUDE.md` first.**

## Finding your way around

- **What exists & where**: the complete package/runtime/deployment catalog is the layout
  tables in [`docs/repository-layout.md`](./docs/repository-layout.md) (guarded by
  `scripts/check-package-catalog.mjs` so it can't drift). Backend architecture:
  [`backend/README.md`](./backend/README.md).
- **Local orientation**: each `backend/packages/*`, `backend/runtimes/*` and `frontend/app` has
  its own `AGENTS.md` with that package's public entry point and a "where things live" map. Open
  the one next to the code you're editing. Each has a sibling `CLAUDE.md` that imports it
  (`@AGENTS.md`), so Claude Code loads it too; `scripts/check-agents-md-pairing.mjs` keeps the
  pairing from drifting.
- **Vocabulary & naming**: [`docs/glossary.md`](./docs/glossary.md) resolves the traps: `block`
  vs `task` vs `card`; the dir↔package name map (`runtimes/cloudflare` = `@cat-factory/worker`);
  `runner`/`executor`/`transport`/`provider`; and where the cross-cutting concepts (gates,
  agent kinds, D1⇄Drizzle migration parity) live.
- **Feature deep-dives**: the feature guide and topic index in
  [`docs/README.md`](./docs/README.md), and `backend/docs/*`.

## Non-negotiables (see `CLAUDE.md` for the full text)

- Format/lint the **whole tree** only: `pnpm exec oxfmt .` / `pnpm lint:fix`, never a file subset.
- Any change to one runtime facade must land the **symmetric** change in the others.
- Add a **changeset** for any change to a versioned package.
- Run `typecheck`/`test`/`build` through Turbo from the repo root.
- Test a targeted **scope**, never the whole tree: `pnpm test:changed`, `pnpm test:quick` or one
  `--filter`ed package. The full suite is CI's lane, and running it locally is banned.
