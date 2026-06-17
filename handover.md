# Handover — splitting `@cat-factory/core` into scoped packages

**Status:** Step 1 complete (commit `e208ae6`). Proceed with Step 2.
**Prereqs landed:** the internal/published package separation (this branch —
`reshape/internal-public-split`) and the core dedup (PR #54,
`refactor/core-dedup`). Both are independent of this work and can be merged in
any order.

**Step 1 done:** `@cat-factory/kernel` extracted — domain/*, shared/*, ports/*,
and `requireWorkspace` moved; `@cat-factory/core` re-exports kernel for backward
compat; both pass typecheck; changeset in `.changeset/kernel-extract.md`.

---

## 1. Why

`@cat-factory/core` is a kitchen-sink package: ~98 files / ~12k LOC spanning the
domain kernel, agent prompts, spend metering, five external-system integrations,
and the whole delivery-workflow engine. It has **one** published artifact, so any
consumer that needs one small thing takes a dependency on **everything**.

The concrete symptom that surfaced this: the container-acceptance CI job
(`ci.yml` → "Container acceptance (Docker)") is gated on `backend/packages/core/**`
because the acceptance harness imports `SpendService` + `DEFAULT_SPEND_PRICING`
from core (`backend/internal/implementer-harness/test/acceptance/real-proxy.acceptance.test.ts`).
A pure refactor anywhere in core — even one untouched by the test — rebuilds the
Docker image and runs the full clone→Pi→push acceptance cycle. The dependency is
real (the test uses core's spend logic); the **granularity** is wrong.

Splitting core lets each consumer depend on the leaf it actually needs, makes CI
path-gating precise, gives each package a one-line responsibility, and turns
today's layering-by-convention into layering the compiler enforces.

## 2. Current state (after the prereq work)

Packages are now sorted by visibility (see `CONTRIBUTING.md` table):

```
backend/packages/      PUBLIC, npm-published libraries
  contracts  core  prompt-fragments  worker
backend/internal/      PRIVATE (this branch moved these here)
  implementer-harness  benchmark-harness
frontend/app           PUBLIC (Nuxt layer)
deploy/                PRIVATE example deployments
  backend  frontend
```

The new core packages from this split are all **public libraries** → they land in
`backend/packages/*`.

## 3. Target decomposition

Dependencies point **down only**. Package boundaries make that a compiler rule.

```
@cat-factory/contracts                         (exists — wire types & validation)
        ▲
@cat-factory/kernel        domain/* , shared/* , ports/* , requireWorkspace guard
        ▲                  (pure vocab + logic + port interfaces; zero services)
   ┌────┴──────┬───────────────┬───────────────────────┐
@spend      @agents        @integrations          @workspaces
                                                  (+accounts — tenancy base)
   └───────────┴───────────────┴───────────────────────┘
                            ▲
                @cat-factory/orchestration   execution, bootstrap, pipelines,
                            ▲                  board, boardScan, requirements
                @cat-factory/worker          (exists — composition root + controllers)
```

### What moves where (from `backend/packages/core/src`)

| New package | Absorbs | Depends on | Responsibility |
|---|---|---|---|
| `@cat-factory/kernel` | `domain/*`, `shared/*`, `ports/*`, the `requireWorkspace` guard (pull the pure guard out of `modules/workspaces/WorkspaceService.ts`) | contracts | Shared vocabulary, pure logic, port interfaces |
| `@cat-factory/spend` | `modules/spend/*` | kernel | Pricing tables + spend metering/gating |
| `@cat-factory/agents` | `modules/agents/*`, `modules/fragmentLibrary/*` | kernel, prompt-fragments, `ai` | Agent catalog, routing, prompts, fragment library |
| `@cat-factory/integrations` | `modules/github/*`, `modules/documents/*`, `modules/tasks/*`, `modules/environments/*`, `modules/runners/*` | kernel | External-system adapters' domain logic |
| `@cat-factory/workspaces` | `modules/workspaces/*`, `modules/accounts/*` | kernel | Tenancy base services |
| `@cat-factory/orchestration` | `modules/execution/*`, `modules/bootstrap/*`, `modules/pipelines/*`, `modules/board/*`, `modules/boardScan/*`, `modules/requirements/*` | all of the above | The delivery-workflow engine |

The `container.ts` composition root (`createCore`) and `index.ts` barrel become a
thin top package that re-assembles the pieces — or fold composition into
`@cat-factory/orchestration` and let `@cat-factory/worker` wire across packages.
**Decide this early** (see §6).

### Notes grounded in the code

- The internal import graph is already mostly layered: cross-module edges are
  sparse and point down to a few shared bases — `workspaces` (`requireWorkspace`,
  imported by ~every module), `board`, `spend`, `environments`. There are **no**
  known cycles. This is a packaging problem, not a detangling problem.
- `requireWorkspace(repo, id)` (in `modules/workspaces/WorkspaceService.ts`) is a
  pure guard over the `WorkspaceRepository` **port** — move the *function* into
  `@cat-factory/kernel` so integration packages don't depend on the workspaces
  *service* package. The `WorkspaceService` *class* stays in `@cat-factory/workspaces`.
- `domain/types.ts` is just a re-export of `@cat-factory/contracts` types — it
  becomes the kernel's vocabulary surface.
- Duplication worth collapsing *while* you're moving files (already mapped in the
  PR #54 review): `documents` + `tasks` share source-registry/connection/import/
  link patterns; `environments` + `runners` share manifest-based connection
  services. `@cat-factory/integrations` is the natural home to unify these. (Out
  of scope for the move itself — do it as a follow-up unless trivial.)

## 4. Recommended migration order

Each step must land independently green (build + typecheck + test + `changeset
status`). Do **not** do it all in one commit — phase it so a bisect is possible.

1. **Extract `@cat-factory/kernel`.** Biggest churn (every import path changes),
   zero behavior risk. Everything else then imports kernel. Land this alone.
2. **Extract `@cat-factory/spend`.** Small, and it's the step that fixes the CI
   gating: repoint the acceptance test + the worker's `LlmProxyController` at
   `@cat-factory/spend`, then narrow the `ci.yml` `changes` filter from
   `backend/packages/core/**` to `backend/packages/spend/**` +
   `backend/packages/agents/**` (whatever the harness actually imports).
3. **Extract `@cat-factory/agents`**, then `@cat-factory/integrations`, then
   `@cat-factory/workspaces`.
4. **Rename the remainder** to `@cat-factory/orchestration` (or keep `core`, now
   with a real, narrow scope).

If scope must be cut: **steps 1–2 alone** resolve the gating smell and carve out
the leaf. The rest is incremental cleanup.

## 5. Per-package scaffolding

Each new package needs: a `package.json` (name, `version: 1.0.0`,
`publishConfig` matching the other public libs, `workspace:*` deps on the
packages below it), and a `tsconfig.json` extending `../../tsconfig.base.json`
(depth is the same as today's `backend/packages/*`, so the relative path is
unchanged). Build order in `pnpm build` is dependency order
(`contracts → prompt-fragments → kernel → spend/agents/integrations/workspaces →
orchestration → worker`); the existing build is sequential and pnpm resolves the
graph, but verify the topo order.

## 6. Gotchas / lessons from this sweep (so you don't rediscover them)

- **`changeset status` is file-based and strict.** Moving a *versioned* package's
  files makes it demand a changeset that **bumps that package** — an empty
  changeset is NOT enough (it is enough only when every changed package is in the
  `.changeset/config.json` `ignore` list, e.g. `benchmark-harness`,
  `deploy/*`). Every new public package you create is versioned, so each split PR
  needs a real changeset entry. `implementer-harness` is versioned-but-private;
  `benchmark-harness` is ignored.
- **`changeset status --since=main` diffs committed HEAD vs main** — commit before
  you check, or it sees nothing.
- **The worker exposes only `.`/`./app`**; the acceptance test reaches worker
  internals via a vitest alias mapping `@cat-factory/worker/src/*` to the worker
  source (`backend/internal/implementer-harness/vitest.acceptance.config.ts`).
  When spend/etc. move, the same deep-import trick may be needed for the new
  packages, or update the alias.
- **Two CI gates reference core today** — keep both in sync as you split:
  - `ci.yml` `changes` filter (currently `backend/packages/core/**`) gates the
    container-acceptance job. Narrow it to only the packages the harness imports.
  - `docker-publish.yml` is harness-path-only and does **not** reference core —
    leave it alone (the image never bundles core; it only copies the harness
    `src/` + `tsconfig.json`).
- **Workspace deps resolve by package name, not path** (`workspace:*`), so moving
  directories doesn't break imports between packages — only *relative* path
  references (vitest aliases, CI globs, docs, the Docker `CONTEXT`) break. Grep
  for the old path string across `*.yml *.yaml *.json *.md *.ts *.mjs *.toml`
  (excluding `node_modules`, `dist`, `pnpm-lock.yaml`) after each move.
- **Regenerate the lockfile** after moving packages: `pnpm install --lockfile-only`.
- Use `git mv` so history follows the files (git detected all renames cleanly in
  this sweep).

## 7. Verification checklist (run after each phase)

```sh
pnpm install --lockfile-only         # if any package moved
pnpm build                           # libraries build in dep order
pnpm typecheck                       # every package
pnpm test:run                        # unit/integration (worker suite ~40s)
pnpm changeset status --since=main   # after committing
# grep for stale references to the old import specifier / path
```

## 8. Open decisions for the next agent

1. **Composition root**: keep a thin top `@cat-factory/core` that re-assembles
   (`createCore`), or fold composition into `@cat-factory/orchestration` and wire
   cross-package in `@cat-factory/worker`? Recommend a thin top package to keep
   `createCore`'s single-object DI intact and minimize worker churn.
2. **`@cat-factory/integrations`**: one package now, or split into
   github/sources/provisioning immediately? Recommend one now.
3. Whether to land the documents/tasks and environments/runners **dedup** as part
   of the integrations extraction or as a separate follow-up. Recommend separate.
