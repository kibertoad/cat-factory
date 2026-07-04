import type {
  Block,
  Clock,
  CreateScheduleInput,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  Pipeline,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  Recurrence,
  ScheduleRun,
  ScheduleTemplate,
  ServiceRepository,
  UpdateScheduleInput,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  CredentialRequiredError,
  requireWorkspace,
  ValidationError,
} from '@cat-factory/kernel'
import type { IssueIntakeConfig } from '@cat-factory/contracts'
import type { TaskConnectionService } from '@cat-factory/integrations'
import type { ExecutionService } from '../execution/ExecutionService.js'
import {
  assertPipelineLaunchable,
  pipelineHasEnabledBugIntake,
} from '../pipelines/pipelineShape.js'
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
  /**
   * Resolves whether a task source is a connected/enabled source for the workspace, so a
   * `bug-intake` pipeline's schedule can be validated to carry an `issueIntake` config pointed at a
   * usable source. Absent (no task sources wired on this deployment) → only the presence check
   * runs (there is no connection registry to consult).
   */
  taskConnectionService?: TaskConnectionService
}

/**
 * A schedule can only carry a pipeline that is launchable on a recurring cadence: a
 * `'one-off'`-only pipeline (design §2) has no schedule semantics, so reject attaching it. A
 * `'recurring'` or `'both'` (or unset) pipeline is fine. This is the schedule-attach dual of the
 * `origin` gate {@link ExecutionService.start} applies at fire time — so it delegates to the SAME
 * {@link assertPipelineLaunchable} gate with `origin: 'recurring'`, keeping one rule and one error
 * type (`ValidationError`) across both boundaries instead of a divergent copy.
 */
function assertSchedulable(pipeline: Pipeline): void {
  assertPipelineLaunchable(
    pipeline.agentKinds,
    pipeline.availability,
    'recurring',
    pipeline.enabled,
  )
}

/**
 * The nominal recurrence stored for an on-demand schedule (it never drives a fire, but the
 * `recurrence` column is non-null). Also the fallback when a scheduled-create omits one.
 */
