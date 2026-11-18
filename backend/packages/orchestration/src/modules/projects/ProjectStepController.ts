import {
  projectDefinitionSubjectId,
  type Project,
  type ProjectDefinition,
  type ProjectStage,
  type ProjectStageTask,
  type ProjectStepState,
  REVISION_INTENT,
} from '@cat-factory/contracts'
import {
  CapabilityCredentialMissingError,
  ValidationError,
  redactSecrets,
  type AgentRunResult,
  type Block,
  type BlockRepository,
  type Clock,
  type DecodedProjectOutcome,
  type ErasedProjectTaskHandler,
  type PipelineStep,
  type ProjectDefinitionSource,
  type ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  type ProjectRepository,
  type ProjectRunContext,
  type ProjectTaskInput,
  type ProjectUpstreamContext,
  type Logger,
  type ServiceRepository,
  type StageAcceptanceAssessor,
  noopLogger,
  outcomesOf,
  runBestEffort,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import type { ProjectStageService } from './ProjectStageService.js'
import { decodeOutcome, outcomeTaskType } from './outcomeDecoding.js'
import { resolvePinnedDefinition } from './pinnedDefinition.js'
import { assessStageResult } from './stageAcceptance.js'
import type { ProjectEngineTask } from './stageSpawner.js'
import { renderStageUpstream } from './stageUpstream.js'

// ---------------------------------------------------------------------------
// The engine half of a project task's run, for every project kind: what its step is asked when it
// starts, what it checkpoints when it stops for a credential, and the outcome it records when it
// completes. The handler of the task's type is called only where the content matters (planning
// the task, briefing the agent, folding a checkpoint, finishing the body). Design:
// `backend/docs/adr/0069-projects-and-research-projects.md`.
// ---------------------------------------------------------------------------

export interface ProjectStepControllerDeps {
  blockRepository: Pick<BlockRepository, 'findById'>
  projectRepository: Pick<ProjectRepository, 'get'>
  serviceRepository?: Pick<ServiceRepository, 'listByIds'>
  definitions: ProjectDefinitionSource
  records: ProjectRecordRepository
  /** Where outcome bodies live, inline or offloaded to the account's blob store. */
  outcomes: ProjectOutcomeStore
  modules: ProjectKindModuleRegistry
  clock: Clock
  /** Starts the stages a recorded outcome made ready. Absent where projects are not wired. */
  stages?: Pick<ProjectStageService, 'advance'>
  /** Argues a stage result's acceptance criteria. Absent: each report says nothing assessed it. */
  acceptance?: StageAcceptanceAssessor
  /** The task types the engine performs itself rather than dispatching an agent, by task type. */
  engineTasks?: readonly ProjectEngineTask[]
  logger?: Logger
}

const REQUEST_TEXT_MAX = 2000

/** What a task's step resolved: its project, task handler, pinned definition and outcomes. */
interface ResolvedTask {
  project: Project
  handler: ErasedProjectTaskHandler
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  outcomes: DecodedProjectOutcome[]
  /** Every outcome envelope of the project, listed once per dispatch. */
  envelopes: ProjectOutcomeRow[]
  /** The stage the task runs, with its record and the project's, for a staged project. */
  staged: { stage: ProjectStage; record: ProjectStageTask; records: ProjectStageTask[] } | null
}

/** The outcome id a task writes: one per task, so a replayed write is a no-op. */
export function outcomeIdFor(taskId: string): string {
  return `pout_${taskId}`
}

export class ProjectStepController {
  private readonly log: Logger

  constructor(private readonly deps: ProjectStepControllerDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /** The agent kinds whose steps are project tasks' runs, one per registered task handler. */
  agentKinds(): string[] {
    return this.deps.modules.handlers().map((h) => h.agentKind)
  }

  /** Whether a step of `agentKind` is a project task's run that a task handler plans. */
  handles(agentKind: string): boolean {
    return this.deps.modules.forAgentKind(agentKind) !== undefined
  }

  /** Whether a step of `agentKind` is a task type its handler says the engine performs. */
  runsInEngine(agentKind: string): boolean {
    return this.deps.modules.forAgentKind(agentKind)?.performedBy === 'engine'
  }

  /**
   * Plan and perform an engine step: the reply its handler's `finish` reads, which the ordinary
   * completion records as the task's outcome. Refuses when nothing in this process performs it.
   */
  async runInEngine(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
  ): Promise<AgentRunResult> {
    const task = await this.plan(step, block)
    const engineTask = this.engineTaskOf(task.handler.taskType)
    if (!engineTask) {
      throw new Error(
        `Task type '${task.handler.taskType}' is performed by the engine, and this process has ` +
          'nothing wired to perform it',
      )
    }
    const reply = await engineTask.run({
      workspaceId,
      project: task.project,
      task: block,
      plan: step.project!.plan,
    })
    return { output: '', custom: reply }
  }

  private engineTaskOf(taskType: string): ProjectEngineTask | undefined {
    return this.deps.engineTasks?.find((t) => t.taskType === taskType)
  }

  /**
   * Resolve a project step at dispatch. The first dispatch claims the task's outcome sequence and
   * fixes the kind's plan on the step; a replayed or resumed dispatch reads both back, so the
   * agent is asked the same and the outcome keeps its place in the fold.
   */
  /**
   * `reattach` is a durable replay attaching to the step's live job rather than dispatching one:
   * nothing it builds reaches an agent, so the upstream results are neither read nor re-recorded.
   */
  async prepare(
    step: PipelineStep,
    block: Block,
    opts: { reattach?: boolean } = {},
  ): Promise<ProjectRunContext> {
    const task = await this.plan(step, block)
    const upstream =
      task.staged && task.definition && !opts.reattach
        ? await renderStageUpstream(
            { outcomes: this.deps.outcomes, modules: this.deps.modules },
            {
              project: task.project,
              definition: task.definition,
              inputs: task.inputs,
              ...task.staged,
              envelopes: task.envelopes,
              decoded: task.outcomes,
            },
          )
        : []
    return this.agentContext(step, block, task, upstream, opts)
  }

  /**
   * Resolve the task and fix its plan on the step: the first dispatch claims the task's outcome
   * sequence, a replayed or resumed one reads both back.
   */
  private async plan(step: PipelineStep, block: Block): Promise<ResolvedTask> {
    const task = await this.resolveTask(block, step.agentKind)
    if (step.project?.taskType && step.project.taskType !== task.handler.taskType) {
      throw new ValidationError("The task's type changed after its run was planned", {
        reason: 'project_task_type_changed',
        plannedTaskType: step.project.taskType,
        taskType: task.handler.taskType,
      })
    }
    if (task.outcomes.some((o) => o.taskId === block.id)) {
      // The outcome landed but the stage was never told (the process died between the two
      // writes): free the stage now, or its slot stays held by a task that already finished.
      if (task.staged) {
        await this.deps.records.markStageTaskRecorded(
          task.project.id,
          block.id,
          this.deps.clock.now(),
        )
      }
      throw new ValidationError('This task already recorded its outcome on the project', {
        reason: 'project_task_already_recorded',
      })
    }
    const input = this.taskInput(task, block)
    if (!step.project) {
      const planned = task.handler.planTask(input)
      const seq = await this.deps.records.reserveTaskSeq(task.project.id, block.id)
      step.project = {
        projectId: task.project.id,
        kind: task.project.kind,
        taskType: task.handler.taskType,
        ...(task.staged ? { stageId: task.staged.stage.id } : {}),
        seq,
        // A stage names the stream its tasks write, whatever the handler would pick on its own.
        stream: task.staged?.stage.produces ?? planned.stream,
        intent: planned.intent,
        definitionKey: task.definition?.key ?? null,
        definitionVersion: task.definition?.version ?? null,
        plan: planned.plan,
      }
    }
    if (!step.project.taskType) step.project = { ...step.project, taskType: task.handler.taskType }
    return task
  }

  /** What the agent of a planned step is given, with the upstream results it reads. */
  private async agentContext(
    step: PipelineStep,
    block: Block,
    task: ResolvedTask,
    upstream: ProjectUpstreamContext[],
    opts: { reattach?: boolean },
  ): Promise<ProjectRunContext> {
    const input = this.taskInput(task, block)
    if (task.staged && !opts.reattach) {
      step.project = {
        ...requireState(step),
        upstream: upstream.map((u) => ({
          stageId: u.stageId,
          outcomeId: u.revision?.id ?? null,
          seq: u.revision?.seq ?? null,
        })),
      }
    }
    const state = requireState(step)
    const checkpoint = this.parse(task.handler, state.checkpoint)
    const services = task.project.serviceIds.length
      ? ((await this.deps.serviceRepository?.listByIds(task.project.serviceIds)) ?? [])
      : []
    return {
      projectId: task.project.id,
      kind: task.project.kind,
      definition: task.definition,
      inputs: task.inputs,
      linkedFrameBlockIds: services.map((s) => s.frameBlockId).filter((id): id is string => !!id),
      upstream,
      writes: task.staged?.stage.writes === true,
      brief: task.handler.brief({
        ...input,
        plan: state.plan,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
      }),
    }
  }

  /**
   * The agent stopped to ask for a credential: keep what it produced so far on the step and return
   * the refusal that parks it. The caller persists the step BEFORE throwing, because the park
   * reloads the run.
   */
  async checkpoint(
    step: PipelineStep,
    result: AgentRunResult,
  ): Promise<CapabilityCredentialMissingError> {
    const state = requireState(step)
    const handler = this.handlerOf(state)
    const request = result.credentialRequest!
    const partial = this.parse(handler, result.custom)
    if (partial !== undefined) {
      const prior = this.parse(handler, state.checkpoint)
      step.project = {
        ...state,
        checkpoint: prior !== undefined ? handler.mergeCheckpoint(prior, partial) : partial,
      }
    }
    const definition = await this.definitionOf(state)
    const credential = definition?.credentials.find((c) => c.key === request.key)
    return new CapabilityCredentialMissingError(`The run needs the credential '${request.key}'`, {
      key: request.key,
      declaredBy: {
        kind: 'project-definition',
        id: projectDefinitionSubjectId(state.kind, state.definitionKey ?? ''),
      },
      ...(credential ? { label: credential.label } : {}),
      ...(credential?.onboarding ? { onboarding: credential.onboarding } : {}),
      reason: scrub(request.reason),
      observed: scrub(request.observed),
    })
  }

  /**
   * Record the task's one outcome from the step's reply, folded over its checkpoint by the kind.
   * Its id is the task's, so a replayed completion writes nothing twice.
   */
  async record(
    workspaceId: string,
    step: PipelineStep,
    taskId: string,
    result: AgentRunResult,
  ): Promise<{ output: string; outputIsRendered: true }> {
    const state = requireState(step)
    const handler = this.handlerOf(state)
    const reply = this.parse(handler, result.custom)
    if (reply === undefined) {
      throw new Error('The run returned no readable outcome (malformed or empty JSON)')
    }
    const checkpoint = this.parse(handler, state.checkpoint)
    const finished = handler.finish({
      plan: state.plan,
      seq: state.seq,
      reply,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
    })
    const project = await this.deps.projectRepository.get(state.projectId)
    if (!project) throw new Error(`Project '${state.projectId}' no longer exists`)
    const id = outcomeIdFor(taskId)
    const recorded = await this.deps.outcomes.write({
      runWorkspaceId: workspaceId,
      project,
      row: {
        id,
        projectId: state.projectId,
        stream: state.stream,
        seq: state.seq,
        intent: state.intent,
        schemaVersion: handler.outcomeSchemaVersion,
        taskId,
        taskType: handler.taskType,
        definitionKey: state.definitionKey,
        definitionVersion: state.definitionVersion,
        artifactRefs: handler.artifactRefs(finished.body),
        createdAt: this.deps.clock.now(),
      },
      json: JSON.stringify(finished.body),
    })
    step.project = { ...state, outcomeId: id }
    if (state.stageId) {
      await this.deps.records.markStageTaskRecorded(state.projectId, taskId, this.deps.clock.now())
      // The outcome is on record; a report that cannot be written is logged, never the run's end.
      await runBestEffort(
        this.log,
        'projects.stages.assessAcceptance',
        () => this.assessAcceptance(workspaceId, project, state, taskId),
        { projectId: state.projectId, taskId },
      )
      const stages = this.deps.stages
      if (stages) {
        // The outcome is on record whatever happens next: a later stage that fails to start
        // stays `ready` for a person. A replay advances again and finds nothing new to start.
        await runBestEffort(
          this.log,
          'projects.stages.advanceOnOutcome',
          () => stages.advance(workspaceId, state.projectId),
          { projectId: state.projectId, taskId },
        )
      }
    }
    if (recorded.written) return { output: finished.output, outputIsRendered: true }
    // A replayed completion lost to the write that landed first: describe the outcome on record,
    // not the replay's reply, which may differ from it.
    const body = handler.parseOutcome(handler.outcomeSchemaVersion, JSON.parse(recorded.json))
    if (body === undefined) throw new Error(`Outcome '${id}' holds an unreadable body`)
    return {
      output: handler.describe({ plan: state.plan, seq: state.seq, body }),
      outputIsRendered: true,
    }
  }

  /** Assess the result a staged task recorded against its stage's acceptance criteria, if any. */
  private async assessAcceptance(
    workspaceId: string,
    project: Project,
    state: ProjectStepState,
    taskId: string,
  ): Promise<void> {
    const definition = await this.definitionOf(state)
    const stage = definition?.stages.find((s) => s.id === state.stageId)
    if (!definition || !stage?.acceptance) return
    const [found, pin] = await Promise.all([
      this.deps.blockRepository.findById(taskId),
      this.deps.records.getPin(project.id),
    ])
    if (!found) return
    await assessStageResult(
      { ...this.deps, ...(this.deps.acceptance ? { assessor: this.deps.acceptance } : {}) },
      {
        workspaceId,
        project,
        definition,
        inputs: pin?.inputs ?? {},
        stage,
        task: found.block,
        outcome: { id: outcomeIdFor(taskId), seq: state.seq },
      },
    )
  }

  private taskInput(task: ResolvedTask, block: Block): ProjectTaskInput<unknown> {
    return {
      task: block,
      definition: task.definition,
      inputs: task.inputs,
      stage: task.staged ? { id: task.staged.stage.id, config: task.staged.stage.config } : null,
      outcomes: outcomesOf(task.handler, task.outcomes).filter(
        (o) =>
          !task.staged || (o.stream === task.staged.stage.produces && countsFor(task.staged, o)),
      ),
    }
  }

  /**
   * The stage a task of a staged project runs, from the record its stage start wrote. A task
   * created under a staged project any other way belongs to no stage and is refused.
   */
  private async stageOf(
    project: Project,
    definition: ProjectDefinition | null,
    block: Block,
    handler: ErasedProjectTaskHandler,
  ): Promise<ResolvedTask['staged']> {
    if (!definition?.stages.length) return null
    const records = await this.deps.records.listStageTasks(project.id)
    const record = records.find((r) => r.taskId === block.id)
    const stage = definition.stages.find((s) => s.id === record?.stageId)
    if (!stage || !record) {
      throw new ValidationError('This task was not started from a stage of its project', {
        reason: 'project_task_has_no_stage',
        projectId: project.id,
      })
    }
    if (stage.taskType !== handler.taskType) {
      throw new ValidationError("The task's type is not the one its stage runs", {
        reason: 'project_task_type_changed',
        plannedTaskType: stage.taskType,
        taskType: handler.taskType,
      })
    }
    return { stage, record, records }
  }

  private async resolveTask(block: Block, agentKind: string): Promise<ResolvedTask> {
    const found = await this.deps.blockRepository.findById(block.id)
    const project = found?.ownerId ? await this.deps.projectRepository.get(found.ownerId) : null
    if (!project) {
      throw new ValidationError(`A '${agentKind}' step must run under a project of its kind`, {
        reason: 'task_type_requires_project',
      })
    }
    const taskType = found?.block.taskType ?? ''
    const handler = this.deps.modules.handlerOf(project.kind, taskType)
    if (!handler || handler.agentKind !== agentKind) {
      throw new ValidationError(
        `Project kind '${project.kind}' has no handler running a '${taskType}' task as '${agentKind}'`,
        { reason: 'task_type_not_offered_by_project', kind: project.kind, taskType, agentKind },
      )
    }
    const pin = await this.deps.records.getPin(project.id)
    const definition = pin
      ? await resolvePinnedDefinition(this.deps.definitions, project, pin)
      : null
    // Only this handler's outcomes are read and decoded: another task type's body is never read,
    // so one that is unreadable just now cannot stop this task.
    const envelopes = await this.deps.records.listOutcomes(project.id)
    const stored = await this.deps.outcomes.bodiesOf(
      project,
      envelopes.filter(
        (row) => outcomeTaskType(this.deps.modules, project.kind, row) === handler.taskType,
      ),
    )
    return {
      project,
      handler,
      envelopes,
      staged: await this.stageOf(project, definition, block, handler),
      definition,
      inputs: pin?.inputs ?? {},
      outcomes: stored.map((outcome) => decodeOutcome(this.deps.modules, project.kind, outcome)),
    }
  }

  private async definitionOf(state: ProjectStepState): Promise<ProjectDefinition | undefined> {
    if (state.definitionKey === null || state.definitionVersion === null) return undefined
    const project = await this.deps.projectRepository.get(state.projectId)
    const resolved = await this.deps.definitions.get(
      project?.accountId ?? '',
      state.kind,
      state.definitionKey,
      state.definitionVersion,
    )
    return resolved?.definition
  }

  /** The handler that planned the step, as its dispatch recorded it. */
  private handlerOf(state: ProjectStepState): ErasedProjectTaskHandler {
    if (!state.taskType) {
      throw new Error(
        'This project step was planned by a build that did not record its task type; retry the task',
      )
    }
    const handler = this.deps.modules.handlerOf(state.kind, state.taskType)
    if (!handler) {
      throw new Error(
        `Project kind '${state.kind}' has no handler for task type '${state.taskType}' in this process`,
      )
    }
    return handler
  }

  private parse(handler: ErasedProjectTaskHandler, value: unknown): unknown {
    if (value === undefined || value === null) return undefined
    return handler.parseOutcome(handler.outcomeSchemaVersion, value)
  }
}

/** Whether an outcome counts as its stage's result: a revision only once an acceptance named it. */
function countsFor(
  staged: { records: readonly ProjectStageTask[] },
  outcome: { id: string; intent: string },
): boolean {
  if (outcome.intent !== REVISION_INTENT) return true
  return staged.records.some((r) => r.acceptedOutcomeId === outcome.id)
}

function requireState(step: PipelineStep): ProjectStepState {
  if (!step.project) {
    throw new Error('A project step completed without the state its dispatch recorded')
  }
  return step.project
}

function scrub(text: string): string {
  return (redactSecrets(text) ?? '').slice(0, REQUEST_TEXT_MAX)
}
