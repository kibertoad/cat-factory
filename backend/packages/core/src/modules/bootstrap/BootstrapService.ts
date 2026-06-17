import type {
  Block,
  BlockType,
  BootstrapFailure,
  BootstrapFailureKind,
  BootstrapJob,
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  ReferenceArchitecture,
  StepSubtasks,
  UpdateReferenceArchitectureInput,
} from '../../domain/types'
import type { Clock, IdGenerator } from '../../ports/runtime'
import type { BlockRepository, WorkspaceRepository } from '../../ports/repositories'
import type {
  BootstrapJobRecord,
  BootstrapJobRepository,
  ReferenceArchitectureRecord,
  ReferenceArchitectureRepository,
} from '../../ports/bootstrap-repositories'
import type { RepoBootstrapper } from '../../ports/repo-bootstrapper'
import type { BootstrapRunner } from '../../ports/bootstrap-runner'
import type { ExecutionEventPublisher } from '../../ports/execution-events'
import { assertFound, ConflictError } from '../../domain/errors'
import { requireWorkspace } from '../workspaces/WorkspaceService'

/** The poll's terminal-ness, returned to the durable driver so it knows when to stop. */
export interface BootstrapPollResult {
  state: 'running' | 'done' | 'failed'
  /** Present when `state === 'failed'`. */
  error?: string
}

// ---------------------------------------------------------------------------
// BootstrapService: owns the managed list of reference architectures and the
// "bootstrap repo" task. CRUD over reference architectures always works; running
// a bootstrap additionally needs the RepoBootstrapper port (the GitHub + sandbox
// container machinery) to be wired — when it is absent, `canBootstrap` is false
// and callers should surface "unavailable" rather than attempt a run.
// ---------------------------------------------------------------------------

export interface BootstrapServiceDependencies {
  referenceArchitectureRepository: ReferenceArchitectureRepository
  bootstrapJobRepository: BootstrapJobRepository
  workspaceRepository: WorkspaceRepository
  /** Board blocks: a bootstrap materialises a provisional service frame up front. */
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Performs the side-effecting pre-flight + container bootstrap; optional. */
  repoBootstrapper?: RepoBootstrapper
  /** Durably drives the run's poll loop; optional (tests poll directly). */
  bootstrapRunner?: BootstrapRunner
  /** Pushes live bootstrap progress / board changes to subscribed clients. */
  eventPublisher?: ExecutionEventPublisher
}

