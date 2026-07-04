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
pnpm test               # run the unit/integration suites
pnpm lint               # oxlint + oxfmt (repo-wide)
pnpm dev:backend        # run the worker locally (deploy/backend)
pnpm dev:node           # run the Node.js service locally (deploy/node; needs DATABASE_URL)
pnpm dev:frontend       # run the SPA locally (deploy/frontend)
```

The cross-package task graph (build/typecheck/test/generate/deploy/dev) is
orchestrated by [Turborepo](https://turbo.build) (`turbo.json`): each task declares
`dependsOn: ["^build"]`, so a task never runs ahead of its workspace dependencies —
e.g. `@cat-factory/contracts` is always compiled before the frontend `nuxt generate`
resolves it. This replaces the per-package `pre*` build hooks the deploy packages
used to carry. The scripts above are thin wrappers over `turbo run …`, so unchanged
packages are served from Turbo's cache. The TypeScript libraries are still each
compiled by their own `tsc -b` project-reference build; Turbo only decides _which_
packages run and _in what order_. `pnpm build` is scoped to the backend libraries;
use `pnpm build:all` (or `turbo run build`) to also build the SPA and the internal
harnesses, and `pnpm build:tsc` for the raw `tsc -b` solution build.

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

- **patch** — bug fixes, internal refactors, doc/comment-only changes to a
  package's shipped code.
- **minor** — backwards-compatible new features / new exports.
- **major** — breaking changes to a package's public API or wire contract.

### Runner image changes — special rule

The `@cat-factory/executor-harness` package is published to npm (its
zero-dependency `dist/server.js` is the entry `@cat-factory/local-server`
spawns in local native mode), and it **is** versioned, and that same version
becomes the runner Docker image tag. **Always add a changeset bumping
`@cat-factory/executor-harness` whenever you change anything that goes into the
runner image:**

- `backend/internal/executor-harness/src/**`
- `backend/internal/executor-harness/Dockerfile`
- `backend/internal/executor-harness/tsconfig.json`
- the pinned `PI_VERSION` / `PI_TODO_EXTENSION_VERSION` build args

This keeps the published image tag in lockstep with the source that produced it.

### Publishing the runner image to Cloudflare (maintainer-only)

> This step is specific to **this** repo's own Cloudflare deployment — external
> orgs deploying the libraries do not need it, so it is documented here rather
> than in `deploy/*/README.md`.

CI publishes the runner image to **GHCR**, but Cloudflare Containers cannot pull
from GHCR (only the Cloudflare managed registry, Docker Hub, and ECR are
supported pull sources). So before deploying the backend, mirror the image into
the managed registry the Worker actually pulls from:

```sh
pnpm --filter @cat-factory/deploy-backend image:publish   # build + push to registry.cloudflare.com
pnpm --filter @cat-factory/deploy-backend deploy          # wrangler deploy
```

`image:publish` builds the harness `Dockerfile` and pushes it with
`wrangler containers build --push`; pin the `registry.cloudflare.com/...:<tag>`
ref it prints in `deploy/backend/wrangler.toml`. Bump the `:<tag>` in lockstep
with `@cat-factory/executor-harness`'s version whenever the image changes.

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
