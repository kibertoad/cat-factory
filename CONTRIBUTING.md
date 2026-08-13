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

## Where does a new doc go?

Two surfaces, and **ownership follows the reader**. Anyone who can act without cloning this repo
(deployers, operators, workspace users, integrators on the public API, the SDKs, MCP or manifests)
reads [catfactory.ai](https://www.catfactory.ai/), whose source is
[kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website). Anyone changing
the code reads the docs here.

Where a topic serves both, split it by DEPTH rather than copying: the website page owns the
user-facing account and the doc here keeps the internal design plus a link. **Land the website page
FIRST**, and only then reduce the doc here: a doc pointed at a page that does not exist yet is
strictly worse than the doc it replaced. And before removing a section, check what deep-links its
HEADING: error remedies build doc URLs in code (`config/docs.ts`, `vcs-errors.ts`,
`providers/docs.ts`), `scripts/check-doc-anchors.mjs` resolves them, and a remedy whose instruction
the website has taken over moves to `SITE_DOCS` rather than keeping a heading alive for it. The
named exceptions that stay in this repo whatever their audience, and the findings behind them, are in
[`docs/README.md`](./docs/README.md#where-does-a-new-doc-go) and
[ADR 0051](./backend/docs/adr/0051-documentation-repo-website-split.md).

Your PR's documentation sweep therefore has one extra question: **does this change alter behaviour a
website page describes?** If it does, say so in the PR so the website's `sync-docs` pass picks it up,
or open the website PR yourself.

## Common commands

**Node 24 or newer**, which the root `package.json` declares as `engines.node`. Below that is not
supported and not worked around: several entry points here are TypeScript run by Node's own type
stripping (on by default from 23.6), and the source targets that floor rather than the oldest
runtime it might meet.

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

**The Gatekeeper's Cloudflare OS leg is nightly CI only.** It boots a pinned commit of
`cloudflare/cloudflare-os` beside our Worker, so it needs a partner checkout no
ordinary PR should have to make, and a change on their side must never turn this
repository red: it lives in its own non-blocking workflow
(`.github/workflows/gatekeeper-os.yml`), like mutation testing. To run it on a branch,
dispatch that workflow, or clone the partner repository INSIDE this one (at
`.cloudflare-os`, which is gitignored, because wrangler's harness boots both Workers
under one root) and point `GATEKEEPER_OS_DIR` at it. The recipe is in
[`sdk/gatekeeper-worker/README.md`](./sdk/gatekeeper-worker/README.md). What it covers and why:
[ADR 0052](./backend/docs/adr/0052-cloudflare-os-gatekeeper.md).

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
zero-dependency `dist/harness-server.js` is the entry `@cat-factory/local-server`
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

This repo publishes the image but operates no deployment of its own; the mirror
step belongs to whoever runs a Cloudflare deployment, because Cloudflare
Containers cannot pull from GHCR. The recipe, the full pin list and the
release-PR re-sync behaviour live in
[`docs/internal/releases.md`](docs/internal/releases.md): that doc is the
authority, so extend it there rather than restating it here. The one rule that
binds every PR in this tree: the `cat-factory-executor:<tag>` pins move in
lockstep with `@cat-factory/executor-harness`'s version whenever the image
changes (`scripts/check-runner-image-tag.mjs` guards it).

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