function toReferenceArchitecture(record: ReferenceArchitectureRecord): ReferenceArchitecture {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    defaultInstructions: record.defaultInstructions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toBootstrapJob(record: BootstrapJobRecord): BootstrapJob {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    referenceArchitectureId: record.referenceArchitectureId,
    referenceArchitectureName: record.referenceArchitectureName,
    repoName: record.repoName,
    repoOwner: record.repoOwner,
    repoUrl: record.repoUrl,
    instructions: record.instructions,
    status: record.status,
    blockId: record.blockId,
    subtasks: record.subtasks,
    error: record.error,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Join the reference architecture's default instructions with per-run extras. */
function composeInstructions(defaults: string, extra: string): string {
  return [defaults.trim(), extra.trim()].filter((part) => part.length > 0).join('\n\n')
}

export class BootstrapService {
  constructor(private readonly deps: BootstrapServiceDependencies) {}

  /** True when a bootstrap run can actually be performed (the bootstrapper is wired). */
  get canBootstrap(): boolean {
    return this.deps.repoBootstrapper !== undefined
  }

  // ---- reference architecture management ----------------------------------

  async listReferenceArchitectures(workspaceId: string): Promise<ReferenceArchitecture[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const records = await this.deps.referenceArchitectureRepository.listByWorkspace(workspaceId)
    return records.map(toReferenceArchitecture)
  }

  async createReferenceArchitecture(
    workspaceId: string,
    input: CreateReferenceArchitectureInput,
  ): Promise<ReferenceArchitecture> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const now = this.deps.clock.now()
    const record: ReferenceArchitectureRecord = {
      id: this.deps.idGenerator.next('refarch'),
      workspaceId,
      name: input.name,
      description: input.description,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      defaultInstructions: input.defaultInstructions,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.referenceArchitectureRepository.insert(record)
    return toReferenceArchitecture(record)
  }

  async updateReferenceArchitecture(
    workspaceId: string,
    id: string,
    input: UpdateReferenceArchitectureInput,
  ): Promise<ReferenceArchitecture> {
    const existing = assertFound(
      await this.deps.referenceArchitectureRepository.get(workspaceId, id),
      'Reference architecture',
      id,
    )
    await this.deps.referenceArchitectureRepository.update(workspaceId, id, {
      ...input,
      updatedAt: this.deps.clock.now(),
    })
    return toReferenceArchitecture({ ...existing, ...input, updatedAt: this.deps.clock.now() })
  }

  async deleteReferenceArchitecture(workspaceId: string, id: string): Promise<void> {
    assertFound(
      await this.deps.referenceArchitectureRepository.get(workspaceId, id),
      'Reference architecture',
      id,
    )
    await this.deps.referenceArchitectureRepository.softDelete(
      workspaceId,
      id,
      this.deps.clock.now(),
    )
  }

  // ---- bootstrap jobs -----------------------------------------------------

  async listJobs(workspaceId: string): Promise<BootstrapJob[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const records = await this.deps.bootstrapJobRepository.listByWorkspace(workspaceId)
    return records.map(toBootstrapJob)
  }

  async getJob(workspaceId: string, id: string): Promise<BootstrapJob> {
    return toBootstrapJob(
      assertFound(await this.deps.bootstrapJobRepository.get(workspaceId, id), 'Bootstrap job', id),
    )
  }

  /**
   * Kick off a "bootstrap repo" run and return immediately with the `running`
   * job. The run is asynchronous and observable: it pre-flights GitHub + the
   * target repo, dispatches the bootstrapper container, materialises a provisional
   * **service frame** on the board (so the user sees a "bootstrapping…" card right
   * away), then asks the durable runner to drive the poll loop — which streams
   * live subtask progress and, on success, links the new repo to the frame so it
   * becomes a real, droppable service. On a dispatch/pre-flight failure the job is
   * returned already `failed` (no frame is left behind). Requires {@link canBootstrap}.
   */
  async bootstrap(workspaceId: string, input: BootstrapRepoInput): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) {
      throw new Error('Repository bootstrapping is not configured')
    }

    // Pre-flight: a bootstrap run creates and pushes to a GitHub repo, so the
    // workspace must be connected to GitHub first. Check before recording any job
    // so an unconnected workspace fails fast with a clear 409 instead of leaving a
    // job that immediately fails deep inside the container run.
    if (!(await bootstrapper.isWorkspaceConnected(workspaceId))) {
      throw new ConflictError(
        'Workspace is not connected to GitHub. Install the GitHub App for this workspace before bootstrapping a repository.',
      )
    }

    // A reference architecture is optional: when supplied the run clones and adapts
    // its base repo; when omitted the run scaffolds a new repo from the freeform
    // instructions alone. The contract guarantees at least one is present.
    const reference = input.referenceArchitectureId
      ? assertFound(
          await this.deps.referenceArchitectureRepository.get(
            workspaceId,
            input.referenceArchitectureId,
          ),
          'Reference architecture',
          input.referenceArchitectureId,
        )
      : null

    const instructions = composeInstructions(
      reference?.defaultInstructions ?? '',
      input.instructions,
    )
    const now = this.deps.clock.now()
    const record: BootstrapJobRecord = {
      id: this.deps.idGenerator.next('boot'),
      workspaceId,
      referenceArchitectureId: reference?.id ?? null,
      referenceArchitectureName: reference?.name ?? null,
      repoName: input.repoName,
      repoOwner: null,
      repoUrl: null,
      instructions,
      status: 'running',
      blockId: null,
      subtasks: null,
      error: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.bootstrapJobRepository.insert(record)

    // Dispatch the container first: its pre-flight (target exists, reachable,
    // empty-or-boilerplate) is the gate that most runs fail on, so failing here
    // before creating a board frame keeps the board clean on the common errors.
    try {
      await bootstrapper.startBootstrap({
        workspaceId,
        jobId: record.id,
        referenceRepo: reference
          ? { owner: reference.repoOwner, name: reference.repoName }
          : undefined,
        target: {
          name: input.repoName,
          description: input.description,
          private: input.private,
        },
        instructions,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A dispatch HTTP/network fault is `dispatch`; everything else here is a
      // pre-flight rejection (repo missing / not empty / not connected).
      const kind: BootstrapFailureKind = /dispatch failed/i.test(message) ? 'dispatch' : 'preflight'
      const failure = this.buildFailure(kind, message, null, null)
      const patch = {
        status: 'failed' as const,
        error: message,
        failure,
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
      // A failed dispatch may still have spun a container up; reclaim it best-effort.
      await this.stopContainer(workspaceId, record.id)
      const failed = toBootstrapJob({ ...record, ...patch })
      await this.emitBootstrap(workspaceId, failed, null)
      return failed
    }

    // Accepted: materialise the provisional service frame and record it on the job
    // so the board shows a live "bootstrapping…" card the poll loop then updates.
    const frame = await this.createServiceFrame(workspaceId, input.repoName)
    const started = { blockId: frame.id, updatedAt: this.deps.clock.now() }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, started)
    const job = toBootstrapJob({ ...record, ...started })

    // Hand off the long poll loop to the durable driver (the worker's
    // BootstrapWorkflow). Without a runner (tests) the caller polls directly.
    await this.deps.bootstrapRunner?.startRun(workspaceId, record.id)
    await this.emitBootstrap(workspaceId, job, frame)
    return job
  }

  /**
   * Retry a failed "bootstrap repo" run. Spins a **fresh** container (and a new
   * durable driver instance) for the same target, reusing the original job's
   * service frame so the board card stays put — it flips from the failed badge
   * back to "bootstrapping…". A new job record is created (the prior one is kept as
   * history and so the durable driver, keyed by job id, gets a clean instance).
   * Only a `failed` job can be retried. Returns the new running job.
   */
  async retry(workspaceId: string, jobId: string): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) throw new Error('Repository bootstrapping is not configured')

    const previous = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(
        `Only a failed bootstrap can be retried (job is '${previous.status}').`,
      )
    }

    // The original job stored only the reference architecture id, so re-resolve the
    // base repo to clone. If the architecture was since deleted there's nothing to
    // clone from — fail clearly rather than silently scaffolding from scratch.
    let referenceRepo: { owner: string; name: string } | undefined
    if (previous.referenceArchitectureId) {
      const reference = await this.deps.referenceArchitectureRepository.get(
        workspaceId,
        previous.referenceArchitectureId,
      )
      if (!reference) {
        throw new ConflictError(
          `The reference architecture this run was based on no longer exists; recreate it or start a new bootstrap.`,
        )
      }
      referenceRepo = { owner: reference.repoOwner, name: reference.repoName }
    }

    const now = this.deps.clock.now()
    const record: BootstrapJobRecord = {
      id: this.deps.idGenerator.next('boot'),
      workspaceId,
      referenceArchitectureId: previous.referenceArchitectureId,
      referenceArchitectureName: previous.referenceArchitectureName,
      repoName: previous.repoName,
      repoOwner: null,
      repoUrl: null,
      // `instructions` is already the composed brief from the original run — reuse
      // it verbatim (don't re-compose, which would double the reference defaults).
      instructions: previous.instructions,
      status: 'running',
      blockId: null,
      subtasks: null,
      error: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.bootstrapJobRepository.insert(record)

    // Dispatch a fresh container under the new job id (description/private aren't
    // forwarded — the target repo already exists — so defaults are harmless).
    try {
      await bootstrapper.startBootstrap({
        workspaceId,
        jobId: record.id,
        referenceRepo,
        target: { name: record.repoName, description: '', private: true },
        instructions: record.instructions,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const kind: BootstrapFailureKind = /dispatch failed/i.test(message) ? 'dispatch' : 'preflight'
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure(kind, message, null, null),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
      await this.stopContainer(workspaceId, record.id)
      // Re-mark the reused frame blocked (it briefly belonged to this attempt).
      const block = previous.blockId
        ? await this.markFrame(
            workspaceId,
            previous.blockId,
            'blocked',
            `Bootstrap failed: ${message}`,
          )
        : null
      const failed = toBootstrapJob({ ...record, blockId: previous.blockId, ...patch })
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, {
        blockId: previous.blockId,
      })
      await this.emitBootstrap(workspaceId, failed, block)
      return failed
    }

    // Accepted: reuse the original frame (flip it back to in-progress) so the card
    // stays in place; if the prior run never made one, materialise a fresh frame.
    const frame = previous.blockId
      ? await this.markFrame(
          workspaceId,
          previous.blockId,
          'in_progress',
          'Bootstrapping repository… retrying after a failed run.',
        )
      : await this.createServiceFrame(workspaceId, record.repoName)
    const blockId = frame?.id ?? previous.blockId
    const started = { blockId, updatedAt: this.deps.clock.now() }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, started)
    const job = toBootstrapJob({ ...record, ...started })

    await this.deps.bootstrapRunner?.startRun(workspaceId, record.id)
    await this.emitBootstrap(workspaceId, job, frame)
    return job
  }

  /**
   * Advance one running bootstrap job by polling its container once: stream the
   * latest subtask counts while it runs, and on a terminal outcome finalise the
   * job and its board frame (link the repo + flip to a ready service on success,
   * mark blocked on failure). Idempotent — a job already in a terminal state is
   * returned as-is, so the durable driver's retries/replays are safe. Returns the
   * poll's terminal-ness so the driver knows when to stop.
   */
  async pollBootstrapJob(workspaceId: string, jobId: string): Promise<BootstrapPollResult> {
    const record = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
    )
    if (record.status === 'succeeded') return { state: 'done' }
    if (record.status === 'failed') return { state: 'failed', error: record.error ?? undefined }

    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) throw new Error('Repository bootstrapping is not configured')

    const update = await bootstrapper.pollBootstrap({ workspaceId, jobId })

    if (update.state === 'running') {
      // Only persist + push when the counts actually changed, to avoid a write +
      // broadcast on every idle poll.
      if (update.subtasks && !sameSubtasks(record.subtasks, update.subtasks)) {
        const patch = { subtasks: update.subtasks, updatedAt: this.deps.clock.now() }
        await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
        await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), null)
      }
      return { state: 'running' }
    }

    if (update.state === 'failed') {
      const message = update.error ?? 'Bootstrap failed'
      const failure = this.buildFailure(
        update.failureKind ?? 'unknown',
        message,
        update.detail ?? null,
        record.subtasks,
      )
      const patch = {
        status: 'failed' as const,
        error: message,
        failure,
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
      // Reclaim the per-run container so a faulted/leaked instance doesn't idle
      // until its sleep timer (best-effort; an evicted container is already gone).
      await this.stopContainer(workspaceId, jobId)
      const block = await this.markFrame(
        workspaceId,
        record.blockId,
        'blocked',
        `Bootstrap failed: ${message}`,
      )
      await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
      return { state: 'failed', error: message }
    }

    // Done: record the repo, link it to the frame (so dropped tasks target it),
    // and flip the frame to a ready, droppable service.
    const outcome = update.outcome
    if (!outcome) throw new Error('Bootstrap reported done without an outcome')
    const patch = {
      status: 'succeeded' as const,
      repoOwner: outcome.owner,
      repoUrl: outcome.repoUrl,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
    if (record.blockId) {
      // Best-effort: a failure to link must not flip a successful run to failed —
      // the repo is bootstrapped; the projection reconciles on the next sync.
      try {
        await bootstrapper.linkRepoToBlock(workspaceId, outcome, record.blockId)
      } catch {
        // swallow — see above
      }
    }
    const block = await this.markFrame(
      workspaceId,
      record.blockId,
      'ready',
      `Service bootstrapped from ${outcome.owner}/${outcome.name}. Drop tasks here to implement against it.`,
    )
    await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
    await this.deps.eventPublisher?.boardChanged(workspaceId, 'bootstrap-succeeded')
    return { state: 'done' }
  }

  // ---- helpers ------------------------------------------------------------

  /** Create the provisional, in-progress service frame a bootstrap run materialises. */
  private async createServiceFrame(workspaceId: string, repoName: string): Promise<Block> {
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const frames = blocks.filter((b) => b.level === 'frame').length
    const type: BlockType = 'service'
    const block: Block = {
      id: this.deps.idGenerator.next('blk'),
      title: repoName,
      type,
      description:
        'Bootstrapping repository… a container is adapting and pushing the initial commit.',
      // Stagger so a fresh frame doesn't land exactly on an existing one.
      position: { x: 80 + (frames % 5) * 48, y: 80 + (frames % 5) * 48 },
      status: 'in_progress',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
    await this.deps.blockRepository.insert(workspaceId, block)
    return block
  }

  /** Flip a bootstrap's frame to a terminal status + description; null-safe. */
  private async markFrame(
    workspaceId: string,
    blockId: string | null,
    status: Block['status'],
    description: string,
  ): Promise<Block | null> {
    if (!blockId) return null
    const existing = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!existing) return null
    const progress = status === 'ready' ? 1 : existing.progress
    await this.deps.blockRepository.update(workspaceId, blockId, { status, description, progress })
    return { ...existing, status, description, progress }
  }

  /** Assemble the structured failure diagnostics stored on a faulted job. */
  private buildFailure(
    kind: BootstrapFailureKind,
    message: string,
    detail: string | null,
    lastSubtasks: StepSubtasks | null,
  ): BootstrapFailure {
    return {
      kind,
      message,
      detail,
      hint: FAILURE_HINTS[kind],
      occurredAt: this.deps.clock.now(),
      lastSubtasks: lastSubtasks ?? null,
    }
  }

  /** Best-effort: reclaim a job's per-run container (never throws). */
  private async stopContainer(workspaceId: string, jobId: string): Promise<void> {
    try {
      await this.deps.repoBootstrapper?.stopBootstrap({ workspaceId, jobId })
    } catch {
      // The container may already be gone (the common case for an eviction); the
      // job is already recorded failed, so a stop failure changes nothing.
    }
  }

  /** Best-effort push of a bootstrap transition to subscribed clients. */
  private async emitBootstrap(
    workspaceId: string,
    job: BootstrapJob,
    block: Block | null,
  ): Promise<void> {
    await this.deps.eventPublisher?.bootstrapChanged?.(workspaceId, job, block)
  }
}

