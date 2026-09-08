import type {
  Block,
  Clock,
  ConnectionTestResult,
  EnvironmentHandle,
  EnvironmentProbeSurface,
  EnvironmentTestMode,
  EnvironmentTestRun,
  ExecutionEventPublisher,
  IdGenerator,
  Logger,
  ResolveRunRepoContext,
  RunnerJobRef,
  RunnerJobView,
  StepSubtasks,
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
  describeTerminalEnvironment,
  getErrorMessage,
  NotFoundError,
  noopLogger,
  requireWorkspace,
  runBestEffort,
} from '@cat-factory/kernel'
import { environmentProbeAgentKind } from '@cat-factory/contracts'
import type { ProvisionArgs, ProvisionDispatch, SettledProvision } from '@cat-factory/integrations'
import type { EnvironmentProbeStage } from './environmentProbeStage.js'

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
  /**
   * Drives the AGENT DRY RUN's `probing` stage. Absent ⇒ this deployment cannot run one (no
   * container transport, no proxyable model, no repository seam), and `startTest` refuses the
   * `agent-probe` mode up front rather than letting a run reach a stage nothing can advance.
   */
  probeStage?: EnvironmentProbeStage
  /**
   * The workspace spend safeguard, consulted before an AGENT DRY RUN is admitted.
   *
   * A dry run is a billable model call that NO run start gates (a self-test is not a pipeline
   * run), so it answers to the same budget `RunAdmission` applies before a run, exactly as the bug
   * hunt's ranking and the monorepo survey do. Asked at ADMISSION and not later, because by the
   * time the container's first completion is refused by the proxy the operator has already paid
   * for a branch, a provision and a teardown to be told about a ceiling that was knowable up
   * front. Absent ⇒ no budget is enforced, which is the pre-existing behaviour for a facade that
   * wires no spend service at all.
   */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
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
    mode: record.mode,
    status: record.status,
    stage: record.stage,
    branch: record.branch,
    envUrl: record.envUrl,
    error: record.error,
    failedStage: record.failedStage,
    probe: record.probe,
    probeProgress: record.probeProgress,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// EnvironmentTestService: the ephemeral-environment SELF-TEST run, in two modes.
