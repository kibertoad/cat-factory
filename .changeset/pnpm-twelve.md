---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Move the workspace to pnpm 12.5.1, in `packageManager` and in the UI runner image.

pnpm 12 is the Rust rewrite: same commands, settings and lockfile format, so the main document of
`pnpm-lock.yaml` re-resolves byte-identical. What it adds is a second lockfile document recording
`packageManagerDependencies`, the platform binaries pnpm self-manages for the pinned version, which
the `minimumReleaseAge` gate vets like any other entry. Nothing this repo does hits the 12.0
removals: no `--frozen-lockfile false` call site, no `--resolution-only`, no `.pnpmfile`, no
`pnpm.overrides` block, and `pnpm-workspace.yaml` passes the newly strict settings validation as it
stands.

The UI image's pnpm moves with the field, as it always has, so a repo under test builds with the
same manager CI does. Image content changed, so the harness version and every tag pin move with it.
