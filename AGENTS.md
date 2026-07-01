# AGENTS.md

This repository's canonical agent guidance lives in **[`CLAUDE.md`](./CLAUDE.md)** — the
working rules (PR/branch discipline, "keep the runtimes symmetric", the no-N+1 rule, formatting,
changesets) and the cross-cutting runtime-flow narratives (execution, bootstrap, blueprints,
requirements review, the merge/gate lifecycle, telemetry). **Read `CLAUDE.md` first.**

## Finding your way around

- **What exists & where** — the complete package/runtime/deployment catalog is the layout
  tables in [`README.md`](./README.md#repository-layout) (guarded by
  `scripts/check-package-catalog.mjs` so it can't drift). Backend architecture:
  [`backend/README.md`](./backend/README.md).
- **Local orientation** — each `backend/packages/*` and `backend/runtimes/*` has its own
  `AGENTS.md` with that package's public entry point and a "where things live" map. Open the
  one next to the code you're editing.
- **Vocabulary & naming** — [`docs/glossary.md`](./docs/glossary.md) resolves the traps: `block`
  vs `task` vs `card`; the dir↔package name map (`runtimes/cloudflare` = `@cat-factory/worker`);
  `runner`/`executor`/`transport`/`provider`; and where the cross-cutting concepts (gates,
  agent kinds, D1⇄Drizzle migration parity) live.
- **Feature deep-dives** — the Documentation index in [`README.md`](./README.md) and
  `backend/docs/*`.

## Non-negotiables (see `CLAUDE.md` for the full text)

- Format/lint the **whole tree** only: `pnpm exec oxfmt .` / `pnpm lint:fix` — never a file subset.
- Any change to one runtime facade must land the **symmetric** change in the others.
- Add a **changeset** for any change to a versioned package.
- Run `typecheck`/`test:run`/`build` through Turbo from the repo root.
