# Contributing

## Repository shape

This is a single pnpm workspace (one lockfile), with packages sorted by
visibility: published **libraries** (`backend/packages/*` + `frontend/app`),
**private** packages (`backend/internal/*`), and example **deployments**
(`deploy/*`):

| Path                                 | Package                          | Published?                      |
| ------------------------------------ | -------------------------------- | ------------------------------- |
| `backend/packages/contracts`         | `@cat-factory/contracts`         | npm                             |
| `backend/packages/prompt-fragments`  | `@cat-factory/prompt-fragments`  | npm                             |
| `backend/packages/kernel`            | `@cat-factory/kernel`            | npm                             |
| `backend/packages/orchestration`     | `@cat-factory/orchestration`     | npm                             |
| `backend/packages/integrations`      | `@cat-factory/integrations`      | npm                             |
| `backend/packages/agents`            | `@cat-factory/agents`            | npm                             |
| `backend/packages/spend`             | `@cat-factory/spend`             | npm                             |
| `backend/packages/workspaces`        | `@cat-factory/workspaces`        | npm                             |
| `backend/packages/worker`            | `@cat-factory/worker`            | npm (Worker library)            |
| `frontend/app`                       | `@cat-factory/app`               | npm (Nuxt layer)                |
| `backend/internal/executor-harness`  | `@cat-factory/executor-harness`  | GHCR image (versioned, not npm) |
| `backend/internal/benchmark-harness` | `@cat-factory/benchmark-harness` | no (internal)                   |
| `deploy/backend`                     | `@cat-factory/deploy-backend`    | no (example deployment)         |
| `deploy/frontend`                    | `@cat-factory/deploy-frontend`   | no (example deployment)         |

The `deploy/*` packages depend on the libraries via `workspace:*` in this repo;
external organizations swap that for the published npm version (see each
`deploy/*/README.md`).

## Common commands

```sh
pnpm install            # one install for the whole workspace
pnpm build              # build the publishable libraries (dist)
pnpm typecheck          # typecheck every package
pnpm test               # run the unit/integration suites
pnpm lint               # oxlint + oxfmt (repo-wide)
pnpm dev:backend        # run the worker locally (deploy/backend)
pnpm dev:frontend       # run the SPA locally (deploy/frontend)
```

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

The `@cat-factory/executor-harness` package is not published to npm, but it
**is** versioned, and that version becomes the GHCR image tag. **Always add a
changeset bumping `@cat-factory/executor-harness` whenever you change anything
that goes into the runner image:**

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
