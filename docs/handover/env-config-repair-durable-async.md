# Handover — make the env-config repair agent durable & asynchronous (PR #424 follow-up)

**Status:** design complete, foundation written (preserved under
[`./env-config-repair/reference/`](./env-config-repair/reference/)), NOT yet wired/landed.
The clear-cut review findings (#2, #5, #7) were landed separately on the PR branch; THIS doc
covers the larger architectural change (review finding **#1**) that was deferred.

## Why

PR #424 wired the environment-provider config-repair agent (PR #416 increment 2). It dispatches a
coding agent that fixes a provider's config file in place and pushes it back, then re-validates.
The problem (review finding #1): the repair is **awaited synchronously inside the
`bootstrapRepo` HTTP handler** — `ContainerEnvConfigRepairer.repair()` runs a poll loop of
`maxPolls=240 × 5s ≈ 20 minutes` inside one `fetch` request
(`EnvironmentController` → `EnvironmentConnectionService.bootstrapRepo` → `dispatchConfigRepair`).

That diverges from the platform's gold-standard async+durable+observable pattern (see CLAUDE.md
"Execution flow" / "Repo bootstrap flow") and **cannot survive on the Cloudflare Worker facade**,
whose requests can't block for 20 minutes. The fix: drive the repair **durably and
asynchronously, exactly like the "bootstrap repo" flow** — dispatch + return immediately, drive
the poll loop with a durable runner (Cloudflare Workflows ⇄ Node pg-boss), re-validate on
completion, and push progress/outcome to the UI via events.

## Decision

Mirror the **bootstrap repo** flow precisely. Key simplifications vs. bootstrap (it's leaner —
no board frame, no service/mount, no repo projection, no reference architectures):

- **Reuse the unified `agent_runs` table** with a new `kind='env-config-repair'`. **No DB
  migration** (the table is kind-scoped; D1 + Drizzle both already exist). This is the single
  biggest scope reducer.
- **Reuse the existing cron sweeper** (`sweepStuckRuns`, kind-spanning via
  `AgentRunRepository.listStale`/`getRef`); just add routing for the new kind in each runtime's
  `redrive`/`finalizeOrphan`.
- The repair run has **no board block** — surfaced only on the infrastructure-providers window
  that triggered it (NOT the board).

## What was already built (foundation — preserved, not yet in the tree)

These were written, then set aside (the partial tree wouldn't build on its own). Re-apply them as
the starting point. Exact contents are under [`./env-config-repair/reference/`](./env-config-repair/reference/):

| Reference file | Lands at | What it is |
| --- | --- | --- |
| `contracts__env-config-repair.ts.txt` | `backend/packages/contracts/src/env-config-repair.ts` | `envConfigRepairStatusSchema` + `envConfigRepairJobSchema` (+ `EnvConfigRepairJob` type) |
| `kernel__ports__env-config-repair.ts.txt` | `backend/packages/kernel/src/ports/env-config-repair.ts` | `EnvConfigRepairer` (start/poll/stop), `EnvConfigRepairRunner` (+Noop), repair-job record/patch/repository, request/handle/update types |
| `orchestration__EnvConfigRepairService.ts.txt` | `backend/packages/orchestration/src/modules/envConfigRepair/EnvConfigRepairService.ts` | the durable lifecycle owner: `start`/`pollJob`/`stop`/`listJobs`/`getJob`, re-validate-on-success, event emit |
| `server__ContainerEnvConfigRepairer.reworked.ts.txt` | `backend/packages/server/src/agents/ContainerEnvConfigRepairer.ts` | the in-request `repair()` reworked into the `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`, no blocking loop) |
| `existing-file-edits.diff` | (apply) | the small additive edits to contracts (`index`, `entities` AgentRunKind, `events`, `snapshot`, `provider-config` `repairJobId`) + kernel (`ports/index`, `domain/types`, `execution-events` `envConfigRepairChanged` + Noop) |

> The reference `.ts.txt` files are verbatim TypeScript (`.txt` only so nothing tries to compile
> them from `docs/`). `existing-file-edits.diff` was `git diff` against PR #424's HEAD
> (`67b0150`); re-base if the branch moved.

## Remaining work (file-by-file)

Bottom-up; verify `pnpm typecheck` + `pnpm build` (Turbo, from repo root) before pushing as ONE
commit. Analogue paths are the bootstrap files to clone from.

### 1. Foundation (re-apply the preserved files above)
Contracts, kernel ports, the orchestration service, and the reworked server repairer. Export the
orchestration service + `EnvConfigRepairPollResult` from `backend/packages/orchestration/src/index.ts`
(mirror how `BootstrapService`/`BootstrapPollResult` are exported).

### 2. Integrations — `EnvironmentConnectionService` (`backend/packages/integrations/.../EnvironmentConnectionService.ts`)
- Change the `dispatchConfigRepair?` seam return type from `Promise<void>` to
  `Promise<{ jobId: string }>` (it now **starts** the durable run and returns its id; it does NOT
  await or re-validate).
- In `bootstrapRepo`, the agent-fallback branch:
  - **Fix finding #2 (carried over):** in PR mode (`input.openPr`), if `writeBranch === targetBranch`
    (the `needsAgent` path never switched to the PR branch), create `BOOTSTRAP_CONFIG_BRANCH` off the
    target head + open the PR, and set `writeBranch = BOOTSTRAP_CONFIG_BRANCH` BEFORE dispatch, so the
    agent pushes the fix to the PR branch (not straight to `main`). Pass `gitRef: writeBranch`.
  - Call `dispatchConfigRepair(...)` (non-blocking) → `repairJobId`. Do **not** re-validate inline.
  - Return `{ ok: false, committed, branch: writeBranch, usedAgent: true, repairJobId, issues }`
    (repair is now pending; `ok` is resolved later by the repair run's re-validation).
  - **Fix finding #3 naturally:** there's no longer an in-request await that can throw a 500 — a
    dispatch failure is recorded on the repair-job row by `EnvConfigRepairService.start`.
- Add a public `revalidate(workspaceId, { owner, repo, gitRef }): Promise<RepoValidationResult>`
  that re-derives manifest + decrypted secrets + config (`optionalManifest`/`resolveSecrets`/
  `stringifyProviderConfig`) and runs `runProviderValidate`. This is the callback
  `EnvConfigRepairService.pollJob` invokes on success (orchestration → integrations; no cycle —
  both are built in `createEnvironmentsModule`).
- Update `EnvironmentConnectionService.test.ts`: the agent-fallback cases now assert
  `usedAgent:true` + `repairJobId` set + `ok:false` (pending). Re-validation is covered by the
  repair service / conformance, not `bootstrapRepo`.

### 3. Orchestration container (`backend/packages/orchestration/src/container.ts`)
- `CoreDependencies`: drop the old `dispatchEnvConfigRepair?` (its `void`/`RepoValidationResult`
  shape); add `envConfigRepairJobRepository?`, `envConfigRepairer?: EnvConfigRepairer`,
  `envConfigRepairRunner?: EnvConfigRepairRunner`.
- In `createEnvironmentsModule`: build `EnvConfigRepairService` (when `envConfigRepairer` +
  `envConfigRepairJobRepository` wired), passing `revalidate: (i) => connectionService.revalidate(i)`
  and the event publisher. Wire the connection service's `dispatchConfigRepair` to
  `(input) => repairService.start(input.workspaceId, { owner, repo, gitRef: input.gitRef, issues, inputs }).then(j => ({ jobId: j.id }))`.
- Expose `Core.envConfigRepair?: { service: EnvConfigRepairService }` so the runtime drivers + the
  controller can reach `pollJob`/`listJobs`/`stop`. Mirror `Core.bootstrap`.

### 4. Cloudflare runtime (`backend/runtimes/cloudflare/`)
Clone the bootstrap analogues:
- `src/infrastructure/workflows/EnvConfigRepairWorkflow.ts` ← `BootstrapWorkflow.ts` (calls
  `container.envConfigRepair.service.pollJob`).
- `src/infrastructure/workflows/WorkflowsEnvConfigRepairRunner.ts` ← `WorkflowsBootstrapRunner.ts`.
- `src/infrastructure/repositories/D1EnvConfigRepairJobRepository.ts` ← `D1BootstrapJobRepository.ts`
  (kind `'env-config-repair'`; lean `detail` JSON = `{owner,repo,branch,ok,issues}`; no `service_id`).
- `wrangler.toml`: add a `[[workflows]]` binding (e.g. `ENV_CONFIG_REPAIR_WORKFLOW`,
  `class_name = "EnvConfigRepairWorkflow"`). **Mirror in `deploy/backend/wrangler.toml`** too.
- `src/infrastructure/env.ts`: add `ENV_CONFIG_REPAIR_WORKFLOW?: Workflow`.
- `src/index.ts`: export the new Workflow class; extend the sweeper's `redrive`/`finalizeOrphan`
  switch to route `kind === 'env-config-repair'` to the runner / `service.stop`.
- `src/infrastructure/container.ts`: rebuild `selectEnvConfigRepairer` to construct the **reworked**
  `ContainerEnvConfigRepairer` (port impl; drop `idGenerator`/`pollIntervalMs`/`maxPolls`), and wire
  `dependencies.envConfigRepairer`, `envConfigRepairRunner` (from the binding), and
  `envConfigRepairJobRepository` (D1). Keep the same gating (container prereqs + provider supports
  `describeRepairAgent`); see finding #5 note below.

### 5. Node runtime (`backend/runtimes/node/`)
- `src/execution/envConfigRepairRunner.ts` ← `bootstrapRunner.ts` (`driveEnvConfigRepair`,
  `PgBossEnvConfigRepairRunner`, `startEnvConfigRepairWorker`, `reenqueueStaleEnvConfigRepair`;
  queue `env-config-repair.advance`, policy `exclusive`).
- `src/repositories/envConfigRepair.ts` ← the Drizzle bootstrap repo (kind-scoped on `agent_runs`).
- `src/container.ts`: rebuild `selectNodeEnvConfigRepairer` (reworked repairer), wire the repo +
  `PgBossEnvConfigRepairRunner`, and start the worker in `start()` alongside `startBootstrapWorker`;
  route the new kind in the Node sweeper.
- Local inherits via `buildNodeContainer` (no extra wiring), same as today.

### 6. Controller + snapshot (`backend/packages/server/`)
- `WorkspaceController`: attach `envConfigRepairJobs = await container.envConfigRepair?.service.listJobs(ws)`
  to the snapshot.
- `AgentRunController` (retry/stop): route `kind === 'env-config-repair'` to
  `envConfigRepair.service` (stop is supported; retry can re-`start` from the failed job's
  owner/repo/branch, or omit retry in v1 and document it).

### 7. Frontend (`frontend/app/`) — `@cat-factory/app`
- `app/stores/envConfigRepair.ts` (small): `hydrate(snapshot.envConfigRepairJobs)` + `upsert(job)`,
  keyed by id.
- `app/composables/useWorkspaceStream.ts`: handle `event.type === 'env-config-repair'` → `upsert`.
- The infrastructure-providers window that calls `bootstrapRepo`: when the response carries
  `repairJobId`, show a "repairing…" indicator and reflect the tracked job's terminal
  `status`/`ok`/`issues`/`failure` from the store (reuse `AgentFailureCard` shape if convenient).
- i18n: add keys to `app/i18n/locales/en.json` (no raw strings); add a **patch changeset** for
  `@cat-factory/app`.

### 8. Conformance (`backend/internal/conformance/`)
- Add an assertion that a config-repair run drives to a terminal state on BOTH runtimes (mirror the
  bootstrap `driveBootstrap` test). The harness already exposes `call`/`createWorkspace`; add a
  `driveEnvConfigRepair` helper analogous to `driveBootstrap`, and use a fake `EnvConfigRepairer`
  (the canonical fake-agent pattern) so wiring drift on either facade fails a test.

### 9. Changeset
The existing `.changeset/live-repair-agent.md` already bumps the affected packages (server,
integrations, orchestration, worker, node-server, local-server) as `minor`. Update its body to
describe the durable-async shape, and add `@cat-factory/app` if the frontend lands here.

## Gotchas / design notes

- **No migration needed** — `agent_runs` is kind-scoped. Don't add one.
- **Re-validation lives in `EnvironmentConnectionService`** (decrypted secrets + manifest), invoked
  by `EnvConfigRepairService.pollJob` via an injected callback — keeps orchestration from importing
  the integration internals and avoids a cycle.
- **Finding #2** (PR-mode branch) is folded into step 2 (the dispatch must target the PR branch).
- **Finding #3** (throw → 500 / skipped log) disappears: the request no longer awaits the run.
- **Finding #5** (non-proxyable `coder` model throws mid-run): with async, the throw happens in
  `EnvConfigRepairService.start` and is recorded on the job row (kind `preflight`/`dispatch`),
  surfaced on the infra window — no longer a 500. Optionally also gate it out at facade wiring
  (skip wiring + log) so a misconfigured deployment is "no fallback" rather than a failing run.
- **Keep the runtimes symmetric** (CLAUDE.md): the new Workflow binding (CF) ⇄ pg-boss queue/worker
  (Node) ⇄ local-inherits must all land together, with the conformance assertion, in ONE change.
- Verify with `pnpm typecheck` / `pnpm test:run` / `pnpm build` via Turbo from the repo root
  (Linux/macOS for the worker suite; CI provides Postgres for the Node suite).
