import type {
  Block,
  Clock,
  ConnectionTestResult,
  EnvironmentHandle,
  EnvironmentTestRun,
  ExecutionEventPublisher,
  IdGenerator,
  Logger,
  ResolveRunRepoContext,
  RunnerJobRef,
  RunnerJobView,
} from '@cat-factory/kernel'
import type {
  BlockRepository,
  EnvironmentTestRunner,
  EnvironmentTestRunRecord,
  EnvironmentTestRunRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  NotFoundError,
  requireWorkspace,
} from '@cat-factory/kernel'
import type { ProvisionArgs, ProvisionDispatch, SettledProvision } from '@cat-factory/integrations'

/** The poll's terminal-ness, returned to the durable driver so it knows when to stop. */
export interface EnvironmentTestPollResult {
  state: 'running' | 'done' | 'failed'
  /** Present when `state === 'failed'`. */
  error?: string
}

/** The structural subset of the provisioning service the self-test drives. */
export interface EnvironmentTestProvisioning {
  canProvision(
    workspaceId: string,
    service: NonNullable<Block['provisioning']>,
    initiatedBy?: string | null,
  ): Promise<{ ok: boolean; reason?: string }>
  /**
   * Probe the resolved provider's live connection (token/endpoint reachable) without persisting —
   * `null` when the provider has no probe (or `infraless`). The self-test runs this as a pre-flight
   * so a bad connection (e.g. a wrong project id or a rejected token) fails fast, BEFORE a throwaway
   * branch is created, instead of opaquely mid-provision.
   */
  testProvisioning(
    workspaceId: string,
    service: NonNullable<Block['provisioning']>,
    initiatedBy?: string | null,
  ): Promise<ConnectionTestResult | null>
  startProvision(args: ProvisionArgs, ref: RunnerJobRef): Promise<ProvisionDispatch>
  pollProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<RunnerJobView>
  finalizeProvision(args: ProvisionArgs, view: RunnerJobView): Promise<SettledProvision>
  releaseProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<void>
  /**
   * Re-poll a recorded environment's status via its provider (`provider.status`) and persist any
   * change. The self-test uses this to WAIT for a synchronously-recorded env (a REST provider that
   * returns immediately with `provisioning`) to actually reach `ready` before tearing
   * it down, so the test confirms the env stands up rather than just that the create call returned.
   */
  refreshStatus(workspaceId: string, id: string): Promise<EnvironmentHandle>
}

/** The structural subset of the teardown service the self-test drives. */
export interface EnvironmentTestTeardown {
  teardown(workspaceId: string, id: string): Promise<unknown>
}

/**
 * The structural subset of the environment registry the self-test's cleanup reads: the
 * row keyed under the run's synthetic `(blockId, frameId)` pair — the `provisioning`
 * placeholder `startProvision` inserts, or a failed finalize's record. Because the
 * synthetic block id is unique per run and carries no TTL, nothing else ever supersedes
 * or sweeps such a row, so the run must reclaim it itself.
 */
export interface EnvironmentTestRegistry {
  getByBlockAndFrame(
    workspaceId: string,
    blockId: string,
    frameId: string,
  ): Promise<{ id: string; externalId: string | null } | null>
  softDelete(workspaceId: string, id: string, at: number): Promise<void>
}

export interface EnvironmentTestServiceDependencies {
  environmentTestRunRepository: EnvironmentTestRunRepository
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  provisioning: EnvironmentTestProvisioning
  teardown: EnvironmentTestTeardown
  environmentRegistry: EnvironmentTestRegistry
  /** Resolves the frame's run-repo-bound RepoFiles (branch create/delete + base sha). */
  resolveRunRepoContext: ResolveRunRepoContext
  idGenerator: IdGenerator
  clock: Clock
  /** Durably drives the run's poll loop; absent → tests poll `pollEnvTest` directly. */
  runner?: EnvironmentTestRunner
  /** Pushes live stage transitions to subscribed clients. */
  eventPublisher?: ExecutionEventPublisher
  /**
   * Structured logger for terminal-failure diagnostics. A self-test failure is otherwise only
   * persisted on the run record (and surfaced in the SPA) — never logged server-side — so a
   * provider/dispatch throw (e.g. a provider rejecting the create with a 422) leaves no trace in
   * the logs. `fail()` emits one
   * `warn` per failure with the stage + message (+ stack when the cause is an `Error`). Absent ⇒
   * no logging (the run record is still written).
   */
  logger?: Logger
}

