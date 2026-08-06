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

## Version numbers the registry has already spent

Five packages were hand-published at `1.0.0` on 2026-06-17, before changesets, from a tree whose
`dist/` had never been built. Versioning then restarted at `0.6.0`, leaving `1.0.0` stranded above
the whole 0.x line: never `latest`, never matched by a `^0.x` range, and invisible until a package
finally majored onto it.

`@cat-factory/prompt-fragments` did, on 2026-08-06. `changeset publish` reports "version 1.0.0 is
already published on npm" as a WARN and exits 0, and it says that same sentence about every package
a release did not bump, so the release went green: the real 1.0.0 never shipped, while `agents`,
`orchestration`, `worker`, `node-server` and `local-server` all published pinned EXACTLY to it (a
`workspace:*` dependency publishes as an exact version). Installing any of them resolved a package
with no `dist/`. It was fixed by moving past the number, to 1.0.1.

**These numbers are spent. Bump past them; never try to reclaim one.** Unpublishing is barred after
72 hours, and npm does not let an unpublished version be republished, so removing a shell would
burn the number harder rather than free it.

| package                         | spent   | what the registry holds                                                                                                                                           |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cat-factory/prompt-fragments` | `1.0.0` | no `dist/`; superseded by 1.0.1                                                                                                                                   |
| `@cat-factory/contracts`        | `1.0.0` | no `dist/`                                                                                                                                                        |
| `@cat-factory/worker`           | `1.0.0` | no `dist/`, migrations only                                                                                                                                       |
| `@cat-factory/app`              | `1.0.0` | a real but 2026-06-17-era snapshot: it publishes source, so the missing build cost it nothing                                                                     |
| `@cat-factory/core`             | `1.0.0` | no `dist/`, and it is still that name's only version and its `latest`. The package was split up afterwards, so nothing here produces it and nothing depends on it |

`scripts/check-release-versions.mjs` (the "Guard release versions" step in `repo-guards`) fails the
Release PR when a version it introduces is already on the registry, so the next one of these
surfaces before anything publishes rather than as a consumer's broken install. Detection lives in
`release-versions.mjs`, with fixtures in `release-versions.test.mjs`.

## Related

- SDK publishing is gated on a VERSION CHANGE, not a file change; see
  [`sdk/README.md`](../../sdk/README.md) and `.github/workflows/sdk-release.yml`.
- The `minimumReleaseAge` supply-chain gate on installs: CLAUDE.md, "Dependencies, releases, new
  packages".
