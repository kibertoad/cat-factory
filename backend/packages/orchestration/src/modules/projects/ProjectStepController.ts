import {
  projectDefinitionSubjectId,
  type Project,
  type ProjectDefinition,
  type ProjectOutcome,
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
  type PipelineStep,
  type ProjectDefinitionSource,
  type ProjectKindModule,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  type ProjectRepository,
  type ProjectRunContext,
  type ProjectTaskInput,
  type ServiceRepository,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore, StoredOutcome } from './ProjectOutcomeStore.js'

// ---------------------------------------------------------------------------
// The engine half of a project task's run, for every project kind: what its step is asked when it
// starts, what it checkpoints when it stops for a credential, and the outcome it records when it
// completes. The kind's module is called only where the content matters (planning the task,
// briefing the agent, folding a checkpoint, finishing the body). Design:
// `docs/initiatives/research-projects.md`.
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

/** What a task's step resolved: its project, kind module, pinned definition and outcomes. */
interface ResolvedTask {
  project: Project
  module: ProjectKindModule<unknown>
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  outcomes: ProjectOutcome<unknown>[]
}

/** The outcome id a task writes: one per task, so a replayed write is a no-op. */
export function outcomeIdFor(taskId: string): string {
  return `pout_${taskId}`
}

export class ProjectStepController {
  constructor(private readonly deps: ProjectStepControllerDeps) {}

  /** The agent kinds whose steps are project tasks' runs, one per registered kind module. */
  agentKinds(): string[] {
    return this.deps.modules.all().map((m) => m.agentKind)
  }

  /** Whether a step of `agentKind` is a project task's run that a module plans. */
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
    if (task.outcomes.some((o) => o.taskId === block.id)) {
      throw new ValidationError('This task already recorded its outcome on the project', {
        reason: 'project_task_already_recorded',
      })
    }
    const input = this.taskInput(task, block)
    if (!step.project) {
      const planned = task.module.planTask(input)
      const seq = await this.deps.records.reserveTaskSeq(task.project.id, block.id)
      step.project = {
        projectId: task.project.id,
        kind: task.module.kind,
        seq,
        stream: planned.stream,
        intent: planned.intent,
        definitionKey: task.definition?.key ?? null,
        definitionVersion: task.definition?.version ?? null,
        plan: planned.plan,
      }
    }
    const state = step.project
    const checkpoint = this.parse(task.module, state.checkpoint)
    const services = task.project.serviceIds.length
      ? ((await this.deps.serviceRepository?.listByIds(task.project.serviceIds)) ?? [])
      : []
    return {
      projectId: task.project.id,
      kind: task.module.kind,
      definition: task.definition,
      inputs: task.inputs,
      linkedFrameBlockIds: services.map((s) => s.frameBlockId).filter((id): id is string => !!id),
      brief: task.module.brief({
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
    const module = this.moduleOf(state)
    const request = result.credentialRequest!
    const partial = this.parse(module, result.custom)
    if (partial !== undefined) {
      const prior = this.parse(module, state.checkpoint)
      step.project = {
        ...state,
        checkpoint: prior !== undefined ? module.mergeCheckpoint(prior, partial) : partial,
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
    const module = this.moduleOf(state)
    const reply = this.parse(module, result.custom)
    if (reply === undefined) {
      throw new Error('The run returned no readable outcome (malformed or empty JSON)')
    }
    const checkpoint = this.parse(module, state.checkpoint)
    const finished = module.finish({
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
        schemaVersion: module.outcomeSchemaVersion,
        taskId,
        definitionKey: state.definitionKey,
        definitionVersion: state.definitionVersion,
        artifactRefs: module.artifactRefs(finished.body),
        createdAt: this.deps.clock.now(),
      },
      json: JSON.stringify(finished.body),
    })
    step.project = { ...state, outcomeId: id }
    if (recorded.written) return { output: finished.output, outputIsRendered: true }
    // A replayed completion lost to the write that landed first: describe the outcome on record,
    // not the replay's reply, which may differ from it.
    const body = module.parseOutcome(module.outcomeSchemaVersion, JSON.parse(recorded.json))
    if (body === undefined) throw new Error(`Outcome '${id}' holds an unreadable body`)
    return {
      output: module.describe({ plan: state.plan, seq: state.seq, body }),
      outputIsRendered: true,
    }
  }

  private taskInput(task: ResolvedTask, block: Block): ProjectTaskInput<unknown> {
    return {
      task: block,
      definition: task.definition,
      inputs: task.inputs,
      outcomes: task.outcomes,
    }
  }

  private async resolveTask(block: Block, agentKind: string): Promise<ResolvedTask> {
    const found = await this.deps.blockRepository.findById(block.id)
    const project = found?.ownerId ? await this.deps.projectRepository.get(found.ownerId) : null
    const module = project ? this.deps.modules.get(project.kind) : undefined
    if (!project || !module || module.agentKind !== agentKind) {
      throw new ValidationError(`A '${agentKind}' step must run under a project of its kind`, {
        reason: 'task_type_requires_project',
      })
    }
    const pin = await this.deps.records.getPin(project.id)
    const definition = pin ? await this.pinnedDefinition(project, pin) : null
    const stored = await this.deps.outcomes.list(project)
    return {
      project,
      module,
      definition,
      inputs: pin?.inputs ?? {},
      outcomes: stored.map((outcome) => this.decode(module, outcome)),
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

  private moduleOf(state: ProjectStepState): ProjectKindModule<unknown> {
    const module = this.deps.modules.get(state.kind)
    if (!module) {
      throw new Error(`No module is registered for project kind '${state.kind}'`)
    }
    return module
  }

  private parse(module: ProjectKindModule<unknown>, value: unknown): unknown {
    if (value === undefined || value === null) return undefined
    return module.parseOutcome(module.outcomeSchemaVersion, value)
  }

  private decode(module: ProjectKindModule<unknown>, { row, json }: StoredOutcome): ProjectOutcome {
    const body = module.parseOutcome(row.schemaVersion, JSON.parse(json))
    if (body === undefined) throw new Error(`Outcome '${row.id}' holds an unreadable body`)
    const { body: _ref, bodyBytes: _bytes, ...meta } = row
    return { ...meta, body }
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
