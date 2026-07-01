import type {
  AgentFailure,
  AgentFailureKind,
  Clock,
  EnvConfigRepairer,
  EnvConfigRepairJob,
  EnvConfigRepairJobRecord,
  EnvConfigRepairJobRepository,
  EnvConfigRepairRunner,
  ExecutionEventPublisher,
  IdGenerator,
  RepairAgentSpec,
  RepoValidationIssue,
  RepoValidationResult,
  StepSubtasks,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  requireWorkspace,
  sameSubtasks,
} from '@cat-factory/kernel'

/** The poll's terminal-ness, returned to the durable driver so it knows when to stop. */
export interface EnvConfigRepairPollResult {
  state: 'running' | 'done' | 'failed'
  /** Present when `state === 'failed'`. */
  error?: string
}

/** Inputs to kick off a config-repair run (the env service's agent fallback). */
export interface StartEnvConfigRepairInput {
  owner: string
  repo: string
  /** Branch the agent clones, repairs in place, and pushes the fix back onto. */
  gitRef: string
  /** The validation issues that triggered the repair (folded into the agent prompt). */
  issues: RepoValidationIssue[]
  /** The bootstrap form inputs, when available (folded into the agent prompt). */
  inputs?: Record<string, string>
  /** Explicit repair prompt (custom-manifest generate/fix), overriding `describeRepairAgent`. */
  promptOverride?: RepairAgentSpec
  /** The single repo-relative manifest path the agent creates/fixes (for the prompt context). */
  manifestPath?: string
}

export interface EnvConfigRepairServiceDependencies {
  envConfigRepairJobRepository: EnvConfigRepairJobRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Performs the side-effecting dispatch/poll/release of the repair container; optional. */
  repairer?: EnvConfigRepairer
  /** Durably drives the run's poll loop; optional (tests poll directly). */
  runner?: EnvConfigRepairRunner
  /** Pushes live repair progress / outcome to subscribed clients. */
  eventPublisher?: ExecutionEventPublisher
  /**
   * Re-validate the repo after the agent pushes its fix — where the decrypted secrets +
   * manifest config live (the environments connection service). Drives the terminal
   * `ok`/`issues` recorded on a successful poll.
   */
  revalidate: (input: {
    workspaceId: string
    owner: string
    repo: string
    gitRef: string
  }) => Promise<RepoValidationResult>
}

// ---------------------------------------------------------------------------
// EnvConfigRepairService: owns the durable, asynchronous "repair the provider's
// config file" run (PR #416 increment 2). Modelled exactly on BootstrapService —
// `start` dispatches the container and hands the poll loop to the durable runner,
// `pollJob` advances one poll and finalises the run; on success it RE-VALIDATES the
// repo (where the decrypted secrets live) and records the outcome. There is NO board
// block: the run is surfaced only on the infrastructure-providers window.
// ---------------------------------------------------------------------------

