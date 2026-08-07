# Contributing

## Repository shape

This is a single pnpm workspace (one lockfile), with packages sorted by
visibility: published **libraries** (`backend/packages/*` + `frontend/app`), the
**runtime facades** (one per deployment target, `backend/runtimes/*`), **private**
packages (`backend/internal/*`), and example **deployments** (`deploy/*`):

| Path                                    | Package                             | Published?                     |
| --------------------------------------- | ----------------------------------- | ------------------------------ |
| `backend/packages/cli`                  | `@cat-factory/cli`                  | npm (bootstrap CLI)            |
| `backend/packages/contracts`            | `@cat-factory/contracts`            | npm                            |
| `backend/packages/prompt-fragments`     | `@cat-factory/prompt-fragments`     | npm                            |
| `backend/packages/kernel`               | `@cat-factory/kernel`               | npm                            |
| `backend/packages/orchestration`        | `@cat-factory/orchestration`        | npm                            |
| `backend/packages/integrations`         | `@cat-factory/integrations`         | npm                            |
| `backend/packages/agents`               | `@cat-factory/agents`               | npm                            |
| `backend/packages/provider-bedrock`     | `@cat-factory/provider-bedrock`     | npm                            |
| `backend/packages/spend`                | `@cat-factory/spend`                | npm                            |
| `backend/packages/workspaces`           | `@cat-factory/workspaces`           | npm                            |
| `backend/packages/server`               | `@cat-factory/server`               | npm (shared HTTP layer)        |
| `backend/runtimes/cloudflare`           | `@cat-factory/worker`               | npm (Cloudflare Worker facade) |
| `backend/runtimes/node`                 | `@cat-factory/node-server`          | npm (Node.js service facade)   |
| `frontend/app`                          | `@cat-factory/app`                  | npm (Nuxt layer)               |
| `backend/internal/executor-harness`     | `@cat-factory/executor-harness`     | npm + GHCR/Docker Hub image    |
| `backend/internal/benchmark-harness`    | `@cat-factory/benchmark-harness`    | no (internal)                  |
| `backend/internal/smoketest-harness`    | `@cat-factory/smoketest-harness`    | no (internal)                  |
| `backend/internal/conformance`          | `@cat-factory/conformance`          | no (internal test suite)       |
| `backend/internal/example-custom-agent` | `@cat-factory/example-custom-agent` | no (worked example)            |
| `deploy/backend`                        | `@cat-factory/deploy-backend`       | no (example deployment)        |
| `deploy/node`                           | `@cat-factory/deploy-node`          | no (example deployment)        |
| `deploy/frontend`                       | `@cat-factory/deploy-frontend`      | no (example deployment)        |

The `deploy/*` packages depend on the libraries via `workspace:*` in this repo;
external organizations swap that for the published npm version (see each
`deploy/*/README.md`).

## Common commands

```sh
pnpm install            # one install for the whole workspace
pnpm build              # build the publishable libraries (dist)
pnpm build:all          # also build the SPA + internal harnesses
pnpm typecheck          # typecheck every package
pnpm test               # run the unit/integration suites (mutation testing is NOT in here)
pnpm lint               # oxlint + oxfmt (repo-wide)
pnpm dev:backend        # run the worker locally (deploy/backend)
pnpm dev:node           # run the Node.js service locally (deploy/node; needs DATABASE_URL)
pnpm dev:frontend       # run the SPA locally (deploy/frontend)
```

