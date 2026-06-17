# Contributing

## Repository shape

This is a single pnpm workspace (one lockfile) split into reusable **libraries**
and example **deployments**:

| Path                                   | Package                            | Published?                      |
| -------------------------------------- | ---------------------------------- | ------------------------------- |
| `backend/packages/contracts`           | `@cat-factory/contracts`           | npm                             |
| `backend/packages/prompt-fragments`    | `@cat-factory/prompt-fragments`    | npm                             |
| `backend/packages/core`                | `@cat-factory/core`                | npm                             |
| `backend/packages/worker`              | `@cat-factory/worker`              | npm (Worker library)            |
| `backend/packages/implementer-harness` | `@cat-factory/implementer-harness` | GHCR image (versioned, not npm) |
| `backend/packages/benchmark-harness`   | `@cat-factory/benchmark-harness`   | no (internal)                   |
| `frontend/app`                         | `@cat-factory/app`                 | npm (Nuxt layer)                |
| `deploy/backend`                       | `@cat-factory/deploy-backend`      | no (example deployment)         |
| `deploy/frontend`                      | `@cat-factory/deploy-frontend`     | no (example deployment)         |

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

The `@cat-factory/implementer-harness` package is not published to npm, but it
**is** versioned, and that version becomes the GHCR image tag. **Always add a
changeset bumping `@cat-factory/implementer-harness` whenever you change anything
that goes into the runner image:**

- `backend/packages/implementer-harness/src/**`
- `backend/packages/implementer-harness/Dockerfile`
- `backend/packages/implementer-harness/tsconfig.json`
- the pinned `PI_VERSION` / `PI_TODO_EXTENSION_VERSION` build args

This keeps the published image tag in lockstep with the source that produced it.

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
'@cat-factory/core': minor
'@cat-factory/worker': patch
---

Add X to the execution service and surface it through the worker controller.
```

> **For AI agents:** treat the changeset as part of the change, not an
> afterthought. Before finishing any task that edits a versioned package, write
> the `.changeset/*.md` file: list each changed published/versioned package with
> the correct bump level, and apply the runner-image rule above. If the change
> ships no package code, add an empty changeset.