function toJob(record: EnvConfigRepairJobRecord): EnvConfigRepairJob {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    owner: record.owner,
    repo: record.repo,
    branch: record.branch,
    status: record.status,
    ok: record.ok,
    issues: record.issues,
    subtasks: record.subtasks,
    error: record.error,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export class EnvConfigRepairService {
  constructor(private readonly deps: EnvConfigRepairServiceDependencies) {}

  /** True when a repair run can actually be performed (the repairer is wired). */
  get canRepair(): boolean {
    return this.deps.repairer !== undefined
  }

  async listJobs(workspaceId: string): Promise<EnvConfigRepairJob[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const records = await this.deps.envConfigRepairJobRepository.listByWorkspace(workspaceId)
    return records.map(toJob)
  }

  async getJob(workspaceId: string, id: string): Promise<EnvConfigRepairJob> {
    return toJob(
      assertFound(
        await this.deps.envConfigRepairJobRepository.get(workspaceId, id),
        'Environment config repair job',
        id,
      ),
    )
  }

  /**
   * Kick off a config-repair run and return immediately with the `running` job. The run
   * is asynchronous + observable: it dispatches the repair container, then hands the poll
   * loop to the durable runner — which streams subtask progress and, on success, re-validates
   * the repo and records the outcome. A dispatch failure returns the job already `failed`.
   * Requires {@link canRepair}.
   */
  async start(workspaceId: string, input: StartEnvConfigRepairInput): Promise<EnvConfigRepairJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const repairer = this.deps.repairer
    if (!repairer) throw new Error('Environment config repair is not configured')

    const now = this.deps.clock.now()
    const record: EnvConfigRepairJobRecord = {
      id: this.deps.idGenerator.next('envfix'),
      workspaceId,
      owner: input.owner,
      repo: input.repo,
      branch: input.gitRef,
      status: 'running',
      ok: null,
      issues: [],
      // Persisted so a retry re-dispatches with the same prompt context (see `retry`).
      inputs: input.inputs ?? null,
      subtasks: null,
      error: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.envConfigRepairJobRepository.insert(record)

    try {
      await repairer.startRepair({
        workspaceId,
        jobId: record.id,
        owner: input.owner,
        repo: input.repo,
        gitRef: input.gitRef,
        issues: input.issues,
        ...(input.inputs ? { inputs: input.inputs } : {}),
        ...(input.promptOverride ? { promptOverride: input.promptOverride } : {}),
        ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
      })
    } catch (error) {
      const message = getErrorMessage(error)
      const kind: AgentFailureKind = /dispatch failed/i.test(message) ? 'dispatch' : 'preflight'
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure(kind, message, null, null),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.envConfigRepairJobRepository.update(workspaceId, record.id, patch)
      await this.stopContainer(workspaceId, record.id)
      const failed = toJob({ ...record, ...patch })
      await this.emit(workspaceId, failed)
      return failed
    }

    await this.deps.runner?.startRun(workspaceId, record.id)
    const job = toJob(record)
    await this.emit(workspaceId, job)
    return job
  }

  /**
   * Retry a terminally-failed repair by STARTING a fresh run from the old job's coords
   * (a repair is a one-shot clone→fix→push, so there's no same-id re-drive). The original
   * `inputs` are recovered from the persisted record so the new run gets the same prompt
   * context — they live only on the record (never on the wire), so this is the only path
   * that can re-thread them. The old failed row stays as the audit trail.
   */
  async retry(workspaceId: string, jobId: string): Promise<EnvConfigRepairJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const previous = assertFound(
      await this.deps.envConfigRepairJobRepository.get(workspaceId, jobId),
      'Environment config repair job',
      jobId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(
        `Only a failed repair run can be retried (run is '${previous.status}').`,
        'run_not_retryable',
        { status: previous.status },
      )
    }
    return this.start(workspaceId, {
      owner: previous.owner,
      repo: previous.repo,
      gitRef: previous.branch,
      issues: previous.issues,
      ...(previous.inputs ? { inputs: previous.inputs } : {}),
    })
  }

  /**
   * Advance one running repair job by polling its container once: stream subtask counts
   * while it runs, and on a terminal outcome re-validate the repo (on success) and finalise
   * the job. Idempotent — a terminal job is returned as-is, so the driver's replays are safe.
   */
  async pollJob(workspaceId: string, jobId: string): Promise<EnvConfigRepairPollResult> {
    const record = assertFound(
      await this.deps.envConfigRepairJobRepository.get(workspaceId, jobId),
      'Environment config repair job',
      jobId,
    )
    if (record.status === 'succeeded') return { state: 'done' }
    if (record.status === 'failed') return { state: 'failed', error: record.error ?? undefined }

    const repairer = this.deps.repairer
    if (!repairer) throw new Error('Environment config repair is not configured')

    const update = await repairer.pollRepair({ workspaceId, jobId })

    if (update.state === 'running') {
      if (update.subtasks && !sameSubtasks(record.subtasks, update.subtasks)) {
        const patch = { subtasks: update.subtasks, updatedAt: this.deps.clock.now() }
        await this.deps.envConfigRepairJobRepository.update(workspaceId, jobId, patch)
        await this.emit(workspaceId, toJob({ ...record, ...patch }))
      }
      return { state: 'running' }
    }

    if (update.state === 'failed') {
      const message = update.error ?? 'Environment config repair failed'
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure(
          update.failureKind ?? 'unknown',
          message,
          update.detail ?? null,
          record.subtasks,
        ),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.envConfigRepairJobRepository.update(workspaceId, jobId, patch)
      await this.stopContainer(workspaceId, jobId)
      await this.emit(workspaceId, toJob({ ...record, ...patch }))
      return { state: 'failed', error: message }
    }

    // Done: the agent pushed its fix; re-validate the repo (where the decrypted secrets +
    // manifest config live) and record the post-repair outcome. A re-validation throw is a
    // job failure — the push happened but we can't confirm the config is valid.
    await this.stopContainer(workspaceId, jobId)
    let validation: RepoValidationResult
    try {
      validation = await this.deps.revalidate({
        workspaceId,
        owner: record.owner,
        repo: record.repo,
        gitRef: record.branch,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure('agent', message, null, record.subtasks),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.envConfigRepairJobRepository.update(workspaceId, jobId, patch)
      await this.emit(workspaceId, toJob({ ...record, ...patch }))
      return { state: 'failed', error: message }
    }
    const patch = {
      status: 'succeeded' as const,
      ok: validation.ok,
      issues: validation.issues,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.envConfigRepairJobRepository.update(workspaceId, jobId, patch)
    await this.emit(workspaceId, toJob({ ...record, ...patch }))
    return { state: 'done' }
  }

  /**
   * Explicitly stop a running repair: kill its container, tear down the durable driver,
   * mark the job `failed` (kind `cancelled`). Idempotent — a terminal job is returned as-is.
   */
  async stop(
    workspaceId: string,
    jobId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<EnvConfigRepairJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = assertFound(
      await this.deps.envConfigRepairJobRepository.get(workspaceId, jobId),
      'Environment config repair job',
      jobId,
    )
    if (record.status === 'succeeded' || record.status === 'failed') return toJob(record)

    await this.stopContainer(workspaceId, jobId)
    await this.deps.runner?.cancelRun(workspaceId, jobId)

    const message = opts.reason ?? 'Stopped by the user.'
    const patch = {
      status: 'failed' as const,
      error: message,
      failure: this.buildFailure(opts.kind ?? 'cancelled', message, null, record.subtasks),
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.envConfigRepairJobRepository.update(workspaceId, jobId, patch)
    await this.emit(workspaceId, toJob({ ...record, ...patch }))
    return toJob({ ...record, ...patch })
  }

  /** Assemble the structured failure diagnostics stored on a faulted job. */
  private buildFailure(
    kind: AgentFailureKind,
    message: string,
    detail: string | null,
    lastSubtasks: StepSubtasks | null,
  ): AgentFailure {
    return {
      kind,
      message,
      detail,
      hint: FAILURE_HINTS[kind] ?? FAILURE_HINTS.unknown,
      occurredAt: this.deps.clock.now(),
      lastSubtasks: lastSubtasks ?? null,
    }
  }

  /** Best-effort: reclaim a job's per-run container (never throws). */
  private async stopContainer(workspaceId: string, jobId: string): Promise<void> {
    try {
      await this.deps.repairer?.stopRepair({ workspaceId, jobId })
    } catch {
      // The container may already be gone; the job state is authoritative.
    }
  }

  /** Best-effort push of a repair transition to subscribed clients. */
  private async emit(workspaceId: string, job: EnvConfigRepairJob): Promise<void> {
    await this.deps.eventPublisher?.envConfigRepairChanged?.(workspaceId, job)
  }
}

/** A next-step pointer per failure kind, surfaced on the infra window's failed indicator. */
const FAILURE_HINTS: Partial<Record<AgentFailureKind, string>> & { unknown: string } = {
  preflight:
    'The repair agent could not start (GitHub not connected, an unsupported model, or the provider does not support agent repair). Fix the cause, then retry.',
  dispatch:
    'The container could not be reached to start the repair. This is usually transient — retry.',
  evicted:
    'The container running the repair was evicted or crashed before completing. Retry to spin a fresh container.',
  timeout:
    'A container watchdog fired (no agent activity, or the max run duration was exceeded). Retry.',
  agent:
    'The repair agent, the git push, or the post-repair validation reported a failure. See the detail, then retry.',
  cancelled: 'You stopped this repair; its container was killed. Retry to start it again.',
  unknown: 'See the detail and the container logs, then retry.',
}
