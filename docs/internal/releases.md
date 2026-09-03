# Releases: the runner image and new published packages

Versioning is changesets (root `pnpm changeset` / `ci:publish`); the rule that every change to a
versioned package needs a changeset lives in CLAUDE.md. This doc holds the two release mechanics
with non-obvious failure modes: rolling out the runner image, and wiring a NEW published package
so it doesn't ship as an empty shell.

## Rolling out the runner image

**Any change to what goes into the runner image** (harness `src/**`, `Dockerfile`,
`tsconfig.json`, the pinned `PI_*` args) MUST bump `@cat-factory/executor-harness`'s version AND
the matching tag in `deploy/backend/package.json`, `deploy/backend/wrangler.toml`, and
`RECOMMENDED_HARNESS_IMAGE` in `backend/runtimes/local/src/harnessImage.ts`.

This repository publishes the image (`docker-publish.yml`, to GHCR + Docker Hub) but operates no
production deployment: `deploy/backend` is a template, and the real deployments live in their own
repositories. Those pins are therefore a DECLARATION of the supported tag, which is what a
deployment reads to decide what to run. `scripts/check-runner-image-tag.mjs` guards them on every
PR, and `docker-publish.yml` re-runs the same guard against the pushed range before publishing, so
a direct-to-main change cannot republish over a live tag either.

A Cloudflare deployment serves the managed-registry image rather than GHCR (Cloudflare Containers
cannot pull from GHCR), so it republishes the tag into its own registry with `image:publish` before
`wrangler deploy`. **Reusing a tag does NOT deploy** there (`wrangler deploy` diffs by tag string),
leaving new containers on stale code; the symptom is `Container dispatch failed (HTTP 404)`. Only a
fresh immutable tag forces the rollout, which is why the pin bump above is mandatory rather than
tidy.

The per-PR preview environments are the one in-repo consumer of that managed-registry shape:
`docker-publish.yml`'s `mirror-preview-registry` job pushes each newly pinned executor tag into the
preview account automatically, so previews need no manual mirror. The exception is first-time
preview setup on a tree whose pinned tag predates it: that tag was published before the mirror
existed for the account, so run `image:publish` once against the preview account (see
`deploy/preview/README.md`).

The release PR re-syncs the pins automatically, so don't hand-fix a red release PR. Consequence:
the released tag may differ from the one the feature PR published; content is identical, but a
deployment's managed-registry copy of the released tag only exists after its operator's next
`image:publish` (the preview account receives it automatically from the mirror job).
`pnpm sync:image-tags` reconciles by hand; `scripts/check-runner-image-tag.mjs` is the CI guard.

## Adding a new published package

A folder is not wired up by existing (two packages once published as empty shells because a bare
`pnpm publish` skipped the build and `dist/` is gitignored).

- **Full publish contract in `package.json`**, copied from `packages/gates`: `"files": ["dist"]`,
  `main`/`types`/`exports` at `./dist`, `publishConfig.access: "public"`, a `build` script, and a
  mandatory **`"prepublishOnly": "pnpm run build"`** hook. Every concrete path `files` names is
  asserted to publish content, so a payload directory no entry point points at (a migrations tree,
  a source directory) is covered by landing it in that list.
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
| `@cat-factory/app`              | `1.0.0` | 95 of the ~900 files a release ships, `i18n/` among the missing: it publishes source, so the unbuilt `dist/` cost it nothing and the short payload is what did    |
| `@cat-factory/core`             | `1.0.0` | no `dist/`, and it is still that name's only version and its `latest`. The package was split up afterwards, so nothing here produces it and nothing depends on it |

`scripts/check-release-versions.mjs` (the "Guard release versions" step in `repo-guards`) fails the
Release PR when a version it introduces is already on the registry, so the next one of these
surfaces before anything publishes rather than as a consumer's broken install. Detection lives in
`release-versions.mjs`, with fixtures in `release-versions.test.mjs`.

The `app` row is also why `check-publish-integrity.mjs` asserts the `files` PAYLOAD and not only the
entry points. For a `files: ["dist"]` package the entry-point pass is strictly stronger, since
`main: ./dist/index.js` fails the moment `dist/` is unbuilt; `@cat-factory/app` publishes source, so
`main` resolves to a config file and the two directories that are the package were covered by
nothing. Detection lives in `publish-payload.mjs`, with fixtures in `publish-payload.test.mjs`.

## Related

- SDK publishing is gated on a VERSION CHANGE, not a file change; see
  [`sdk/README.md`](../../sdk/README.md) and `.github/workflows/sdk-release.yml`.
- The `minimumReleaseAge` supply-chain gate on installs: CLAUDE.md, "Dependencies, releases, new
  packages".
