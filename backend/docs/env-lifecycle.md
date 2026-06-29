# Environment provider repo lifecycle: validate / bootstrap / agent-repair

This document describes a set of **optional** capabilities on the `EnvironmentProvider` port
that let a native adapter (e.g. a future Kargo adapter) manage the **provider's configuration
file inside the deployed repo** — validate it, mechanically generate it, and (as a safety net)
have a coding agent repair it. It complements [`native-environment-adapter.md`](./native-environment-adapter.md),
which covers the base provision/status/teardown port.

> Status: **increments 1 (validate + bootstrap) and 2 (live agent-repair) are implemented,
> wired, and tested.** Only the native Kargo adapter (Part B, a separate repo) remains — see
> [What's left](#whats-left).

## Why this exists

Some ephemeral-environment systems require a **config file in the target repo** before they can
provision. The motivating case is **Kargo**: to spin up a PR environment (or a Tester
"sandbox"), Kargo reads a config file from the repo at provision time:

- File **`.kargo.yml`** at the repo root (fallback **`.pre.yml`**) —
  `apps/server/internal/config/service/parser.go` in the Kargo repo.
- Required: a non-empty **`name`** and a non-empty **`jobs`** list.
- Tester instances additionally use an optional **`sandbox`** block with its own rules
  (`sandbox.setup.command`, `sandbox.dev.command`, `sandbox.dev.healthPath` must start with `/`,
  `sandbox.dev.port` in 1–65535, durations 1s–2h) —
  `apps/server/internal/config/sandboxconfig/sandboxconfig.go`.

Critically, **Kargo has no validate / dry-run endpoint** — it only reads `.kargo.yml` from the
VCS host internally, _during provision_. So a missing or malformed config fails
**asynchronously** (the PREnv lands in `status: failed`) with no early, actionable signal. These
capabilities move that check **up front** and give operators a way to _create_ and _fix_ the
config without hand-editing the repo.

## The three capabilities

All live on the `EnvironmentProvider` port
(`backend/packages/kernel/src/ports/environment-provider.ts`) as **optional** methods — a
provider implements only what it needs; the generic `HttpEnvironmentProvider` implements none of
them, so nothing changes for manifest-driven providers.

| Capability    | Method(s)                                                    | What the provider supplies                           | What the engine supplies          |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------- |
| **Validate**  | `validateRepo`                                               | the expectations (which files, what must be in them) | a VCS-neutral `readRepoFile`      |
| **Bootstrap** | `describeBootstrapInputs` + `bootstrapProviderConfiguration` | the form fields + the generated file bytes           | the read + the commit/PR write    |
| **Repair**    | `describeRepairAgent`                                        | the agent prompt                                     | the agent runtime + a re-validate |

The provider stays **pure and VCS-neutral**: it never sees a VCS host, a token, an
installation id, or a `VcsConnectionRef`. It only receives a `readRepoFile(path, gitRef?)`
callback; the engine builds that from the workspace's existing `RepoFiles` abstraction (GitHub
today, GitLab later — zero provider change).

### The composed flow

```
validateRepo ──ok──▶ proceed to provision
     │ not ok
     ▼
bootstrapProviderConfiguration (mechanical) ──▶ commit to target branch ──▶ re-validateRepo ──ok──▶ done
     │ needsAgent / still invalid
     ▼
describeRepairAgent → dispatch coding agent → push → re-validateRepo (post-op) ──ok──▶ done : surface error
```

Each step is independent and optional. The pre-flight gate uses only `validateRepo`; the
bootstrap operation chains all three.

## How it's invoked

Two entry points, both workspace-scoped (mounted under `/workspaces/:workspaceId`):

- **On-demand**
  - `POST /environments/connection/validate-repo` — body `{ owner, repo, gitRef?, provider? }` →
    `{ ok, issues[] }`. Mirrors `testConnection`; nothing persisted.
  - `POST /environments/connection/bootstrap-repo` — body `{ owner, repo, gitRef?, provider?,
inputs, openPr?, allowAgentFallback? }` → `{ ok, committed, branch?, usedAgent?, issues[] }`.
- **Pre-flight gate** — `EnvironmentProvisioningService.provision()` runs `validateRepo` against
  the block's repo **before** calling `provider.provision()`. On failure it logs and throws a
  `ValidationError` synchronously (instead of letting the PREnv fail later). The gate is skipped
  for a block-less manual provision, when no run-repo resolver is wired, or when the provider has
  no `validateRepo`.

