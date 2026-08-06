import type {
  Block,
  Clock,
  CreateScheduleInput,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  Logger,
  Pipeline,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  Recurrence,
  ScheduleRun,
  ScheduleTemplate,
  ServiceRepository,
  TaskSourceKind,
  TrackerIssueEvent,
  UpdateScheduleInput,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  CredentialRequiredError,
  getErrorMessage,
  noopLogger,
  requireWorkspace,
  ValidationError,
} from '@cat-factory/kernel'
import type { IntakeOrigin, IssueIntakeConfig } from '@cat-factory/contracts'
import { judgeIssueEventForIntake, type TaskConnectionService } from '@cat-factory/integrations'
import type { ExecutionService } from '../execution/ExecutionService.js'
import {
  assertPipelineLaunchable,
  pipelineHasEnabledBugIntake,
} from '../pipelines/pipelineShape.js'
import { assertValidIssueIntake, dispatchAdmits, dispatchOf } from './issueIntake.logic.js'
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
  /**
   * Pushes a coarse `boardChanged` when a schedule's reused on-board block is created, so the new
   * recurring task appears live on every open board (and every board mounting a shared service)
   * without a reload — exactly like {@link BoardService.addTask}. Best-effort; the REST response
   * already carried the created schedule, so an emit failure never fails the create.
   */
  executionEventPublisher?: ExecutionEventPublisher
  /**
   * Structural log sink for the paths that deliberately swallow a failure. Today that is
   * {@link RecurringPipelineService.triggerForIssueEvent}, whose per-schedule isolation would
   * otherwise leave a webhook-fired schedule failing with NO trace anywhere — the operator sees
   * only "push intake never happens". Absent ⇒ those paths stay silent, as they were.
   */
  logger?: Logger
  /**
   * PER-TICKET dispatch: import a pushed tracker issue and materialise it as its own task inside
   * `containerId`, resolving to the created block — or to `null` when the issue is ALREADY linked
   * to a block, which is how a redelivery is recognised.
   *
   * Declared structurally and bound at the composition root (to `TaskImportService` +
   * `TaskLinkService`) rather than imported, for the layering reason `TrackerWebhookService`
   * states about its own gateway: it keeps the import/link behaviour in the ONE place that owns
   * it, so a per-ticket dispatch and a human's "create task from issue" cannot drift.
   *
   * Absent ⇒ a per-ticket config cannot dispatch and says so in the log; the queue mode is
   * unaffected, so a deployment with no task sources is byte-for-byte unchanged.
   */
  adoptIssueAsTask?: (input: {
    workspaceId: string
    source: TaskSourceKind
    externalId: string
    containerId: string
    pipelineId: string
  }) => Promise<{ blockId: string } | null>
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
  'bug-triage':
    'Recurring bug-triage pass: pull one open bug from the configured tracker board, investigate it across the involved services, write a failing reproduction test, fix the reported issue, and drive the fix through review, testing and merge. WHICH board and which bugs qualify is set in this schedule’s issue-intake configuration.',
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
  private readonly events?: ExecutionEventPublisher
  private readonly log: Logger
  private readonly adoptIssueAsTask?: RecurringPipelineServiceDependencies['adoptIssueAsTask']

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
    this.events = deps.executionEventPublisher
    this.log = deps.logger ?? noopLogger
    this.adoptIssueAsTask = deps.adoptIssueAsTask
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
    onDemand: boolean,
  ): Promise<void> {
    const hasBugIntakeStep = pipelineHasEnabledBugIntake(pipeline.agentKinds, pipeline.enabled)
    if (hasBugIntakeStep && !issueIntake) {
      throw new ValidationError(
        "A 'bug-intake' pipeline needs an issue-intake configuration (source, board and predicates) on its schedule.",
      )
    }
    // Nothing to validate when the schedule carries no intake config and its pipeline needs none.
    if (!issueIntake) return

    assertValidIssueIntake({ config: issueIntake, onDemand, hasBugIntakeStep })

    // The connected-source check applies exactly when something will actually READ the config: a
    // `bug-intake` step searching the board, or a per-ticket dispatch importing the pushed ticket.
    // A `queue` config on a pipeline with no intake step is inert by design (an unrelated schedule
    // may carry one harmlessly), and refusing THAT would reject a save for a source the schedule
    // never touches.
    //
    // `isOffered` (available AND enabled), NOT `isEnabled`: the toggle defaults ON for a
    // never-connected source (no settings row), so `isEnabled` would wave through a source that
    // has no connection to search — the exact silent-no-op this guard exists to reject.
    const configIsRead = hasBugIntakeStep || dispatchOf(issueIntake) === 'per-ticket'
    if (
      configIsRead &&
      this.taskConnectionService &&
      !(await this.taskConnectionService.isOffered(workspaceId, issueIntake.source))
    ) {
      throw new ValidationError(
        `The '${issueIntake.source}' task source is not connected for this workspace — connect it before scheduling issue intake from it.`,
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
    await this.assertIntakeConfigured(workspaceId, pipeline, input.issueIntake, input.onDemand)
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
    // Push the new reused block live so it appears on every open board without a reload —
    // like every other block creation (BoardService.addTask). Best-effort: the schedule is
    // already persisted, so an event-bus hiccup must not fail the create.
    try {
      await this.events?.boardChanged(workspaceId, { reason: 'block-added', block })
    } catch {
      // best-effort; the REST response already carried the created schedule + block
    }

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
    //
    // `onDemand` needs no place in this condition: it is fixed at create time (there is no patch
    // field for it), so the per-ticket rule that depends on it cannot be invalidated by an update.
    if (patch.pipelineId !== undefined || patch.issueIntake !== undefined) {
      const effectivePipeline =
        changedPipeline ??
        assertFound(
          await this.pipelineRepository.get(workspaceId, existing.pipelineId),
          'Pipeline',
          existing.pipelineId,
        )
      await this.assertIntakeConfigured(
        workspaceId,
        effectivePipeline,
        updated.issueIntake,
        updated.onDemand,
      )
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
      // `ui`, not `schedule`: run-now is a person in the app pressing the button, and their
      // clarification surface is the one they are already looking at.
      intakeOrigin: 'ui',
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
      const started = await this.fire(workspaceId, schedule, { now, intakeOrigin: 'schedule' })
      if (started) fired++
      else skipped++
    }
    return { fired, skipped }
  }

  /**
   * A tracker pushed an issue event: fire every ENABLED schedule in the workspace whose
   * issue-intake configuration that event plausibly qualifies for. Returns how many started.
   *
   * This is the whole of push-driven intake (D3 + D8 of
   * `backend/docs/adr/0032-tracker-webhook-intake.md`), and what a qualifying event DOES depends on the
   * schedule's dispatch mode:
   *
   *  - **`queue`** (the default, and every pre-existing schedule) imports nothing and links
   *    nothing: {@link fire} runs the schedule's reused block and the `bug-intake` step does all of
   *    it through the unchanged `BugIntakeService`, so there is exactly ONE intake implementation
   *    and a pushed pickup is byte-for-byte a cadence pickup that happened sooner. The run may
   *    legitimately pick a DIFFERENT, older issue than the one that triggered it: intake is
   *    oldest-first fair queueing, and the webhook's job is to drain the queue promptly, not
   *    reorder it.
   *  - **`per-ticket`** dispatches the pushed ticket itself ({@link firePerTicket}), which DOES
   *    import and link.
   *
   * Neither path is FORCED. `force` is the human run-now lever (it throws on overlap and bypasses
   * the on-demand guard) and a webhook has no human present to unlock a personal credential, which
   * is exactly the situation the unattended-fire guards exist for. So a burst of deliveries cannot
   * start a second run over one already running or parked (`fire` returns false and leaves
   * `nextRunAt` for the sweeper), and an individual-usage model still refuses on BOTH paths.
   *
   * The on-demand guard reads differently per mode, and deliberately so. `fire` refuses an
   * on-demand schedule outright, so a queue schedule is never webhook-fired unattended. A
   * per-ticket schedule is REQUIRED to be on-demand (it has no cadence to be driven by), so
   * `firePerTicket` does not consult that guard and applies the individual-usage check itself,
   * against the block it just created rather than a reused one.
   *
   * ONE schedule read for the workspace, filtered in memory — never a point-read per schedule.
   */
  async triggerForIssueEvent(workspaceId: string, event: TrackerIssueEvent): Promise<number> {
    const schedules = await this.schedules.list(workspaceId)
    const now = this.clock.now()
    let fired = 0
    for (const schedule of schedules) {
      if (!schedule.enabled || !schedule.issueIntake) continue
      const dispatch = dispatchOf(schedule.issueIntake)
      const verdict = judgeIssueEventForIntake(schedule.issueIntake, event)
      if (!dispatchAdmits(verdict, dispatch)) {
        // A withheld PER-TICKET dispatch is REPORTED, never merely skipped. A per-ticket schedule
        // is on-demand, so no cadence sweep will pick the ticket up later: "the delivery could not
        // confirm the labels you scoped on" and "no delivery ever arrived" are opposite facts with
        // the same silence, and only this line tells them apart. A `miss` needs no line: that is
        // the predicate doing its job on an unrelated issue, which is most of the traffic.
        if (dispatch === 'per-ticket' && verdict.outcome === 'unconfirmed') {
          this.log.warn(
            'per-ticket dispatch withheld: the delivery could not confirm a predicate',
            {
              workspaceId,
              scheduleId: schedule.id,
              source: event.source,
              externalId: event.externalId,
              unconfirmed: verdict.predicates.join(','),
            },
          )
        }
        continue
      }
      // Best-effort per schedule: one schedule whose pipeline fails to start (a disconnected
      // source, a missing model) must not stop the others — the same isolation `runDue` gets from
      // `fire`'s own internal error handling, extended to the errors it deliberately rethrows.
      try {
        const started =
          dispatch === 'per-ticket'
            ? await this.firePerTicket(workspaceId, schedule, event, now)
            : // `schedule`, the same as a cadence tick: the push only made the tick happen
              // sooner, and the run it starts is identical (ADR 0032). The queue mode's reused
              // block re-points its ticket link on every fire, so it is deliberately NOT
              // classified headless (see `HEADLESS_INTAKE`).
              await this.fire(workspaceId, schedule, { now, intakeOrigin: 'schedule' })
        if (started) fired++
      } catch (error) {
        // NOT rethrown: the caller is a webhook consumer whose only lever is retry, and retrying
        // would re-fire every OTHER matching schedule too. The polling sweep remains the backstop
        // for whatever this fire could not start.
        //
        // But not silent either. This is the one path where a failure has no other trace — the
        // delivery still 202s, `fired` just comes back lower, and a consistently-failing schedule
        // reads as "push intake simply doesn't work" with nothing to grep for. So it must leave a
        // log line, exactly as `TrackerWebhookService` does for its own silent drop.
        this.log.warn('webhook-triggered schedule fire failed', {
          workspaceId,
          scheduleId: schedule.id,
          source: event.source,
          externalId: event.externalId,
          err: getErrorMessage(error),
        })
      }
    }
    return fired
  }

  /**
   * PER-TICKET dispatch: import the pushed ticket, materialise it as its own task under the
   * schedule's frame, and start the schedule's pipeline on THAT task. Returns whether a run
   * started.
   *
   * The contrast with {@link fire} is the whole feature. `fire` re-runs one reused block and the
   * run's `bug-intake` step decides what to work; this creates a block per ticket and the ticket
   * IS the work, so a feature request enters the platform from the tracker it was filed in
   * instead of through an API call.
   *
   * Three properties are load-bearing:
   *
   *  - **Idempotency is the issue's existing single `linkedBlockId`**, not a new marker. A
   *    redelivery (or the `updated` event that follows a `created` one) finds the issue already
   *    linked, and `adoptIssueAsTask` reports that as `null`. The link already guarantees what a
   *    claim table would have bought. It is read off the row the import returns rather than by
   *    catching `createTaskFromIssue`'s conflict, because that refusal is PROSE: matching it would
   *    start double-dispatching the day someone rewords the message. A genuine RACE (two deliveries
   *    interleaving between that read and the create) still lands on the conflict and propagates,
   *    which is correct: the caller's per-schedule isolation logs it and the winner has already
   *    dispatched the ticket.
   *  - **The unattended-fire guard is the SAME one `fire` applies.** A webhook has no human present
   *    to unlock a personal credential, so an individual-usage model must refuse here too — checked
   *    against the CREATED block, which is the block that will actually run, rather than the
   *    schedule's reused one.
   *  - **`origin: 'manual'`**, because this run IS a one-off task run: a dedicated block, started
   *    once, never reused. That also makes `assertPipelineLaunchable` refuse a `recurring`-only
   *    pipeline, which is exactly right — a `bug-intake` pipeline would go and pick a DIFFERENT
   *    ticket — and it is the run-time half of the create-time `assertValidIssueIntake` rule.
   *  - **`intakeOrigin: 'tracker'`**, which is a different question from `origin` and the one the
   *    clarification loop asks. Nobody is in the app: the requester is on the ticket, which is
   *    where this run's questions have to go when its requirements review parks. Leaving it unset
   *    reads the run back as UI-started, and a parked review then asks a human who is not there
   *    while the reply channel (ticket comments, ungated by intake) sits waiting for finding ids
   *    that were never posted.
   */
  private async firePerTicket(
    workspaceId: string,
    schedule: PipelineSchedule,
    event: TrackerIssueEvent,
    now: number,
  ): Promise<boolean> {
    const adopt = this.adoptIssueAsTask
    if (!adopt) {
      // No task-source services on this deployment: per-ticket dispatch cannot import anything.
      // Stated rather than silently counted as "not fired", because the config asks for something
      // this deployment structurally cannot do.
      this.log.warn('per-ticket dispatch skipped: task-source adoption is not wired', {
        workspaceId,
        scheduleId: schedule.id,
        source: event.source,
        externalId: event.externalId,
      })
      return false
    }

    const adopted = await adopt({
      workspaceId,
      source: event.source,
      externalId: event.externalId,
      containerId: schedule.frameId,
      pipelineId: schedule.pipelineId,
    })
    // `null` = the issue is already linked to a block, i.e. this ticket has already been
    // dispatched. Not an error and not a fire: the delivery is acked and nothing is duplicated.
    if (!adopted) return false

    const individualVendor =
      (
        await this.executionService.individualVendorsForBlock(
          workspaceId,
          adopted.blockId,
          schedule.pipelineId,
        )
      )[0] ?? null
    if (individualVendor) {
      // The ticket is already on the board as a task, which is the useful half: a human can start
      // it after switching the model. Record WHY it did not auto-start rather than leaving a task
      // that mysteriously never ran.
      await this.schedules.insertRun(workspaceId, {
        id: this.idGenerator.next('schr'),
        scheduleId: schedule.id,
        executionId: null,
        status: 'skipped',
        startedAt: now,
        finishedAt: now,
        outcome: `${event.externalId} was imported as a task, but an individual-usage ${individualVendor} model cannot start unattended. Start it manually, or pick an API-key or coding-plan model.`,
      })
      return false
    }

    const instance = await this.executionService.start(
      workspaceId,
      adopted.blockId,
      schedule.pipelineId,
      { initiatedBy: null, origin: 'manual', intakeOrigin: 'tracker' },
    )
    await this.schedules.insertRun(workspaceId, {
      id: this.idGenerator.next('schr'),
      scheduleId: schedule.id,
      executionId: instance.id,
      status: 'running',
      startedAt: now,
      finishedAt: null,
      outcome: `Dispatched ${event.externalId} as its own task.`,
    })
    // Deliberately NO `advanceCadence`: a per-ticket schedule is on-demand, so it has no cadence
    // to advance, and moving `nextRunAt` would misreport a webhook dispatch as a scheduled fire.
    return true
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
      /**
       * How the run this fire starts ENTERED the system. Required rather than defaulted: two of
       * the three callers are unattended and one is a person clicking run-now, and the default
       * (`ui`) is a claim that someone is watching. A fourth caller has to answer this instead
       * of inheriting whichever answer suited the last one.
       */
      intakeOrigin: IntakeOrigin
    },
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
    // A prior run is "still live" — and must not be overwritten — while it is `running`,
    // spend-`paused`, OR `blocked` on a human gate (a review / decision park). `blocked` is
    // load-bearing here: the whole point of a park is that the run is waiting on a person, so
    // firing the next cadence over it orphans that run's durable driver against a replaced
    // execution and a later human resolve then hits `NotFound`. The park IS the pipeline's
    // current state; leave it and retry next pass.
    if (
      prior &&
      (prior.status === 'running' || prior.status === 'paused' || prior.status === 'blocked')
    ) {
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
        {
          // Present for a run-now (the acting user); null for a sweeper fire. Records the
          // initiator + mints the per-run personal-credential activation for an on-demand
          // schedule's individual-usage model.
          initiatedBy: opts.initiatedBy,
          activate: opts.activate,
          // `origin: 'recurring'` gates the pipeline's launch availability — a one-off-only
          // pipeline can never be fired from a schedule (see assertPipelineLaunchable).
          origin: 'recurring',
          // A DIFFERENT question from `origin`: not what may launch, but who is watching.
          intakeOrigin: opts.intakeOrigin,
        },
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
