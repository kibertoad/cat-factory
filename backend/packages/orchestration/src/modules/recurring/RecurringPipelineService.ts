import type {
  Block,
  Clock,
  CreateScheduleInput,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  ScheduleRun,
  ScheduleTemplate,
  ServiceRepository,
  UpdateScheduleInput,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import { assertFound, ConflictError, requireWorkspace } from '@cat-factory/kernel'
import type { ExecutionService } from '../execution/ExecutionService.js'
import { computeNextRun } from './schedule.logic.js'

export interface RecurringPipelineServiceDependencies {
  pipelineScheduleRepository: PipelineScheduleRepository
  workspaceRepository: WorkspaceRepository
  pipelineRepository: PipelineRepository
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  executionService: ExecutionService
  idGenerator: IdGenerator
  clock: Clock
  /**
   * In-org shared services. When wired, a new schedule (and its reused on-board block) is
   * stamped with the frame's service, and {@link RecurringPipelineService.list} returns the
   * schedules of every service the workspace mounts — so a shared service's recurring
   * pipelines appear on every board that mounts it (and still fire once per org).
   */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
}

/** Default seed descriptions for the canned recurring templates. */
const TEMPLATE_DESCRIPTIONS: Record<ScheduleTemplate, string> = {
  'dep-update':
    'Recurring dependency-update pass: bring this service’s dependencies up to the latest compatible versions, update lockfiles, and make sure the build and tests still pass.',
  'tech-debt':
    'Recurring tech-debt remediation pass: analyse this service for the highest-value technical debt, file a tracking ticket, then implement the fix with tests.',
  custom: '',
}

/**
 * Manages a workspace's recurring pipelines. Each schedule owns one reused
 * on-board block (a task leaf inside the chosen service frame); the cron sweeper
 * calls {@link runDue} to fire every due schedule by starting its pipeline against
 * that block (skipping any whose block already has an active run), recording each
 * fire in the run-history table the inspector reads.
 */
export class RecurringPipelineService {
  private readonly schedules: PipelineScheduleRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly blockRepository: BlockRepository
  private readonly executionRepository: ExecutionRepository
  private readonly executionService: ExecutionService
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly serviceRepository?: ServiceRepository
  private readonly workspaceMountRepository?: WorkspaceMountRepository

  constructor(deps: RecurringPipelineServiceDependencies) {
    this.schedules = deps.pipelineScheduleRepository
    this.workspaceRepository = deps.workspaceRepository
    this.pipelineRepository = deps.pipelineRepository
    this.blockRepository = deps.blockRepository
    this.executionRepository = deps.executionRepository
    this.executionService = deps.executionService
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.serviceRepository = deps.serviceRepository
    this.workspaceMountRepository = deps.workspaceMountRepository
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  async list(workspaceId: string): Promise<PipelineSchedule[]> {
    await this.requireWorkspace(workspaceId)
    // The workspace's own schedules (including legacy/seeded frames with no service) UNION
    // the schedules of every service it mounts — so a shared service's schedules show on
    // every board that mounts it. Dedup by id.
    const seen = new Set<string>()
    const out: PipelineSchedule[] = []
    const add = (schedule: PipelineSchedule) => {
      if (!seen.has(schedule.id)) {
        seen.add(schedule.id)
        out.push(schedule)
      }
    }
    for (const schedule of await this.schedules.list(workspaceId)) add(schedule)
    if (this.workspaceMountRepository) {
      const mounts = await this.workspaceMountRepository.listByWorkspace(workspaceId)
      // One batched query for every mounted service's schedules (not one round-trip per mount).
      for (const schedule of await this.schedules.listByServices(mounts.map((m) => m.serviceId))) {
        add(schedule)
      }
    }
    return out
  }

  /**
   * Create a recurring pipeline on a service frame. Materialises the reused on-board
   * block (a task leaf inside the frame), computes the first `nextRunAt`, and
   * persists the schedule.
   */
  async create(workspaceId: string, input: CreateScheduleInput): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    const frame = assertFound(
      await this.blockRepository.get(workspaceId, input.frameId),
      'Block',
      input.frameId,
    )
    if (frame.level !== 'frame') {
      throw new ConflictError('Recurring pipelines can only be attached to a service frame.')
    }
    assertFound(
      await this.pipelineRepository.get(workspaceId, input.pipelineId),
      'Pipeline',
      input.pipelineId,
    )

    // The owning service (in-org sharing): the schedule + its reused block belong to the
    // frame's service, so they render on — and are listed by — every workspace that mounts it.
    const serviceId = this.serviceRepository
      ? ((await this.serviceRepository.getByFrameBlock(frame.id))?.id ?? null)
      : null

    const now = this.clock.now()
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title: input.name,
      type: 'service',
      // The user's own prompt when given, else the canned template seed.
      description: input.description?.trim() || TEMPLATE_DESCRIPTIONS[input.template] || '',
      position: { x: 24, y: 96 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: frame.id,
      // A recurring schedule's reused on-board block is a recurring-type task.
      taskType: 'recurring',
    }
    await this.blockRepository.insert(workspaceId, block, serviceId)

    const schedule: PipelineSchedule = {
      id: this.idGenerator.next('sch'),
      serviceId,
      blockId: block.id,
      frameId: frame.id,
      pipelineId: input.pipelineId,
      template: input.template,
      name: input.name,
      recurrence: input.recurrence,
      enabled: input.enabled,
      lastRunAt: null,
      // First fire is one interval out, rolled into the allowed window.
      nextRunAt: computeNextRun(now, input.recurrence),
      createdAt: now,
    }
    await this.schedules.upsert(workspaceId, schedule)
    return schedule
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateScheduleInput,
  ): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    if (patch.pipelineId !== undefined) {
      assertFound(
        await this.pipelineRepository.get(workspaceId, patch.pipelineId),
        'Pipeline',
        patch.pipelineId,
      )
    }
    const recurrence = patch.recurrence ?? existing.recurrence
    const updated: PipelineSchedule = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.pipelineId !== undefined ? { pipelineId: patch.pipelineId } : {}),
      ...(patch.recurrence !== undefined ? { recurrence } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      // Recomputing the next fire keeps a cadence change effective immediately.
      ...(patch.recurrence !== undefined
        ? { nextRunAt: computeNextRun(this.clock.now(), recurrence) }
        : {}),
    }
    await this.schedules.upsert(workspaceId, updated)
    if (patch.name !== undefined) {
      await this.blockRepository.update(workspaceId, existing.blockId, { title: patch.name })
    }
    return updated
  }

  /** Remove a schedule, its reused block, and its run history. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    await this.executionRepository.deleteByBlock(workspaceId, existing.blockId)
    await this.blockRepository.deleteMany(workspaceId, [existing.blockId])
    await this.schedules.remove(workspaceId, id)
  }

  /** A schedule's run history (most recent first), with live status overlaid. */
  async listRuns(workspaceId: string, id: string): Promise<ScheduleRun[]> {
    await this.requireWorkspace(workspaceId)
    const schedule = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    const runs = await this.schedules.listRuns(workspaceId, id)
    // The most recent run's execution usually still exists (it is only replaced on
    // the next fire); overlay its live status so the inspector reflects progress.
    const live = await this.executionRepository.getByBlock(workspaceId, schedule.blockId)
    if (!live) return runs
    return runs.map((run) =>
      run.executionId && run.executionId === live.id
        ? { ...run, ...this.deriveRunOutcome(live) }
        : run,
    )
  }

  /** Fire a schedule immediately (ignoring its cadence), if its block is free. */
  async runNow(workspaceId: string, id: string): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    const schedule = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    await this.fire(workspaceId, schedule, { force: true })
    return assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
  }

  /**
   * Fire every due schedule across all workspaces. The cron/interval sweepers call
   * this; it skips any schedule whose block already has an active run. Returns the
   * number of runs started (for logging).
   */
  async runDue(now: number): Promise<{ fired: number; skipped: number }> {
    const due = await this.schedules.listDue(now)
    let fired = 0
    let skipped = 0
    for (const { workspaceId, schedule } of due) {
      const started = await this.fire(workspaceId, schedule, { now })
      if (started) fired++
      else skipped++
    }
    return { fired, skipped }
  }

  /**
   * Start a schedule's pipeline against its reused block. Finalises the prior run's
   * history row (its execution is about to be replaced), records a new running row,
   * and advances `lastRunAt`/`nextRunAt`. Returns false (without starting) when the
   * block already has an active run.
   */
  private async fire(
    workspaceId: string,
    schedule: PipelineSchedule,
    opts: { now?: number; force?: boolean } = {},
  ): Promise<boolean> {
    const now = opts.now ?? this.clock.now()

    // Individual-usage subscriptions (Claude) require their owner to be present to unlock
    // them per run, so they can never run on an unattended schedule. Refuse to fire and
    // record a clear failure (the user must switch the block to an API-key or pooled
    // coding-plan model) rather than starting a run that would fault at dispatch. Resolve
    // the vendor set with the SAME precedence dispatch uses (block pin → workspace per-kind
    // default), via the engine, so a block with no pin but an individual-usage workspace
    // default is caught here too — not just an explicitly pinned one.
    const scheduledBlock = await this.blockRepository.get(workspaceId, schedule.blockId)
    const individualVendor = scheduledBlock
      ? ((
          await this.executionService.individualVendorsForBlock(
            workspaceId,
            schedule.blockId,
            schedule.pipelineId,
          )
        )[0] ?? null)
      : null
    if (individualVendor) {
      if (opts.force) {
        throw new ConflictError(
          `This recurring pipeline targets an individual-usage ${individualVendor} model, which ` +
            `cannot run on a schedule. Pick an API-key or coding-plan model.`,
        )
      }
      await this.schedules.insertRun(workspaceId, {
        id: this.idGenerator.next('schr'),
        scheduleId: schedule.id,
        executionId: null,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        outcome: `Individual-usage ${individualVendor} models cannot run on a recurring schedule.`,
      })
      await this.advanceCadence(workspaceId, schedule, now)
      return false
    }

    const prior = await this.executionRepository.getByBlock(workspaceId, schedule.blockId)
    if (prior && (prior.status === 'running' || prior.status === 'paused')) {
      if (opts.force) {
        throw new ConflictError('This recurring pipeline already has a run in progress.')
      }
      // Don't overlap; leave nextRunAt so the sweeper retries next pass.
      return false
    }
    // Persist the prior (now terminal) run's outcome before start() deletes it.
    if (prior) {
      const runs = await this.schedules.listRuns(workspaceId, schedule.id)
      const priorRun = runs.find((r) => r.executionId === prior.id)
      if (priorRun) {
        await this.schedules.updateRun(workspaceId, priorRun.id, this.deriveRunOutcome(prior))
      }
    }

    let executionId: string | null = null
    try {
      const instance = await this.executionService.start(
        workspaceId,
        schedule.blockId,
        schedule.pipelineId,
      )
      executionId = instance.id
    } catch (error) {
      // Record the failed fire so the history shows it, then advance the cadence.
      await this.schedules.insertRun(workspaceId, {
        id: this.idGenerator.next('schr'),
        scheduleId: schedule.id,
        executionId: null,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        outcome: error instanceof Error ? error.message : 'Failed to start run.',
      })
      await this.advanceCadence(workspaceId, schedule, now)
      return false
    }

    await this.schedules.insertRun(workspaceId, {
      id: this.idGenerator.next('schr'),
      scheduleId: schedule.id,
      executionId,
      status: 'running',
      startedAt: now,
      finishedAt: null,
      outcome: null,
    })
    await this.advanceCadence(workspaceId, schedule, now)
    return true
  }

  private async advanceCadence(
    workspaceId: string,
    schedule: PipelineSchedule,
    now: number,
  ): Promise<void> {
    await this.schedules.upsert(workspaceId, {
      ...schedule,
      lastRunAt: now,
      nextRunAt: computeNextRun(now, schedule.recurrence),
    })
  }

  /** Map an execution's state to a history-row status + short outcome. */
  private deriveRunOutcome(
    instance: ExecutionInstance,
  ): Pick<ScheduleRun, 'status' | 'finishedAt' | 'outcome'> {
    if (instance.status === 'done') {
      return { status: 'done', finishedAt: this.clock.now(), outcome: 'completed' }
    }
    if (instance.status === 'failed') {
      return {
        status: 'failed',
        finishedAt: this.clock.now(),
        outcome: instance.failure?.message ?? 'failed',
      }
    }
    return { status: 'running', finishedAt: null, outcome: null }
  }
}