/** Whether two subtask snapshots are identical (skip a no-op write + broadcast). */
function sameSubtasks(a: StepSubtasks | null, b: StepSubtasks): boolean {
  return (
    !!a &&
    a.completed === b.completed &&
    a.inProgress === b.inProgress &&
    a.total === b.total &&
    sameSubtaskItems(a.items, b.items)
  )
}

/** Whether two todo-item lists carry the same labels + statuses, in order. */
function sameSubtaskItems(
  a: StepSubtasks['items'],
  b: StepSubtasks['items'],
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((it, i) => it.label === b[i]?.label && it.status === b[i]?.status)
}

/** A next-step pointer per failure kind, surfaced on the board's failed card. */
const FAILURE_HINTS: Record<BootstrapFailureKind, string> = {
  preflight:
    'Check the target repository exists under the connected account, is empty (or holds only README/.gitignore/license/AGENTS.md), and that the GitHub App is installed on it. Then retry.',
  dispatch:
    'The container could not be reached to start the job. This is usually transient — retry. If it persists, check the Worker logs in the Cloudflare dashboard.',
  evicted:
    'The container that was running this job no longer has it — it was evicted, restarted, or crashed before completing. Inspect its stdout/stderr in the Cloudflare dashboard (Workers Observability → container logs, filtered by this job id), then retry to spin a fresh container.',
  timeout:
    'A container watchdog fired (no agent activity, or the max run duration was exceeded). Check the container logs for where it stalled, then retry.',
  agent:
    'The bootstrapper agent or the git push reported a failure. See the detail below and the container logs, fix the cause if needed, then retry.',
  unknown: 'See the detail below and the container logs in the Cloudflare dashboard, then retry.',
}
