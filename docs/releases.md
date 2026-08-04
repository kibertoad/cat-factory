# Releases: the runner image and new published packages

Versioning is changesets (root `pnpm changeset` / `ci:publish`); the rule that every change to a
versioned package needs a changeset lives in CLAUDE.md. This doc holds the two release mechanics
with non-obvious failure modes: rolling out the runner image, and wiring a NEW published package
so it doesn't ship as an empty shell.

## Rolling out the runner image

**Any change to what goes into the runner image** (harness `src/**`, `Dockerfile`,
`tsconfig.json`, the pinned `PI_*` args) MUST bump `@cat-factory/executor-harness`'s version AND
the matching tag in `deploy/backend/package.json`, `deploy/backend/wrangler.toml`, and
`RECOMMENDED_HARNESS_IMAGE` in `backend/runtimes/local/src/harnessImage.ts`; then
`pnpm image:publish` + `pnpm deploy` from `deploy/backend`. The deployment serves the Cloudflare
managed-registry image, not GHCR, so the GHCR auto-publish does not roll it out.

**Reusing a tag does NOT deploy** (`wrangler deploy` diffs by tag string), leaving new containers
on stale code; the symptom is `Container dispatch failed (HTTP 404)`. Only a fresh immutable tag
forces the rollout.

The release PR re-syncs the pins automatically, so don't hand-fix a red release PR. Consequence:
the released tag may differ from the one the feature PR published; content is identical, but the
managed-registry image for the released tag is only built at the next `image:publish` + `deploy`.
`pnpm sync:image-tags` reconciles by hand; `scripts/check-runner-image-tag.mjs` is the CI guard.

## Adding a new published package

A folder is not wired up by existing (two packages once published as empty shells because a bare
`pnpm publish` skipped the build and `dist/` is gitignored).

- **Full publish contract in `package.json`**, copied from `packages/gates`: `"files": ["dist"]`,
  `main`/`types`/`exports` at `./dist`, `publishConfig.access: "public"`, a `build` script, and a
  mandatory **`"prepublishOnly": "pnpm run build"`** hook.
- **Register it in `backend/tsconfig.build.json`** `references`. A package reachable only
  transitively drops out the moment that reference goes away.
- **Add a changeset** and **a row in README.md's repository-layout tables** (CI guards both).
- **Check knip knows about a dynamically-imported dependency** (`ignoreDependencies` in
  `knip.jsonc`).

Verify with `rm -rf dist && pnpm publish --dry-run --no-git-checks` from the package dir.

## Related

- SDK publishing is gated on a VERSION CHANGE, not a file change; see
  [`sdk/README.md`](../sdk/README.md) and `.github/workflows/sdk-release.yml`.
- The `minimumReleaseAge` supply-chain gate on installs: CLAUDE.md, "Dependencies, releases, new
  packages".