//
// A developer-triggered diagnostic that exercises a service frame's configured
// provisioning end to end against a THROWAWAY branch and always cleans up:
//   creating_branch → provisioning → [probing] → tearing_down → deleting_branch → done
// (or `failed` with the stage it failed at). It touches no board block and
// leaves no branch/env behind. Modelled like a bootstrap run: `startTest`
// does the fast up-front work + dispatch and hands off to the durable driver;
// `pollEnvTest` advances the state machine idempotently so replays are safe.
//
// `probing` is the AGENT DRY RUN (`mode: 'agent-probe'`): the environment is handed to a prober
// that tries to OPERATE the service and reports what it managed and what it could not work out
// (see `environmentProbeStage.ts`). It is ONE state machine rather than two services on purpose:
// the always-cleans-up contract, the stop⇄driver race guard and the sweeper are the hard parts of
// this flow, and a second implementation of them is a second set of ways to strand an
// environment. The extra mode costs one stage, one claim field and one report field.
//
// The run's `status` stays a statement about the LIFECYCLE in both modes: a dry run that reports
// `inoperable` SUCCEEDED, because the diagnostic did its job and cleaned up. What the agent found
// is the report's own `verdict`; see the contract's note on `status`.
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
  /**
   * The injected logger, normalised once so every site can log unconditionally (and so
   * `runBestEffort`, which requires one, can be used at all). See CLAUDE.md's logging rules.
   */
  private readonly log: Logger

  constructor(private readonly deps: EnvironmentTestServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

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
   * The agent kind an `agent-probe` self-test of this block would run as, so the START edge can
   * gate the run on the initiator's personal subscription BEFORE anything is created.
   *
   * Asked of the service rather than derived at the edge because the answer is the frame's TYPE
   * (a frontend frame is driven by a browser prober, everything else by an HTTP one), and the
   * dispatch resolves its model under this exact kind. A gate that guessed a different one would
   * either demand a credential the run never leases or admit a run that then fails at the lease,
   * after a branch, a provision and a teardown.
   *
   * `null` means there is NO dry run to gate, which covers every way that can be true: this
   * deployment cannot drive one, the block is gone, or the block is not something a dry run can be
   * run against at all (a task or module, or a service with no ephemeral provisioning). The last
   * two are the ones worth stating: answering a prober kind for a block `startTest` will refuse
   * outright is what asks a developer for their unlock password before telling them the run was
   * never possible.
   */
  async probeAgentKind(workspaceId: string, blockId: string): Promise<string | null> {
    if (!this.deps.probeStage) return null
    const frame = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!frame || frame.level !== 'frame') return null
    if (!frame.provisioning || frame.provisioning.type === 'infraless') return null
    return environmentProbeAgentKind(this.deps.probeStage.surfaceFor(frame))
  }

  /**
   * Kick off a self-test against a service frame's provisioning config and return
   * immediately with the `running` run. Pre-flights (frame provisionable, git provider
   * connected) throw as 409s BEFORE any record exists; after the record is inserted,
   * every failure runs best-effort cleanup and returns the run already `failed`.
   *
   * `resolveActivation` produces the closure that mints the initiator's individual-usage credential
   * for THIS run. Passed in rather than resolved here for the reason the pipeline path passes its
   * equivalent: only the HTTP edge holds the unlock password, and only it can answer a caller who
   * has not supplied one.
   *
   * It is a CLOSURE returning a closure, so that resolving it (which is what raises the
   * `428 credential_required` a client re-prompts on) happens AFTER every structural refusal
   * below. Resolved eagerly at the edge instead, a dry run that could never have started (a
   * self-test already running for the frame, a model the deployment cannot dispatch) asked the
   * developer for their password first and only then answered the 409 that needed no credential to
   * establish. Returning `undefined` means the run needs no personal credential: a `provision`
   * self-test always, and an `agent-probe` whose model is not an individual-usage one.
   */
  async startTest(
    workspaceId: string,
    blockId: string,
    initiatedBy?: string | null,
    mode: EnvironmentTestMode = 'provision',
    resolveActivation?: () => Promise<((runId: string) => Promise<void>) | undefined>,
  ): Promise<EnvironmentTestRun> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // Refuse an agent dry run this deployment cannot drive BEFORE anything is provisioned. A run
    // admitted here would create a branch, stand an environment up and then park at a stage with
    // nothing to advance it, until the sweeper tore the whole thing down with a timeout for a
    // reason (a wiring gap) that was knowable before a single side effect.
    if (mode === 'agent-probe' && !this.deps.probeStage) {
      throw new ConflictError(
        'Agent dry runs are not available on this deployment: they need a container runner and a ' +
          'connected repository.',
        'env_test_probe_unavailable',
      )
    }

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
    // ONE self-test at a time per frame, whichever mode. Each run provisions its own environment
    // under a synthetic per-run key that nothing supersedes or sweeps, so two in flight is two live
    // environments for one service: billed twice, and racing each other to create on any provider
    // whose namespace is derived per service rather than per branch. Enforced here rather than in
    // the SPA's button state, which is per mode and per tab and so cannot see the other run.
    const live = (
      await this.deps.environmentTestRunRepository.listRunningByWorkspace(workspaceId)
    ).find((row) => row.blockId === blockId)
    if (live) {
      throw new ConflictError(
        'A self-test is already running for this service. Wait for it to finish, or stop it first.',
        'env_test_already_running',
        { runId: live.id, runMode: live.mode },
      )
    }
    if (mode === 'agent-probe') await this.assertProbeAdmissible(workspaceId, frame, initiatedBy)
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

    // The last gate, and deliberately last: resolving it is what asks the caller for a password,
    // so every refusal that needs no credential has already been answered by here.
    const activate = await resolveActivation?.()

    const now = this.deps.clock.now()
    const id = this.deps.idGenerator.next('envtest')
    // Mint the activation BEFORE the row exists, and OUTSIDE the try below, exactly as
    // `RunLifecycleController.start` does: a credential that cannot be unlocked has to reach the
    // caller as the refusal it is. Run after the insert instead, `activate` throwing
    // `CredentialRequiredError` was caught by the cleanup path and answered 201 with a `failed`
    // run: a RESOLVED action to the SPA, so the 428 that reopens the password modal never fired,
    // the stale cached password was never cleared, and every retry silently burned another run.
    // There is nothing to clean up here yet: no branch, no environment, no row.
    await activate?.(id)
    const record: EnvironmentTestRunRecord = {
      id,
      workspaceId,
      blockId,
      mode,
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
      probeSurface: null,
      probeDispatchedAt: null,
      probeModel: null,
      probeSubscriptionTokenId: null,
      probeSubscriptionVendor: null,
      probeProgress: null,
      probe: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.environmentTestRunRepository.insert(record)
    await this.emit(record)

    try {
      // Create the throwaway branch off the frame repo's default head. The activation minted above
      // outlives a provision by hours (12h TTL), so the probe stage minutes later still finds it
      // live.
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
   * The three gates an AGENT DRY RUN answers to beyond the provisioning self-test's, all asked
   * BEFORE the first side effect, because each is knowable then and none is knowable cheaply
   * afterwards. Every one of them, left to the dispatch, costs a throwaway branch, a full
   * provision and (on the way back out) a teardown to report something already decided.
   *
   * A wired prober is not the same question as a runnable one, and there are two ways to be
   * unrunnable. The IMAGE: each surface runs on its own executor image, so a deployment that binds
   * the plain container class and not the browser one serves an `api` dry run and refuses a `ui`
   * one deep inside `stage.dispatch`. The MODEL: the prober runs whatever this workspace's preset
   * names for its kind, which may be a provider the LLM proxy cannot serve, or a subscription-only
   * model whose credential nobody connected. Both are the facade's answers, asked through the
   * stage; the refusals stay separate because the fixes are (an image to bind vs a preset to
   * change), and one message covering both would name the wrong one every other time.
   *
   * And a workspace past its spend ceiling would pay for exactly the same sequence before the
   * proxy refused the container's first completion.
   */
  private async assertProbeAdmissible(
    workspaceId: string,
    frame: Block,
    initiatedBy?: string | null,
  ): Promise<void> {
    const stage = this.deps.probeStage
    if (!stage) return
    const surface = stage.surfaceFor(frame)
    if (!(await stage.supports(workspaceId, surface))) {
      throw new ConflictError(
        surface === 'ui'
          ? 'A dry run for a frontend service runs in a browser container, and this deployment ' +
              'has no browser executor image wired. Dry runs of its backend services still run.'
          : 'This deployment has no executor image wired for an agent dry run of this service.',
        'env_test_probe_unavailable',
        { surface },
      )
    }
    // The facade's own verdict, carried verbatim: it is produced by the code that would otherwise
    // have thrown at dispatch, so admission and dispatch cannot name different causes for one
    // misconfiguration. The `detail` rides its own key, never `reason`, which `ConflictError`
    // reserves for the code the SPA keys its localized copy off.
    const dispatchable = await stage.checkDispatchable(
      { workspaceId, blockId: frame.id, initiatedBy: initiatedBy ?? null },
      surface,
    )
    if (!dispatchable.ok) {
      throw new ConflictError(
        `An agent dry run cannot run on the model this service resolves to. ${dispatchable.detail}`,
        'env_test_probe_model_unavailable',
        { surface, modelIssue: dispatchable.detail },
      )
    }
    if (await this.overBudget(workspaceId, initiatedBy)) {
      throw new ConflictError(
        'This workspace has reached a spend budget, and an agent dry run is a billable model ' +
          'call. Raise the budget (or wait for the billing period to reset) and try again; the ' +
          'provisioning self-test beside it costs nothing and still runs.',
        'env_test_over_budget',
      )
    }
  }

  /**
   * Whether the workspace is over its model budget. Fails CLOSED, as the monorepo survey's probe
   * does: a ledger nobody can read is not a licence to spend against it.
   */
  private async overBudget(workspaceId: string, initiatedBy?: string | null): Promise<boolean> {
    const probe = this.deps.isOverBudget
    if (!probe) return false
    try {
      return await probe(workspaceId)
    } catch (error) {
      this.log.warn('environment dry run: budget probe failed; refusing the run', {
        workspaceId,
        initiatedBy: initiatedBy ?? null,
        err: getErrorMessage(error),
      })
      return true
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
        case 'probing':
          return await this.advanceProbing(record)
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
          stage: this.stageAfterProvisioning(record),
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
      // message is kernel's, so this reader cannot disagree with the readiness ceiling about the
      // same environment: the provider's error where it recorded one, otherwise the STATE named
      // with the last note appended rather than standing in for it (a bare note would report the
      // spin-up this environment was in the middle of as the reason it ended up terminal).
      throw new Error(describeTerminalEnvironment(handle))
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
      stage: this.stageAfterProvisioning(record),
      environmentId: handle.id,
      envUrl: handle.url,
    })
    return { state: 'running' }
  }

  /**
   * Where a run goes once its environment is up: straight to teardown, or through the dry run
   * first. One helper rather than the ternary twice, because `advanceProvisioning` has two exits
   * (the synchronous provider's readiness poll and the deploy job's finalize) and a mode honoured
   * at only one of them is a dry run that silently skips the probe for half the providers.
   */
  private stageAfterProvisioning(record: EnvironmentTestRunRecord): 'probing' | 'tearing_down' {
    return record.mode === 'agent-probe' ? 'probing' : 'tearing_down'
  }

  /**
   * Advance the AGENT DRY RUN: claim and dispatch the prober, then poll it, then record what it
   * reported and move on to teardown.
   *
   * Three writes in a fixed order, and each one is load-bearing:
   *
   *  1. the CLAIM (`probeSurface`), before the dispatch, so a replay cannot start a second agent
   *     against the same environment;
   *  2. the DISPATCH;
   *  3. the MARK (`probeDispatchedAt`), after it is accepted, so a replay that landed in between
   *     can tell a claim with no container behind it from a running job. Without the mark, such a
   *     replay polls a job that was never started and the backend's "no such job" comes back as an
   *     EVICTION: a lost isolate reported to the developer as a container failure. With it, the
   *     replay re-dispatches instead, which is safe because a dispatch is idempotent per job id.
   *
   * Every write goes through the same running-guard, which makes the stop ⇄ driver race
   * first-writer-wins in both directions. The mark's guard does double duty: a stop that landed
   * while the dispatch was in flight ran its reclaim against a container that did not exist yet, so
   * a rejected mark means the container now starting has nobody left to reclaim it. That throws,
   * and `fail()` (whose FIRST action is the reclaim) is what actually collects it.
   *
   * A probe that FAILS (an evicted container, a reply with no JSON) throws, so the run fails at
   * this stage with the container's error and `fail()` reclaims the environment. A probe that
   * REPORTS advances, whatever its verdict: an `inoperable` verdict is the diagnostic working, and
   * the run still owes the developer its teardown.
   */
  private async advanceProbing(
    record: EnvironmentTestRunRecord,
  ): Promise<EnvironmentTestPollResult> {
    const stage = this.deps.probeStage
    if (!stage) {
      // Only reachable when a deployment lost the capability between the start and the poll (a
      // redeploy mid-run). Nothing can advance the run, so fail it here rather than spin: the
      // environment is up and every poll is costing the developer.
      throw new Error('Agent dry runs are no longer configured on this deployment.')
    }
    const claimed = record.probeSurface
    if (!claimed || !record.probeDispatchedAt) {
      // ONE frame read, shared by the surface and the prompt: see `resolveTarget`. The PINNED
      // surface still wins on a re-dispatch, because the claim addresses a container.
      const target = await stage.resolveTarget(record)
      const surface = claimed ?? target.surface
      if (!claimed && !(await this.guardedUpdate(record, { probeSurface: surface }))) {
        throw new Error('The environment test was stopped before the agent dry run started.')
      }
      record.probeSurface = surface
      const handle = await stage.dispatch(record, surface, target.frame)
      const probeDispatchedAt = this.deps.clock.now()
      // The MARK and the dispatch's ATTRIBUTION in one write, because they are one fact: what the
      // dispatch resolved is only meaningful for a dispatch that happened, and every later poll
      // rebuilds its handle from this row (see `EnvironmentProbeDispatch`). The model that ran and
      // the pooled token that paid for it are what the poll cannot re-derive: one because the
      // frame and preset it came from can change while the container works, the other because the
      // lease happens once, here.
      const attribution = {
        probeModel: handle.dispatch?.model ?? null,
        probeSubscriptionTokenId: handle.dispatch?.subscriptionTokenId ?? null,
        probeSubscriptionVendor: handle.dispatch?.subscriptionVendor ?? null,
      }
      if (!(await this.guardedUpdate(record, { probeDispatchedAt, ...attribution }))) {
        throw new Error('The environment test was stopped while the agent dry run was starting.')
      }
      record.probeDispatchedAt = probeDispatchedAt
      Object.assign(record, attribution)
      return { state: 'running' }
    }
    const outcome = await stage.poll(record, claimed)
    if (outcome.state === 'running') {
      await this.writeProbeProgress(record, outcome.subtasks)
      return { state: 'running' }
    }
    // The report is in hand, so the prober's container has nothing left to do: reclaim it before
    // teardown rather than leaving it to idle out beside an environment that is about to vanish.
    await this.releaseProbe(record)
    // The live counts go with it: the report is the finer answer to the same question, and a stale
    // "3 of 5" left beside a finished run reads as a probe still working.
    await this.patch(record, {
      stage: 'tearing_down',
      probe: outcome.report,
      probeProgress: null,
    })
    return { state: 'running' }
  }

  /**
   * Persist the prober's live todo counts, and push them, when they MOVED.
   *
   * `probing` is the only stage of this run measured in minutes; every other one turns over in
   * seconds. With nothing written the run row never changes, so no `envTestChanged` event fires
   * for the whole probe and the SPA sits on "probing with an agent" for the entire container run,
   * which is indistinguishable from a wedge. Compared on the COUNTS alone: the item labels move
   * whenever the agent rewords a todo, and a write per poll is the cost this guard exists to
   * avoid.
   */
  private async writeProbeProgress(
    record: EnvironmentTestRunRecord,
    subtasks: StepSubtasks | undefined,
  ): Promise<void> {
    if (!subtasks) return
    const current = record.probeProgress
    if (
      current &&
      current.completed === subtasks.completed &&
      current.inProgress === subtasks.inProgress &&
      current.total === subtasks.total
    ) {
      return
    }
    await this.patch(record, { probeProgress: subtasks })
  }

  /**
   * Reclaim the dry run's container, if one was ever claimed. Best-effort by contract (an
   * unreachable runner idles out on its own), and it must never propagate: every caller is either
   * settling a run or already failing one.
   */
  private async releaseProbe(record: EnvironmentTestRunRecord): Promise<void> {
    const stage = this.deps.probeStage
    const surface: EnvironmentProbeSurface | null = record.probeSurface
    if (!stage || !surface) return
    await runBestEffort(
      this.log,
      'release environment dry-run container',
      () => stage.release(record, surface),
      { workspaceId: record.workspaceId, runId: record.id, surface },
    )
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
    this.log.warn('environment self-test failed', {
      workspaceId: record.workspaceId,
      runId: record.id,
      failedStage,
      err: message,
      ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
    })
    // Reclaim the dry run's container when one was claimed and never settled (a stop mid-probe, a
    // dispatch that threw, a replay that failed the run). It is claimed before it is dispatched,
    // so a claim with no container behind it is a tolerated no-op. The opposite ordering would
    // leave a browser container running for its full lifetime beside a torn-down environment.
    await this.releaseProbe(record)
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
    patch: Partial<
      Pick<
        EnvironmentTestRunRecord,
        'status' | 'stage' | 'environmentId' | 'envUrl' | 'probe' | 'probeProgress'
      >
    >,
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
    patch: Partial<
      Pick<
        EnvironmentTestRunRecord,
        'branch' | 'environmentId' | 'envUrl' | 'probeSurface' | 'probeDispatchedAt'
      >
    >,
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
