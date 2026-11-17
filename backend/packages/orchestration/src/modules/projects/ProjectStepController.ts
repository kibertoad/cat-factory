import {
  projectDefinitionSubjectId,
  type Project,
  type ProjectDefinition,
  type ProjectStepState,
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
  type ProjectRecordRepository,
  type ProjectRepository,
  type ProjectRunContext,
  type ProjectTaskInput,
  type ServiceRepository,
  outcomesOf,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { decodeOutcome, outcomeTaskType } from './outcomeDecoding.js'

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
}

const REQUEST_TEXT_MAX = 2000

/** What a task's step resolved: its project, task handler, pinned definition and outcomes. */
interface ResolvedTask {
  project: Project
  handler: ErasedProjectTaskHandler
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  outcomes: DecodedProjectOutcome[]
}

/** The outcome id a task writes: one per task, so a replayed write is a no-op. */
export function outcomeIdFor(taskId: string): string {
  return `pout_${taskId}`
}

export class ProjectStepController {
  constructor(private readonly deps: ProjectStepControllerDeps) {}

  /** The agent kinds whose steps are project tasks' runs, one per registered task handler. */
  agentKinds(): string[] {
    return this.deps.modules.handlers().map((h) => h.agentKind)
  }

  /** Whether a step of `agentKind` is a project task's run that a task handler plans. */
  handles(agentKind: string): boolean {
    return this.deps.modules.forAgentKind(agentKind) !== undefined
  }

  /**
   * Resolve a project step at dispatch. The first dispatch claims the task's outcome sequence and
   * fixes the kind's plan on the step; a replayed or resumed dispatch reads both back, so the
   * agent is asked the same and the outcome keeps its place in the fold.
   */
  async prepare(step: PipelineStep, block: Block): Promise<ProjectRunContext> {
    const task = await this.resolveTask(block, step.agentKind)
    if (step.project?.taskType && step.project.taskType !== task.handler.taskType) {
      throw new ValidationError("The task's type changed after its run was planned", {
        reason: 'project_task_type_changed',
        plannedTaskType: step.project.taskType,
        taskType: task.handler.taskType,
      })
    }
    if (task.outcomes.some((o) => o.taskId === block.id)) {
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
        seq,
        stream: planned.stream,
        intent: planned.intent,
        definitionKey: task.definition?.key ?? null,
        definitionVersion: task.definition?.version ?? null,
        plan: planned.plan,
      }
    }
    if (!step.project.taskType) step.project = { ...step.project, taskType: task.handler.taskType }
    const state = step.project
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

  private taskInput(task: ResolvedTask, block: Block): ProjectTaskInput<unknown> {
    return {
      task: block,
      definition: task.definition,
      inputs: task.inputs,
      outcomes: outcomesOf(task.handler, task.outcomes),
    }
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
    const definition = pin ? await this.pinnedDefinition(project, pin) : null
    // Only this handler's outcomes are read and decoded: another task type's body is never read,
    // so one that is unreadable just now cannot stop this task.
    const stored = await this.deps.outcomes.list(
      project,
      (row) => outcomeTaskType(this.deps.modules, project.kind, row) === handler.taskType,
    )
    return {
      project,
      handler,
      definition,
      inputs: pin?.inputs ?? {},
      outcomes: stored.map((outcome) => decodeOutcome(this.deps.modules, project.kind, outcome)),
    }
  }

  /** The definition a pin names, refused when it is gone or a registered one changed. */
  private async pinnedDefinition(
    project: Project,
    pin: NonNullable<Awaited<ReturnType<ProjectRecordRepository['getPin']>>>,
  ): Promise<ProjectDefinition> {
    const resolved = await this.deps.definitions.get(
      project.accountId ?? '',
      project.kind,
      pin.definitionKey,
      pin.definitionVersion,
    )
    if (!resolved) {
      throw new ValidationError('The pinned definition no longer exists', {
        reason: 'project_definition_not_found',
        kind: project.kind,
        definitionKey: pin.definitionKey,
        definitionVersion: pin.definitionVersion,
      })
    }
    if (resolved.contentHash !== pin.definitionHash) {
      throw new ValidationError('The registered definition changed since the project pinned it', {
        reason: 'project_definition_changed',
        definitionKey: pin.definitionKey,
      })
    }
    return resolved.definition
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

function requireState(step: PipelineStep): ProjectStepState {
  if (!step.project) {
    throw new Error('A project step completed without the state its dispatch recorded')
  }
  return step.project
}

function scrub(text: string): string {
  return (redactSecrets(text) ?? '').slice(0, REQUEST_TEXT_MAX)
}
