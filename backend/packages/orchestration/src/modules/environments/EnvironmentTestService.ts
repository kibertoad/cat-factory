import type {
  Block,
  Clock,
  EnvironmentHandle,
  EnvironmentTestRun,
  ExecutionEventPublisher,
  IdGenerator,
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
import type { ProvisionArgs, ProvisionDispatch } from '@cat-factory/integrations'

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
  startProvision(args: ProvisionArgs, ref: RunnerJobRef): Promise<ProvisionDispatch>
  pollProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<RunnerJobView>
  finalizeProvision(args: ProvisionArgs, view: RunnerJobView): Promise<EnvironmentHandle>
  releaseProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<void>
}

/** The structural subset of the teardown service the self-test drives. */
export interface EnvironmentTestTeardown {
  teardown(workspaceId: string, id: string): Promise<unknown>
}

export interface EnvironmentTestServiceDependencies {
  environmentTestRunRepository: EnvironmentTestRunRepository
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  provisioning: EnvironmentTestProvisioning
  teardown: EnvironmentTestTeardown
  /** Resolves the frame's run-repo-bound RepoFiles (branch create/delete + base sha). */
  resolveRunRepoContext: ResolveRunRepoContext
  idGenerator: IdGenerator
  clock: Clock
  /** Durably drives the run's poll loop; absent → tests poll `pollEnvTest` directly. */
  runner?: EnvironmentTestRunner
  /** Pushes live stage transitions to subscribed clients. */
  eventPublisher?: ExecutionEventPublisher
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
   * immediately with the `running` run. Pre-flights (frame provisionable, GitHub
   * connected), creates the temporary branch, dispatches provisioning, then hands the
   * poll loop to the durable runner. A pre-flight/dispatch failure runs best-effort
   * cleanup and returns the run already `failed`.
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
        gate.reason ? { reason: gate.reason } : undefined,
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
      const bound = await this.deps.resolveRunRepoContext(workspaceId, blockId)
      if (!bound) {
        throw new ConflictError(
          'This workspace is not connected to a git provider, so no test branch can be created.',
          'env_test_no_vcs',
        )
      }
      const baseSha = await bound.repo.headSha(bound.baseBranch)
      if (!baseSha) {
        throw new Error(`The repository's default branch '${bound.baseBranch}' has no head commit.`)
      }
      const branch = `cat-factory/env-test/${record.id}`
      await bound.repo.createBranch(branch, baseSha)

      // Dispatch provisioning for the temp branch under the synthetic block id.
      const dispatch = await this.deps.provisioning.startProvision(
        this.provisionArgs(record, provisioning, branch),
        this.ref(record.id),
      )
      const patch =
        dispatch.kind === 'completed'
          ? {
              branch,
              stage: 'provisioning' as const,
              environmentId: dispatch.handle.id,
              envUrl: dispatch.handle.url,
              updatedAt: this.deps.clock.now(),
            }
          : { branch, stage: 'provisioning' as const, updatedAt: this.deps.clock.now() }
      await this.deps.environmentTestRunRepository.update(workspaceId, record.id, patch)
      const running = { ...record, ...patch }
      await this.emit(running)