The cross-package task graph (build/typecheck/test/generate/deploy/dev) is
orchestrated by [Turborepo](https://turbo.build) (`turbo.json`): each task declares
`dependsOn: ["^build"]`, so a task never runs ahead of its workspace dependencies:
e.g. `@cat-factory/contracts` is always compiled before the frontend `nuxt generate`
resolves it. This replaces the per-package `pre*` build hooks the deploy packages
used to carry. The scripts above are thin wrappers over `turbo run …`, so unchanged
packages are served from Turbo's cache. The TypeScript libraries are still each
compiled by their own `tsc -b` project-reference build; Turbo only decides _which_
packages run and _in what order_. `pnpm build` is scoped to the backend libraries;
use `pnpm build:all` (or `turbo run build`) to also build the SPA and the internal
harnesses, and `pnpm build:tsc` for the raw `tsc -b` solution build.

**Mutation testing is nightly CI only, never a local step.** Stryker re-runs a
package's suite once per mutant, so a run costs minutes of CPU per package: it lives
in its own non-blocking workflow (`.github/workflows/mutation.yml`) and no local
command you need for a PR runs it. To measure a branch, dispatch that workflow on it.
Which packages are covered, how to add one, and how to read a surviving mutant:
[`docs/internal/mutation-testing.md`](./docs/internal/mutation-testing.md).

**The Node and Local facade suites need a real Postgres, and Turbo will not pass
`DATABASE_URL` through to them.** Without a server they fail with `DATABASE_URL is
required to run the local conformance tests` while every other task passes, and
exporting the variable is not enough on its own. The setup, both traps, and how to
start a cluster where no Docker daemon is running:
[`docs/internal/running-tests.md`](./docs/internal/running-tests.md).

## Changesets (REQUIRED)

Releases are managed with [changesets](https://github.com/changesets/changesets).
**Every PR that changes a versioned package must include a changeset.** CI fails
the PR otherwise (`changeset status`).

Create one and commit it with your PR:

```sh
pnpm changeset
```

Choose the affected packages, the bump level, and a one-line summary. On merge to
`main`, the Release workflow opens/updates a "Release Packages" PR; merging that
PR versions the packages, writes changelogs, publishes the public ones to npm,
and (because the version bump touches `package.json`) republishes the runner
image to GHCR.

### Picking a bump level

- **patch**: bug fixes, internal refactors, doc/comment-only changes to a
  package's shipped code.
- **minor**: backwards-compatible new features / new exports.
- **major**: breaking changes to a package's public API or wire contract.

### Runner image changes: special rule

The `@cat-factory/executor-harness` package is published to npm (its
zero-dependency `dist/server.js` is the entry `@cat-factory/local-server`
spawns in local native mode), it **is** versioned, and that same version
becomes the runner Docker image tag. **Always add a changeset bumping
`@cat-factory/executor-harness` whenever you change anything that goes into the
runner image:**

- `backend/internal/executor-harness/src/**`
- `backend/internal/executor-harness/Dockerfile`
- `backend/internal/executor-harness/tsconfig.json`
- the pinned `PI_VERSION` / `PI_TODO_EXTENSION_VERSION` build args

This keeps the published image tag in lockstep with the source that produced it.

### Mirroring the runner image into a Cloudflare account

> This repo publishes the image but deploys nothing. The step below belongs to
> whoever operates a Cloudflare deployment; it is documented here because the
> `image:publish` script and the tag pins it depends on live in this tree.

CI publishes the runner image to **GHCR**, but Cloudflare Containers cannot pull
from GHCR (only the Cloudflare managed registry, Docker Hub, and ECR are
supported pull sources). So before deploying a Worker, the operator mirrors the
image into the managed registry that Worker pulls from:

```sh
pnpm --filter @cat-factory/deploy-backend image:publish   # build + push to registry.cloudflare.com
pnpm --filter @cat-factory/deploy-backend deploy          # wrangler deploy
```

`image:publish` builds the harness `Dockerfile` and pushes it with
`wrangler containers build --push`, printing a
`registry.cloudflare.com/<account-id>/...:<tag>` ref to pin in that deployment's
`wrangler.toml`. In this repo, `deploy/backend/wrangler.toml` holds the same pin
as a placeholder-account TEMPLATE, and its `:<tag>` must move in lockstep with
`@cat-factory/executor-harness`'s version whenever the image changes: that tag is
what tells a deployment which image the release supports.

### Changes that need no release

For docs, CI, or test-only changes that touch no shipped package code, record
that intent with an empty changeset so CI passes:

```sh
pnpm changeset --empty
```

### Changeset file format

A changeset is a markdown file in `.changeset/` with YAML front-matter mapping
package names to bump levels, followed by the summary:

```md
---
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
---

Add X to the execution service and surface it through the worker controller.
```

> **For AI agents:** treat the changeset as part of the change, not an
> afterthought. Before finishing any task that edits a versioned package, write
> the `.changeset/*.md` file: list each changed published/versioned package with
> the correct bump level, and apply the runner-image rule above. If the change
> ships no package code, add an empty changeset.