The SPA can render the right affordances from the provider descriptor
(`GET /environments/provider`), which now carries `supportsRepoValidation`,
`supportsRepoBootstrap`, and `bootstrapInputs`.

## VCS-neutral by construction

Repo reads/writes go through the **existing** `RepoFiles` port
(`backend/packages/kernel/src/ports/repo-files.ts`) — a checkout-free, workspace+repo-bound
facade (`getFile`, `commitFiles`, `openPullRequest`, …). The runtimes already build it over the
wired `GitHubClient`; a parallel `VcsClient` + GitLab client also exist. Two resolvers feed the
environments module:

- `resolveRunRepoContext` (block-bound) — already wired; now also threaded into the environments
  module for the pre-flight gate.
- `resolveRepoFilesForCoords` (block-less, new — `makeResolveRepoFilesForCoords` in
  `backend/packages/server/src/agents/repoFiles.ts`) — resolves a repo by `{owner, repo}` for the
  on-demand validate/bootstrap routes.

When GitLab support lands, swap these builders to resolve a `VcsClient` via the VCS registry; the
provider code is unchanged because it only ever sees `readRepoFile`.

## What's implemented (increment 1)

| Area                     | File(s)                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port types + methods     | `packages/kernel/src/ports/environment-provider.ts`, re-exported from `ports/index.ts`                                                                                                                         |
| Wire schemas + routes    | `packages/contracts/src/provider-config.ts`, `environments.ts`, `routes/environments.ts`                                                                                                                       |
| Service logic            | `packages/integrations/src/modules/environments/EnvironmentConnectionService.ts` (`validateRepo`, `bootstrapRepo`), `EnvironmentProvisioningService.ts` (pre-flight gate)                                      |
| Controller routes        | `packages/server/src/modules/environments/EnvironmentController.ts`                                                                                                                                            |
| Block-less repo resolver | `packages/server/src/agents/repoFiles.ts` (`makeResolveRepoFilesForCoords`)                                                                                                                                    |
| Container/runtime wiring | `packages/orchestration/src/container.ts` (`createEnvironmentsModule` + `CoreDependencies`), `runtimes/node/src/container.ts`, `runtimes/cloudflare/src/infrastructure/container.ts` (local delegates to node) |

Behavioural notes:

- **Bootstrap is idempotent**: each generated file is read-compared and only committed when it
  changes; an already-correct repo reports `committed: false`.
- **Write target**: the default path commits straight to the target branch (the ref the provider
  will read — e.g. the PR head branch Kargo provisions from). `openPr: true` commits to a
  deterministic `cat-factory/env-config` branch and opens a PR into the target branch.
- **Best-effort logging**: bootstrap and the pre-flight gate record `provision` events via the
  existing `provisioningLog`.

Tests:

- `EnvironmentConnectionService.test.ts` — validate (provider-absent, no-VCS, pass-through,
  providerConfig→config, gitRef defaulting) + bootstrap (commit, idempotent skip, openPr,
  needsAgent→agent fallback, no-opt-in).
- `EnvironmentProvisioningService.test.ts` — gate throws before `provision`, passes through,
  skips block-less / no-resolver.
- `server/test/repoFilesForCoords.spec.ts` — coords resolver (no installation / no match / bound
  / default branch).

Verification at time of writing: full backend `tsc -b` build, per-package typechecks, the
environments suite (45/45) and the new specs all pass; `oxlint` + `oxfmt` clean. (Unrelated
`slack`/`runners`/`tasks` suites fail only on blocked network egress — `ENOTFOUND` — in the dev
sandbox; not touched by this change.)

## What's left

### Increment 2 — the live repair agent (implemented)

When mechanical bootstrap can't produce a valid config (`needsAgent`, or the post-commit
re-validation still fails) **and** the caller passed `allowAgentFallback`, the engine dispatches a
coding agent to fix the config in place, then re-validates.

**How it works (direct runner dispatch, NOT an ad-hoc engine run).** The repair is triggered from
`EnvironmentConnectionService.bootstrapRepo`, which carries only `{workspaceId, owner, repo, gitRef,
issues, inputs}` — there is **no board block**, so the block+pipeline-centric `ExecutionService.start`
is the wrong tool. Instead the runtime wires `dispatchEnvConfigRepair` to a
**`ContainerEnvConfigRepairer`** (`@cat-factory/server`) that mirrors the bootstrap flow's
dispatch/poll/release plumbing (`RunnerJobClient` / `RunnerTransport`):