function toRun(record: EnvironmentTestRunRecord): EnvironmentTestRun {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    blockId: record.blockId,
    status: record.status,
    stage: record.stage,
    branch: record.branch,
    envUrl: record.envUrl,
    error: record.error,
    failedStage: record.failedStage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// EnvironmentTestService — the ephemeral-environment SELF-TEST run.
//
// A developer-triggered diagnostic that exercises a service frame's configured
// provisioning end to end against a THROWAWAY branch and always cleans up:
//   creating_branch → provisioning → tearing_down → deleting_branch → done
// (or `failed` with the stage it failed at). It touches no board block and
// leaves no branch/env behind. Modelled like a bootstrap run: `startTest`
// does the fast up-front work + dispatch and hands off to the durable driver;
// `pollEnvTest` advances the state machine idempotently so replays are safe.
//
// Repo/registry isolation (see EnvironmentProvisioningService): provisioning
// resolves the repo from `frameId ?? blockId`, and `recordProvisioned`
// supersedes any prior env for the `(blockId, frameId)` pair. So the run passes
// the REAL frame block as `frameId` (correct repo + preflight + clone) and a
// SYNTHETIC per-run `blockId` (`env-test:<runId>`), which no real deployer env
// uses — so the test never clobbers a live environment and its own namespace is
// unique. Teardown always targets the specific env id the run provisioned.
//
// The always-cleans-up contract is enforced by `fail()`: EVERY failure path —
// a pre-dispatch throw, a failed deploy view, a user stop mid-provision, a
// driver replay — funnels through it, and it (best-effort) releases the deploy
// runner, tears down the env, reclaims the synthetic registry row, and deletes
// the branch BEFORE writing the terminal state. Cleanup state is persisted the
// moment the side effect it tracks happens (the branch right after creation),
// never after a later step, so a crash between steps can't orphan it.
// ---------------------------------------------------------------------------

export class EnvironmentTestService {
  constructor(private readonly deps: EnvironmentTestServiceDependencies) {}

  /** The synthetic provisioning block id for a run (registry-key + namespace isolation). */
  private provisionBlockId(runId: string): string {
    return `env-test:${runId}`
  }

  private ref(runId: string): RunnerJobRef {
    return { runId, jobId: runId }
  }

  async getRun(workspaceId: string, id: string): Promise<EnvironmentTestRun> {
    return toRun(
      assertFound(
        await this.deps.environmentTestRunRepository.get(workspaceId, id),
        'Environment test run',
        id,
      ),
    )
  }

  /** In-flight self-test runs (carried in the workspace snapshot for reconnect). */
  async listRunning(workspaceId: string): Promise<EnvironmentTestRun[]> {
    const records = await this.deps.environmentTestRunRepository.listRunningByWorkspace(workspaceId)
    return records.map(toRun)
  }

  /**
   * Kick off a self-test against a service frame's provisioning config and return
   * immediately with the `running` run. Pre-flights (frame provisionable, git provider
   * connected) throw as 409s BEFORE any record exists; after the record is inserted,
   * every failure runs best-effort cleanup and returns the run already `failed`.
   */
  async startTest(
    workspaceId: string,
    blockId: string,
    initiatedBy?: string | null,
  ): Promise<EnvironmentTestRun> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)

    const frame = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    if (frame.level !== 'frame') {
      throw new ConflictError(
        'Environment tests run against a service frame, not a task or module.',
        'env_test_not_a_frame',
      )
    }
    const provisioning = frame.provisioning
    if (!provisioning || provisioning.type === 'infraless') {
      throw new ConflictError(
        'This service has no ephemeral-environment provisioning configured to test.',
        'env_test_infraless',
      )
    }
    const gate = await this.deps.provisioning.canProvision(workspaceId, provisioning, initiatedBy)
    if (!gate.ok) {
      throw new ConflictError(
        'This service’s provisioning cannot run yet — configure its environment handler first.',
        'env_test_not_provisionable',
        // The sub-reason rides on its OWN key, NOT `reason`: `ConflictError` merges details as
        // `{ reason: code, ...details }`, so a `reason` key here would clobber the
        // `env_test_not_provisionable` code the SPA keys its localized copy + "Configure
        // environment handler" jump off (`details.reason`). `handlerIssue` lets the SPA still
        // word the specific case — nothing configured vs. an ambiguous match.
        gate.reason ? { handlerIssue: gate.reason } : undefined,
      )
    }
    // Pre-flight the provider's live connection (token accepted, endpoint/project reachable) BEFORE
    // creating the throwaway branch, so a connection-level misconfiguration — a rejected token, or a
    // wrong project/endpoint — surfaces up front as an actionable 409 carrying the provider's own
    // message, instead of failing opaquely mid-provision (and churning a create+delete of the temp
    // branch). Providers without a `testConnection` (or `infraless`) return null ⇒ nothing to probe.
    const probe = await this.deps.provisioning.testProvisioning(
      workspaceId,
      provisioning,
      initiatedBy,
    )
    if (probe && !probe.ok) {
      throw new ConflictError(
        probe.message || 'The environment provider connection could not be validated.',
        'env_test_connection_failed',
      )
    }
    // Resolve the git provider up front so a missing VCS is a real 409 (the SPA keys its
    // hint off the reason code) rather than a run born `failed`.
    const bound = await this.deps.resolveRunRepoContext(workspaceId, blockId)
    if (!bound) {
      throw new ConflictError(
        'This workspace is not connected to a git provider, so no test branch can be created.',
        'env_test_no_vcs',
      )
    }

    const now = this.deps.clock.now()
    const record: EnvironmentTestRunRecord = {
      id: this.deps.idGenerator.next('envtest'),
      workspaceId,
      blockId,
      status: 'running',
      stage: 'creating_branch',
      initiatedBy: initiatedBy ?? null,
      // Pin the provisioning config on the record so the durable poll finalizes and
      // cleans up against exactly what was dispatched (a mid-flight frame edit or
      // deletion can't strand a live environment).
      provisioning,
      branch: null,
      environmentId: null,
      envUrl: null,
      error: null,
      failedStage: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.environmentTestRunRepository.insert(record)
    await this.emit(record)

    try {
      // Create the throwaway branch off the frame repo's default head.
      const baseSha = await bound.repo.headSha(bound.baseBranch)
      if (!baseSha) {
        throw new Error(`The repository's default branch '${bound.baseBranch}' has no head commit.`)
      }
      const branch = `cat-factory/env-test/${record.id}`
      await bound.repo.createBranch(branch, baseSha)
      // Persist the branch BEFORE dispatching, so any later failure — including a
      // dispatch throw — can reclaim it (`fail()` deletes `record.branch`). A rejected
      // write means a stop already finalized the run — don't dispatch onto it.
      record.branch = branch
      if (!(await this.guardedUpdate(record, { branch }))) {
        throw new Error('The environment test was stopped while starting.')
      }

      // The throwaway branch now exists, so the NEXT phase is provisioning. Advance the stage
      // BEFORE dispatching, for two reasons: (1) `startProvision` can throw (a provider rejects
      // the create with a 422) — with the stage still at `creating_branch`, `fail()` would
      // mislabel a provisioning-dispatch failure as a branch-creation failure (`failedStage`
      // reads the live stage); (2) a slow dispatch otherwise leaves the SPA showing a stalled
      // "creating branch" until it returns. A rejected write means a concurrent stop finalized
      // the run — don't dispatch onto it.
      if (!(await this.patch(record, { stage: 'provisioning' }))) {
        throw new Error('The environment test was stopped while starting.')
      }

      // Dispatch provisioning for the temp branch under the synthetic block id.
      const dispatch = await this.deps.provisioning.startProvision(
        this.provisionArgs(record, branch),
        this.ref(record.id),
      )
      if (
        dispatch.kind === 'completed' &&
        !(await this.patch(record, {
          environmentId: dispatch.handle.id,
          envUrl: dispatch.handle.url,
        }))
      ) {
        // The run was stopped while we were dispatching; the stop already ran cleanup,
        // but the branch/dispatch may postdate its snapshot — fail() re-runs cleanup
        // idempotently and leaves the stop's terminal state in place.
        throw new Error('The environment test was stopped while starting.')
      }

      // Hand off the long poll loop to the durable driver (tests poll directly).
      await this.deps.runner?.startRun(workspaceId, record.id)
      return toRun(record)
    } catch (error) {
      return this.fail(record, getErrorMessage(error), error)
    }
  }

  /**
   * Advance one running self-test by one stage (idempotent — a terminal run is returned
   * as-is, so the driver's retries/replays are safe). Returns the poll's terminal-ness.
   */
  async pollEnvTest(workspaceId: string, id: string): Promise<EnvironmentTestPollResult> {
    const record = assertFound(
      await this.deps.environmentTestRunRepository.get(workspaceId, id),
      'Environment test run',
      id,
    )
    if (record.status === 'succeeded') return { state: 'done' }
    if (record.status === 'failed') return { state: 'failed', error: record.error ?? undefined }

    try {
      switch (record.stage) {
        case 'creating_branch':
          // Only observable when the start request died between the insert and the
          // dispatch — `startTest` moves the record to `provisioning` before handing
          // off to the driver, so a (sweeper-driven) poll seeing this stage means the
          // start never completed. Fail it (with cleanup) instead of spinning forever.
          throw new Error(
            'The environment test did not finish starting (the start request was interrupted).',
          )
        case 'provisioning':
          return await this.advanceProvisioning(record)
        case 'tearing_down':
          return await this.advanceTeardown(record)
        case 'deleting_branch':
          return await this.advanceDeleteBranch(record)
        default:
          // `done` is terminal and short-circuited above; nothing else is pollable.
          return { state: 'running' }
      }
    } catch (error) {
      const run = await this.fail(record, getErrorMessage(error), error)
      return { state: 'failed', error: run.error ?? undefined }
    }
  }

  private async advanceProvisioning(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    // Synchronous path: the env was recorded at dispatch (`startProvision` returned `completed`),
    // but a REST provider can return BEFORE the env is actually up — e.g. a create that responds
    // immediately with `provisioning` and no URL. So poll the provider's status until the env truly
    // reaches `ready` before tearing it down; the whole point of the self-test is to confirm the env
    // stands up and is reachable, not merely that the create call returned a handle. The durable
    // driver's poll budget bounds the wait — a stuck env is `expire()`d and cleaned up — and any
    // terminal-not-ready status (`failed`/`expired`/torn down) fails the run with the provider's
    // reason. (A provider that returns `ready` synchronously, e.g. compose, advances on the first
    // poll, so this stays a fast no-wait for those.)
    if (record.environmentId) {
      const handle = await this.deps.provisioning.refreshStatus(
        record.workspaceId,
        record.environmentId,
      )
      if (handle.status === 'ready') {
        await this.patch(record, {
          stage: 'tearing_down',
          ...(handle.url ? { envUrl: handle.url } : {}),
        })
        return { state: 'running' }
      }
      if (handle.status === 'provisioning') {
        // Still coming up — surface a URL if one has appeared, and keep polling.
        if (handle.url && handle.url !== record.envUrl) {
          await this.patch(record, { envUrl: handle.url })
        }
        return { state: 'running' }
      }
      // `failed` / `expired` / `torn_down` / `tearing_down`: it will never become ready. The
      // provider's own note is the last resort behind its error, because a status the provider
      // moved to without recording a fault still leaves whatever it last said about the spin-up.
      throw new Error(
        handle.lastError ??
          handle.statusNote ??
          `Environment provisioning did not become ready (status: ${handle.status}).`,
      )
    }
    const view = await this.deps.provisioning.pollProvisionJob(
      record.workspaceId,
      this.ref(record.id),
    )
    if (view.state === 'running') return { state: 'running' }
    if (view.state === 'failed') {
      // Reclaim the deploy runner (mirrors RunDispatcher.pollDeployerJob) and settle the
      // failed view into the registry — the deploy may have partially applied infra, and
      // the finalized record (externalId et al.) is what cleanup tears it down through.
      await this.deps.provisioning.releaseProvisionJob(record.workspaceId, this.ref(record.id))
      try {
        const { handle } = await this.deps.provisioning.finalizeProvision(
          this.provisionArgs(record, record.branch),
          view,
        )
        record.environmentId = handle.id
        await this.guardedUpdate(record, { environmentId: handle.id })
      } catch {
        // Best-effort — fail() reclaims whatever registry row remains regardless.
      }
      throw new Error(view.error ?? 'Environment provisioning failed.')
    }
    // Done: reclaim the deploy runner, finalize the env record, move to teardown.
    await this.deps.provisioning.releaseProvisionJob(record.workspaceId, this.ref(record.id))
    const { handle } = await this.deps.provisioning.finalizeProvision(
      this.provisionArgs(record, record.branch),
      view,
    )
    if (handle.status === 'failed') {
      // Persist the finalized env id first so fail()'s cleanup tears it down.
      record.environmentId = handle.id
      await this.guardedUpdate(record, { environmentId: handle.id })
      throw new Error(handle.lastError ?? 'Environment provisioning failed.')
    }
    await this.patch(record, {
      stage: 'tearing_down',
      environmentId: handle.id,
      envUrl: handle.url,
    })
    return { state: 'running' }
  }

  private async advanceTeardown(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    if (record.environmentId) {
      try {
        await this.deps.teardown.teardown(record.workspaceId, record.environmentId)
      } catch (error) {
        // A durable-driver replay can re-enter this stage after teardown already tombstoned the
        // env, if the stage-advance write was lost to a crash between the two. Teardown then
        // 404s on the now-missing env — that means it already succeeded, so treat it as done and
        // move on. Only a GENUINE provider teardown failure (the env is still standing) should
        // fail the self-test, so anything other than a not-found is re-thrown.
        if (!(error instanceof NotFoundError)) throw error
      }
    }
    await this.patch(record, { stage: 'deleting_branch' })
    return { state: 'running' }
  }

  private async advanceDeleteBranch(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    await this.deleteBranch(record)
    const applied = await this.patch(record, { status: 'succeeded', stage: 'done' })
    // A concurrent stop finalized the run first — its terminal state wins.
    return applied ? { state: 'done' } : { state: 'failed' }
  }

  /**
   * Stop a running self-test: tear down the durable driver, run best-effort cleanup
   * (release the in-flight deploy job, tear down the env, reclaim the registry row,
   * delete the branch), then mark it `failed`. Idempotent — a terminal run is returned
   * unchanged.
   */
  async stop(workspaceId: string, id: string): Promise<EnvironmentTestRun> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = assertFound(
      await this.deps.environmentTestRunRepository.get(workspaceId, id),
      'Environment test run',
      id,
    )
    if (record.status !== 'running') return toRun(record)
    await this.deps.runner?.cancelRun(workspaceId, id)
    return this.fail(record, 'Stopped by the user.')
  }

  /**
   * Finalize a wedged run — its durable driver ended (poll budget exhausted, instance
   * terminal) without settling it. Runs the same best-effort cleanup as a stop, then
   * marks the run `failed` with `reason`. Idempotent: a terminal run is returned as-is.
   * Called by the drivers' budget-exhaustion paths and the cron sweeper.
   */
  async expire(workspaceId: string, id: string, reason: string): Promise<EnvironmentTestRun> {
    const record = assertFound(
      await this.deps.environmentTestRunRepository.get(workspaceId, id),
      'Environment test run',
      id,
    )
    if (record.status !== 'running') return toRun(record)
    return this.fail(record, reason)
  }

  // ---- helpers ------------------------------------------------------------

  /** Build the provision args: real frame as `frameId`, synthetic `blockId` (see class docs). */
  private provisionArgs(record: EnvironmentTestRunRecord, branch: string | null): ProvisionArgs {
    return {
      workspaceId: record.workspaceId,
      blockId: this.provisionBlockId(record.id),
      frameId: record.blockId,
      serviceProvisioning: record.provisioning,
      initiatedBy: record.initiatedBy,
      ...(branch ? { context: { branch } } : {}),
    }
  }

  /** Delete the run's temporary branch (best-effort — a missing branch is not an error). */
  private async deleteBranch(record: EnvironmentTestRunRecord): Promise<void> {
    if (!record.branch) return
    const bound = await this.deps.resolveRunRepoContext(record.workspaceId, record.blockId)
    await bound?.repo.deleteBranch(record.branch)
  }

  /**
   * Reclaim whatever registry row is still keyed under the run's synthetic block id —
   * the `provisioning` placeholder from `startProvision`, or a failed finalize's record.
   * The synthetic key is unique per run with no TTL, so nothing else ever supersedes or
   * sweeps it: without this, every failed self-test would accrete a live row in the
   * workspace registry forever. A row that reached real infra (`externalId`) goes
   * through the full provider teardown; a pure placeholder is tombstoned directly, and
   * a failing provider teardown falls back to the tombstone (the run's error already
   * carries the diagnosis — a wedged registry helps nobody).
   */
  private async reclaimRegistryRow(record: EnvironmentTestRunRecord): Promise<void> {
    const row = await this.deps.environmentRegistry.getByBlockAndFrame(
      record.workspaceId,
      this.provisionBlockId(record.id),
      record.blockId,
    )
    if (!row) return
    if (row.externalId) {
      try {
        await this.deps.teardown.teardown(record.workspaceId, row.id)
        return
      } catch {
        // fall through to the tombstone
      }
    }
    await this.deps.environmentRegistry.softDelete(
      record.workspaceId,
      row.id,
      this.deps.clock.now(),
    )
  }

  /**
   * Record a failure, running best-effort cleanup FIRST so a failed diagnostic never
   * leaks a branch, environment, registry row, or deploy runner. `failedStage` captures
   * where it broke. Cleanup runs unconditionally (it is idempotent), but the terminal
   * write is guarded: if a concurrent stop/driver already finalized the run, its state
   * is returned unchanged.
   */
  private async fail(
    record: EnvironmentTestRunRecord,
    message: string,
    cause?: unknown,
  ): Promise<EnvironmentTestRun> {
    const failedStage = record.stage
    // Log the failure server-side — the ONLY server-side trace of a self-test failure (the run
    // record + SPA aside). Carries the stage + message (which now includes any provider
    // field-level detail) and the stack when the cause is an `Error`, so an unexpected throw is
    // debuggable from the logs rather than just the terminal run row.
    this.deps.logger?.warn('environment self-test failed', {
      workspaceId: record.workspaceId,
      runId: record.id,
      failedStage,
      err: message,
      ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
    })
    // Release any in-flight deploy job when provisioning never settled (a stop
    // mid-provision, a dispatch that threw or crashed before the stage patch landed):
    // best-effort abort of the deploy runner so a stopped test doesn't keep a container
    // applying infra. Releasing when nothing was dispatched is a tolerated no-op.
    if (!record.environmentId) {
      try {
        await this.deps.provisioning.releaseProvisionJob(record.workspaceId, this.ref(record.id))
      } catch {
        // best-effort — an unreachable runner idles out on its own
      }
    }
    // Tear the env down if one was provisioned (or finalized as failed).
    if (record.environmentId) {
      try {
        await this.deps.teardown.teardown(record.workspaceId, record.environmentId)
      } catch {
        // best-effort — the registry reclaim below tombstones the row regardless
      }
    }
    // Reclaim any registry row still keyed under the synthetic block id.
    try {
      await this.reclaimRegistryRow(record)
    } catch {
      // best-effort
    }
    // Delete the branch if one was created.
    try {
      await this.deleteBranch(record)
    } catch {
      // best-effort — a stale `cat-factory/env-test/*` branch is harmless
    }
    const patch = {
      status: 'failed' as const,
      error: message,
      failedStage,
      updatedAt: this.deps.clock.now(),
    }
    const applied = await this.deps.environmentTestRunRepository.updateIfRunning(
      record.workspaceId,
      record.id,
      patch,
    )
    if (!applied) {
      // A concurrent stop (or driver) finalized the run first; its terminal state is
      // authoritative — the cleanup above was still worth re-running (idempotent).
      const current = await this.deps.environmentTestRunRepository.get(
        record.workspaceId,
        record.id,
      )
      return toRun(current ?? { ...record, ...patch })
    }
    const failed = { ...record, ...patch }
    await this.emit(failed)
    return toRun(failed)
  }

  /**
   * Persist a stage/status patch on a still-running run, stamp `updatedAt`, and push the
   * transition. Returns false (writing and emitting nothing) when the run was
   * concurrently finalized — the terminal state wins.
   */
  private async patch(
    record: EnvironmentTestRunRecord,
    patch: Partial<Pick<EnvironmentTestRunRecord, 'status' | 'stage' | 'environmentId' | 'envUrl'>>,
  ): Promise<boolean> {
    const full = { ...patch, updatedAt: this.deps.clock.now() }
    const applied = await this.deps.environmentTestRunRepository.updateIfRunning(
      record.workspaceId,
      record.id,
      full,
    )
    if (!applied) return false
    Object.assign(record, full)
    await this.emit(record)
    return true
  }

  /** A guarded field write with an `updatedAt` stamp, without emitting an event. */
  private async guardedUpdate(
    record: EnvironmentTestRunRecord,
    patch: Partial<Pick<EnvironmentTestRunRecord, 'branch' | 'environmentId' | 'envUrl'>>,
  ): Promise<boolean> {
    return this.deps.environmentTestRunRepository.updateIfRunning(record.workspaceId, record.id, {
      ...patch,
      updatedAt: this.deps.clock.now(),
    })
  }

  private async emit(record: EnvironmentTestRunRecord): Promise<void> {
    await this.deps.eventPublisher?.envTestChanged?.(record.workspaceId, toRun(record))
  }
}