      // Hand off the long poll loop to the durable driver (tests poll directly).
      await this.deps.runner?.startRun(workspaceId, record.id)
      return toRun(running)
    } catch (error) {
      return this.fail(record, getErrorMessage(error))
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
        case 'provisioning':
          return await this.advanceProvisioning(record)
        case 'tearing_down':
          return await this.advanceTeardown(record)
        case 'deleting_branch':
          return await this.advanceDeleteBranch(record)
        default:
          // `creating_branch`/`done` are never polled: the former is settled in
          // `startTest` before the driver starts, the latter is terminal.
          return { state: 'running' }
      }
    } catch (error) {
      const run = await this.fail(record, getErrorMessage(error))
      return { state: 'failed', error: run.error ?? undefined }
    }
  }

  private async advanceProvisioning(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    // The synchronous (raw-manifest / compose) path already recorded the env in
    // `startTest`; nothing to poll, just move on to teardown.
    if (record.environmentId) {
      await this.patch(record, { stage: 'tearing_down' })
      return { state: 'running' }
    }
    const view = await this.deps.provisioning.pollProvisionJob(
      record.workspaceId,
      this.ref(record.id),
    )
    if (view.state === 'running') return { state: 'running' }
    if (view.state === 'failed') {
      throw new Error(view.error ?? 'Environment provisioning failed.')
    }
    // Done: reclaim the deploy runner, finalize the env record, move to teardown.
    await this.deps.provisioning.releaseProvisionJob(record.workspaceId, this.ref(record.id))
    const provisioning = await this.resolveProvisioning(record)
    const handle = await this.deps.provisioning.finalizeProvision(
      this.provisionArgs(record, provisioning, record.branch),
      view,
    )
    if (handle.status === 'failed') {
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

  /**
   * Finalize a run that exhausted its durable poll budget without converging: run best-effort
   * cleanup (tear down any env + delete the branch) and mark it `failed`. The durable drivers
   * (Cloudflare Workflow / pg-boss) call this once their poll loop ends non-terminally, because
   * these runs live in their own table with NO stuck-run sweeper (unlike the `agent_runs`-backed
   * flows) — without it a run whose provisioning never finished in budget would be left `running`
   * forever, orphaning its throwaway branch (and environment). Idempotent: a run that already
   * reached a terminal state (or vanished) is returned/skipped unchanged.
   */
  async finalizeExhausted(workspaceId: string, id: string): Promise<EnvironmentTestRun | null> {
    const record = await this.deps.environmentTestRunRepository.get(workspaceId, id)
    if (!record) return null
    if (record.status !== 'running') return toRun(record)
    return this.fail(record, 'The environment self-test did not finish within its time budget.')
  }

  private async advanceDeleteBranch(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    await this.deleteBranch(record)
    await this.patch(record, { status: 'succeeded', stage: 'done' })
    return { state: 'done' }
  }

  /**
   * Stop a running self-test: tear down the durable driver, run best-effort cleanup
   * (teardown the env + delete the branch), then mark it `failed`. Idempotent — a
   * terminal run is returned unchanged.
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

  // ---- helpers ------------------------------------------------------------

  /** Build the provision args: real frame as `frameId`, synthetic `blockId` (see class docs). */
  private provisionArgs(
    record: EnvironmentTestRunRecord,
    provisioning: NonNullable<Block['provisioning']>,
    branch: string | null,
  ): ProvisionArgs {
    return {
      workspaceId: record.workspaceId,
      blockId: this.provisionBlockId(record.id),
      frameId: record.blockId,
      serviceProvisioning: provisioning,
      initiatedBy: record.initiatedBy,
      ...(branch ? { context: { branch } } : {}),
    }
  }

  /** Re-read the frame's provisioning for a finalize/teardown resolve; throws if it vanished. */
  private async resolveProvisioning(
    record: EnvironmentTestRunRecord,
  ): Promise<NonNullable<Block['provisioning']>> {
    const frame = await this.deps.blockRepository.get(record.workspaceId, record.blockId)
    const provisioning = frame?.provisioning
    if (!provisioning || provisioning.type === 'infraless') {
      throw new Error('The service’s provisioning configuration is no longer available.')
    }
    return provisioning
  }

  /** Delete the run's temporary branch (best-effort — a missing branch is not an error). */
  private async deleteBranch(record: EnvironmentTestRunRecord): Promise<void> {
    if (!record.branch) return
    const bound = await this.deps.resolveRunRepoContext(record.workspaceId, record.blockId)
    await bound?.repo.deleteBranch(record.branch)
  }

  /**
   * Record a failure, running best-effort cleanup FIRST so a failed diagnostic never
   * leaks a branch or environment. `failedStage` captures where it broke.
   */
  private async fail(
    record: EnvironmentTestRunRecord,
    message: string,
  ): Promise<EnvironmentTestRun> {
    const failedStage = record.stage
    // Tear the env down if one was provisioned.
    if (record.environmentId) {
      try {
        await this.deps.teardown.teardown(record.workspaceId, record.environmentId)
      } catch {
        // best-effort — the TTL reaper is the backstop
      }
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
    await this.deps.environmentTestRunRepository.update(record.workspaceId, record.id, patch)
    const failed = { ...record, ...patch }
    await this.emit(failed)
    return toRun(failed)
  }

  /** Persist a stage/status patch, stamp `updatedAt`, and push the transition. */
  private async patch(
    record: EnvironmentTestRunRecord,
    patch: Partial<Pick<EnvironmentTestRunRecord, 'status' | 'stage' | 'environmentId' | 'envUrl'>>,
  ): Promise<void> {
    const full = { ...patch, updatedAt: this.deps.clock.now() }
    await this.deps.environmentTestRunRepository.update(record.workspaceId, record.id, full)
    Object.assign(record, full)
    await this.emit(record)
  }

  private async emit(record: EnvironmentTestRunRecord): Promise<void> {
    await this.deps.eventPublisher?.envTestChanged?.(record.workspaceId, toRun(record))
  }
}