const DEFAULT_RECURRENCE: Recurrence = {
  intervalHours: 24,
  weekdays: [],
  windowStartHour: null,
  windowEndHour: null,
  timezone: 'UTC',
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
  private readonly taskConnectionService?: TaskConnectionService

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
    this.taskConnectionService = deps.taskConnectionService
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  /**
   * A `bug-intake` pipeline pulls its work from the schedule's tracker board, so attaching one
   * REQUIRES an `issueIntake` config whose source is a connected task source — otherwise every
   * fire would silently no-op. Validated at both launch boundaries (create / update). A pipeline
   * with no enabled `bug-intake` step imposes no requirement (an unrelated schedule may still
   * carry an `issueIntake` config harmlessly). When no task-connection service is wired (no task
   * sources on this deployment) the connected-source check is skipped; the presence check stands.
   */
  private async assertIntakeConfigured(
    workspaceId: string,
    pipeline: Pipeline,
    issueIntake: IssueIntakeConfig | undefined,
  ): Promise<void> {
    if (!pipelineHasEnabledBugIntake(pipeline.agentKinds, pipeline.enabled)) return
    if (!issueIntake) {
      throw new ValidationError(
        "A 'bug-intake' pipeline needs an issue-intake configuration (source, board and predicates) on its schedule.",
      )
    }
    if (
      this.taskConnectionService &&
      !(await this.taskConnectionService.isEnabled(workspaceId, issueIntake.source))
    ) {
      throw new ValidationError(
        `The '${issueIntake.source}' task source is not connected for this workspace — connect it before scheduling bug intake from it.`,
      )
    }
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
    // A document repository is authored, not implemented: it has no code-producing pipeline, so
    // a recurring schedule (always a code pipeline) can't run there. Reject rather than seed an
    // un-runnable block — mirrors BoardService.addTask's doc-repo gate for this second entry.
    if (frame.type === 'document') {
      throw new ConflictError('A document repository cannot host a recurring pipeline.')
    }
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, input.pipelineId),
      'Pipeline',
      input.pipelineId,
    )
    assertSchedulable(pipeline)
    await this.assertIntakeConfigured(workspaceId, pipeline, input.issueIntake)
    // A CADENCE schedule is defined by its cadence: reject a missing one (before any block is
    // materialised) rather than silently inventing a hidden every-24h/UTC schedule that fires
    // at a time the user never chose. Only an on-demand schedule may omit a recurrence.
    if (!input.onDemand && !input.recurrence) {
      throw new ConflictError('A cadence (non-on-demand) recurring pipeline requires a recurrence.')
    }

    // The owning service (in-org sharing): the schedule + its reused block belong to the
    // frame's service, so they render on — and are listed by — every workspace that mounts it.
    const serviceId = this.serviceRepository
      ? ((await this.serviceRepository.getByFrameBlock(frame.id))?.id ?? null)
      : null

    const now = this.clock.now()
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title: input.name,
      // Inherit the frame's (behavioural) repo type, like BoardService.addTask, instead of
      // hardcoding `service` — a schedule on a frontend/library frame stays correctly typed.
      type: frame.type,
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

    // An on-demand schedule carries a nominal (ignored) recurrence — it never auto-fires — so
    // the client need not send one. A scheduled one falls back to the same default if omitted.
    const recurrence = input.recurrence ?? DEFAULT_RECURRENCE
    const schedule: PipelineSchedule = {
      id: this.idGenerator.next('sch'),
      serviceId,
      blockId: block.id,
      frameId: frame.id,
      pipelineId: input.pipelineId,
      template: input.template,
      name: input.name,
      recurrence,
      onDemand: input.onDemand,
      // Issue-intake scope + predicates (persisted verbatim; Phase E's schedule
      // validation enforces presence + a connected source for a bug-intake pipeline).
      ...(input.issueIntake ? { issueIntake: input.issueIntake } : {}),
      enabled: input.enabled,
      lastRunAt: null,
      // First fire is one interval out, rolled into the allowed window. Stored even for an
      // on-demand schedule (the `onDemand` flag, not this value, keeps it out of `listDue`).
      nextRunAt: computeNextRun(now, recurrence),
      createdAt: now,
    }
    await this.schedules.upsert(workspaceId, schedule)
    return schedule
  }

  /** A single schedule by id (or throw NotFound). Used by the controller's run-now gate. */
  async get(workspaceId: string, id: string): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    return assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateScheduleInput,
  ): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    let changedPipeline: Pipeline | undefined
    if (patch.pipelineId !== undefined) {
      changedPipeline = assertFound(
        await this.pipelineRepository.get(workspaceId, patch.pipelineId),
        'Pipeline',
        patch.pipelineId,
      )
      assertSchedulable(changedPipeline)
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
    // `issueIntake` is a tri-state patch: omitted = unchanged (kept by `...existing`),
    // null = clear (drop the optional key), value = replace.
    if (patch.issueIntake !== undefined) {
      if (patch.issueIntake) updated.issueIntake = patch.issueIntake
      else delete updated.issueIntake
    }
    // Re-validate the intake requirement whenever the pipeline or the intake config changed, over
    // the EFFECTIVE pipeline (the patched one, else the existing schedule's) and the merged config
    // — so clearing `issueIntake` on a bug-intake schedule (or pointing it at a disconnected source)
    // is rejected up front rather than silently no-opping every future fire.
    if (patch.pipelineId !== undefined || patch.issueIntake !== undefined) {
      const effectivePipeline =
        changedPipeline ??
        assertFound(
          await this.pipelineRepository.get(workspaceId, existing.pipelineId),
          'Pipeline',
          existing.pipelineId,
        )
      await this.assertIntakeConfigured(workspaceId, effectivePipeline, updated.issueIntake)
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

  /**
   * Fire a schedule immediately (ignoring its cadence), if its block is free. A human is
   * present, so `initiatedBy` + `activate` (the server-supplied personal-credential gate)
   * are threaded into the run — letting an on-demand schedule use an individual-usage model.
   */
  async runNow(
    workspaceId: string,
    id: string,
    gate: {
      initiatedBy?: string | null
      activate?: (executionId: string) => Promise<void>
    } = {},
  ): Promise<PipelineSchedule> {
    await this.requireWorkspace(workspaceId)
    const schedule = assertFound(await this.schedules.get(workspaceId, id), 'Schedule', id)
    await this.fire(workspaceId, schedule, {
      force: true,
      initiatedBy: gate.initiatedBy,
      activate: gate.activate,
    })
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
    opts: {
      now?: number
      force?: boolean
      initiatedBy?: string | null
      activate?: (executionId: string) => Promise<void>
    } = {},
  ): Promise<boolean> {
    const now = opts.now ?? this.clock.now()

    // An on-demand schedule never fires unattended — only via `runNow` (force). Guard the
    // sweeper path defensively (it already skips them via `listDue`), so an on-demand
    // schedule can never be auto-started without an initiator present to unlock it.
    if (schedule.onDemand && !opts.force) return false

    // Individual-usage subscriptions (Claude) require their owner to be present to unlock
    // them per run, so they can never run on an unattended (cadence) schedule. Refuse to fire
    // and record a clear failure (the user must switch the block to an API-key or pooled
    // coding-plan model) rather than starting a run that would fault at dispatch. Resolve the
    // vendor set with the SAME precedence dispatch uses (block pin → workspace per-kind
    // default), via the engine, so a block with no pin but an individual-usage workspace
    // default is caught here too — not just an explicitly pinned one. An ON-DEMAND schedule is
    // exempt: a human triggers it, so the run-now controller unlocks the credential per run
    // (its `activate` closure) exactly like a manual start.
    if (!schedule.onDemand) {
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
              `cannot run on a cadence schedule. Make it on-demand, or pick an API-key or coding-plan model.`,
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
    }

    const prior = await this.executionRepository.getByBlock(workspaceId, schedule.blockId)
    if (prior && (prior.status === 'running' || prior.status === 'paused')) {
      if (opts.force) {
        throw new ConflictError('This recurring pipeline already has a run in progress.')
      }
      // Don't overlap; leave nextRunAt so the sweeper retries next pass.
      return false
    }
    // Persist the prior (now terminal) run's outcome before start()'s insertLive clears it.
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
        // Present for a run-now (the acting user); null for a sweeper fire. Records the
        // initiator + mints the per-run personal-credential activation for an on-demand
        // schedule's individual-usage model.
        opts.initiatedBy,
        opts.activate,
        // `origin: 'recurring'` gates the pipeline's launch availability — a one-off-only
        // pipeline can never be fired from a schedule (see assertPipelineLaunchable).
        'recurring',
      )
      executionId = instance.id
    } catch (error) {
      // A credential-required error (wrong/expired/missing personal password) is a re-promptable
      // gate condition, NOT a failed run: let it propagate so the run-now controller returns 428
      // and the client re-prompts + retries, exactly like a manual start. Swallowing it into a
      // failed history row would make run-now report 200 while nothing ran. Only reachable on the
      // run-now (`activate`) path — the sweeper supplies no `activate`, so it can't hit this.
      if (error instanceof CredentialRequiredError) throw error
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