1. It dispatches a **plain `coding` job** (kind `agent`) that clones the repo at `gitRef`, has the
   agent make `provider.describeRepairAgent(...)`'s requested fix, and **pushes back onto the same
   branch** — **no `bootstrap`/`mergeBase` block** (so the harness takes its ordinary
   clone→edit→push path, never the bootstrapper's history-reinit force-push), **no PR**, and a no-op
   is a clean non-event (`noChangesIsError: false`).
2. It **awaits** the job in-process (poll loop, bounded), throwing on a hard failure.
3. **Re-validation lives in `EnvironmentConnectionService`**, not the dispatcher: after the agent
   pushes, the service re-runs `provider.validateRepo` against `writeBranch` using the decrypted
   secrets + manifest config it already holds. So the seam (`dispatchConfigRepair` /
   `dispatchEnvConfigRepair`) is pure container plumbing and returns `void`.

> ⚠️ This is deliberately **not** the "bootstrap repo" task (`BootstrapService` /
> `ContainerRepoBootstrapper` / the `bootstrap_jobs` table), which force-pushes a fresh history
> into an empty repo to scaffold a new service. The config repairer only edits an existing repo's
> provider config in place. They share only the runner dispatch/poll plumbing.

| Area                | File(s)                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repair dispatcher   | `packages/server/src/agents/ContainerEnvConfigRepairer.ts` (+ `index.ts` export)                                                                                              |
| Service re-validate | `packages/integrations/src/modules/environments/EnvironmentConnectionService.ts`                                                                                              |
| Seam type (`void`)  | `packages/orchestration/src/container.ts` (`CoreDependencies.dispatchEnvConfigRepair`)                                                                                        |
| Runtime wiring      | `runtimes/cloudflare/.../container.ts` (`selectEnvConfigRepairer`), `runtimes/node/src/container.ts` (`selectNodeEnvConfigRepairer`); local inherits via `buildNodeContainer` |

A facade wires the dispatcher only when the container prerequisites are met **and** a registered
backend actually supports agent repair (`describeRepairAgent`) — so a stock deployment running the
generic manifest provider is unchanged (no `describeRepairAgent` ⇒ the service guard skips the
fallback). The repairer is built over the first repair-capable provider in the env-backend registry
(`findRepairCapableProvider`), so a custom backend registered via `registerEnvironmentBackend` that
implements `describeRepairAgent` is the one the dispatcher repairs through. The repair agent runs on
the `coder` kind's routing model.

**Bonus / stretch — true in-container validation:** package `validateRepo` as a runnable the
harness injects into the container so the agent self-checks _before_ pushing. Requires an
executor-harness change (job-body payload + a write+exec hook, like the existing
`docker compose up` infra hook) plus the validator shipped as an executable. Not done in
increment 2; the service's post-repair re-validation gives the same guarantee from the engine's side.

### Part B — the Kargo adapter (separate repo, blocked on a release)

The adapter that _implements_ these three methods lives in the wrapper repo
(`packages/kargo-adapter` in `cat-factory-wrapper`) and is **blocked on a `@cat-factory/kernel`
release** carrying the new port members. Once released and the adapter is bumped:

- `validateRepo`: read `.kargo.yml` (fallback `.pre.yml`), YAML-parse, emit errors for empty
  `name`/`jobs` and (when present) `sandbox` rule violations; warn when no `sandbox` block.
- `describeBootstrapInputs` + `bootstrapProviderConfiguration`: declare the variables (service
  name, sandbox setup/dev commands, port, health path, instance size/type, TTL) and render a
  parametrized `.kargo.yml`; return `needsAgent: true` when an existing config conflicts in a way
  templating can't safely merge.
- `describeRepairAgent`: a prompt instructing the agent to make `.kargo.yml` conform to Kargo's
  schema, referencing the supplied issues.

Keep the adapter VCS-neutral and side-effect-free: only `readRepoFile` + pure generation; the
engine commits and dispatches.

## Quick reference: types

Port (`@cat-factory/kernel`):
`RepoFileReader`, `RepoValidationSeverity`, `RepoValidationIssue`, `RepoValidationRequest`,
`RepoValidationResult`, `BootstrapConfigFile`, `BootstrapConfigRequest`, `BootstrapConfigResult`,
`RepairAgentRequest`, `RepairAgentSpec`.

Wire (`@cat-factory/contracts`):
`validateEnvironmentRepoSchema`, `bootstrapEnvironmentRepoSchema`, `repoValidationResultSchema`,
`bootstrapRepoResultSchema`, and the `supportsRepoValidation` / `supportsRepoBootstrap` /
`bootstrapInputs` fields on `providerDescriptorSchema`.
