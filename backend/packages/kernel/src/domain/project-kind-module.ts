import type {
  DefinitionParseResult,
  ProjectDefinition,
  ProjectDefinitionSpecValidator,
  ProjectKindSchemas,
  ProjectOutcome,
  TaskType,
} from '@cat-factory/contracts'
import type { Block } from './types.js'

// ---------------------------------------------------------------------------
// The code half of a project kind: what the platform cannot do without understanding the kind's
// content. The engine owns everything else about a project task's run (the pin and its hash
// check, the task's sequence claim, the state fixed on the step, the outcome write and its
// storage placement, the credential park), and calls a kind's code only where content matters.
// That code has two levels: a TASK HANDLER per task type (planning, briefing and finishing a
// task, and decoding the outcomes it writes), and the kind MODULE (its definitions' spec, its
// project-level view, its linked-context rendering), which names the handlers its projects offer.
// One handler may serve several kinds. A kind's descriptor (`ProjectKindRegistry`) says what the
// board offers. Design: `backend/docs/adr/0069-projects-and-research-projects.md`.
// ---------------------------------------------------------------------------

/** What a handler is told about a task when it plans it or briefs its agent. */
export interface ProjectTaskInput<Body> {
  task: Block
  /** The definition the project pinned, or null for a kind that pins none. */
  definition: ProjectDefinition | null
  /** The project's values for the definition's `inputs`. */
  inputs: Record<string, unknown>
  /**
   * The stage of the pinned definition the task runs, with its `config` as this handler
   * normalized it; null for a project whose definition declares no stages.
   */
  stage: { id: string; config: unknown } | null
  /**
   * The outcomes tasks of this handler's type wrote so far, `seq` ascending, decoded by it; for a
   * staged task, only those of its own stage.
   */
  outcomes: ReadonlyArray<ProjectOutcome<Body>>
}

/** What a handler reads to render one stream's outcomes as context. */
export interface ProjectStreamContextInput<Body> {
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  /** The stage that wrote the stream, with its config as normalized. */
  stage: { id: string; title: string; config: unknown }
  /** The stream's outcomes to render, `seq` ascending, decoded by this handler. */
  outcomes: ReadonlyArray<ProjectOutcome<Body>>
}

/** A task's plan, fixed on its step at its first dispatch. */
export interface ProjectTaskPlan {
  /** What the task asks for, in the handler's own vocabulary; recorded on the outcome. */
  intent: string
  /** The stream the task's outcome is written to. */
  stream: string
  /** The handler's own plan; handed back to it on every later call for this task. */
  plan: unknown
}

/**
 * The code that runs one task type under a project, whatever kind the project is. It owns the
 * agent the task dispatches and the body of the outcome the task writes.
 */
export interface ProjectTaskHandler<Body = unknown> {
  /** The task type this handler runs. */
  taskType: TaskType
  /** The agent kind a task of this type dispatches: the step the engine plans and records. */
  agentKind: string
  /**
   * Who performs a task of this type: an agent the step dispatches (the default), or the engine
   * itself, through the engine task a process wires for the type. A step whose engine task is not
   * wired refuses rather than dispatching an agent that does not exist.
   */
  performedBy?: 'agent' | 'engine'
  /** The body schema version this build writes outcomes in. */
  outcomeSchemaVersion: number
  /** Decode a stored or replied body, or undefined when it does not parse. */
  parseOutcome(schemaVersion: number, value: unknown): Body | undefined
  /**
   * Plan a task at its first dispatch. Throws a `ValidationError` naming its own reason when the
   * task has nothing to do, so the run refuses rather than dispatching an empty brief.
   */
  planTask(input: ProjectTaskInput<Body>): ProjectTaskPlan
  /** The agent's brief for a planned task, from what the project knows and any checkpoint. */
  brief(input: ProjectTaskInput<Body> & { plan: unknown; checkpoint?: Body }): unknown
  /** Fold what a parked dispatch recorded with what a later dispatch replied. */
  mergeCheckpoint(earlier: Body, later: Body): Body
  /** The outcome body a completed task records, and the step output that describes it. */
  finish(input: { plan: unknown; seq: number; reply: Body; checkpoint?: Body }): {
    body: Body
    output: string
  }
  /** Describe a body already on record, for a replayed completion that lost the write. */
  describe(input: { plan: unknown; seq: number; body: Body }): string
  /** The binary artifacts a body references, for the outcome's `artifactRefs`. */
  artifactRefs(body: Body): string[]
  /**
   * One stage's outcomes, written by tasks of this type, rendered as read-only context for
   * another agent: a later stage that reads this one. Absent: the platform shows the newest
   * outcome as recorded.
   */
  renderContext?(input: ProjectStreamContextInput<Body>): ProjectContextRendering
  /**
   * How a person revises this task type's result as they accept it at a stage checkpoint: the
   * model proposed, the person settles. Absent: the result is accepted as recorded, and a revision
   * is refused. `required` refuses an acceptance that sends none.
   */
  checkpointRevision?: {
    required: boolean
    /** The body the person accepts, from the recorded one and what they sent, or why it misfits. */
    revise(input: {
      stage: { id: string; title: string; config: unknown }
      body: Body
      revision: unknown
      decidedBy: string | null
      decidedAt: number
    }): DefinitionParseResult<Body>
  }
  /**
   * The tasks a result set going that must settle (done, or removed from the board) before a
   * person may accept it at its stage's checkpoint. Absent: an acceptance waits on nothing.
   */
  checkpointAwaits?(body: Body): readonly { workspaceId: string; taskId: string }[]
  /**
   * Whether a stage running this task type must run `after` at least one other stage. A checkpoint
   * is implied by a required revision or by {@link checkpointAwaits}, and needs no flag here.
   */
  stageRequires?: { after?: boolean }
  /**
   * Validate and normalize the `config` a definition's stage gives this task type. Absent: the
   * task type takes no config, and a stage that gives one is refused.
   */
  parseConfig?(config: unknown): DefinitionParseResult<unknown>
  /** The schema of the outcome body, served so a client can type what the API leaves opaque. */
  schemas?: Pick<ProjectKindSchemas, 'outcome'>
}

/**
 * A handler with its body type erased, as a module lists it. The platform hands a handler only
 * bodies its own `parseOutcome` produced, so the erased type holds by construction.
 */
export type ErasedProjectTaskHandler = ProjectTaskHandler<unknown>

/** Erase a handler's body type so a module can list it beside handlers of other bodies. */
export function eraseTaskHandler<Body>(
  handler: ProjectTaskHandler<Body>,
): ErasedProjectTaskHandler {
  return handler as unknown as ErasedProjectTaskHandler
}

/** An outcome decoded by the handler of the task type that wrote it. */
export interface DecodedProjectOutcome extends ProjectOutcome<unknown> {
  /** The task type whose handler decoded the body; null when no handler in this process did. */
  taskType: string | null
}

/**
 * The outcomes `handler` wrote, typed as its body. Every body in `outcomes` was decoded by the
 * handler of its own task type, so the ones of this handler's type hold its body by construction.
 */
export function outcomesOf<Body>(
  handler: ProjectTaskHandler<Body>,
  outcomes: ReadonlyArray<DecodedProjectOutcome>,
): ProjectOutcome<Body>[] {
  return outcomes.filter((o) => o.taskType === handler.taskType) as ProjectOutcome<Body>[]
}

export interface ProjectKindModule extends ProjectDefinitionSpecValidator {
  /** The project kind this module is the code half of. */
  kind: string
  /** The handlers of the task types its projects run, at least one. */
  handlers: ReadonlyArray<ErasedProjectTaskHandler>
  /** A one-line summary of a definition of this kind, for a picker that lists definitions. */
  definitionSummary(definition: ProjectDefinition): string
  /**
   * The project's current state as this kind reads its outcomes, served opaquely by the public
   * API. A kind without one has no view; a reader lists its outcomes instead.
   */
  view?(input: ProjectViewInput): unknown
  /** The schemas of its spec and view, served so a client can type what the API leaves opaque. */
  schemas?: Pick<ProjectKindSchemas, 'spec' | 'view'>
  /**
   * What a project of this kind contributes as read-only context to a task that links it. Absent:
   * the platform renders the newest outcome of each stream as recorded.
   */
  renderContext?(input: ProjectViewInput): ProjectContextRendering
}

/** A project's current result as linked context for another task's agent. */
export interface ProjectContextRendering {
  /** One line for the prompt's linked-context index. */
  summary: string
  /** How complete the result is, in one line. */
  coverage: string
  /** The full result as Markdown, materialised as a file the agent reads. */
  body: string
}

/** What a module reads to compute a project's current view. */
export interface ProjectViewInput {
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  /** Every outcome of the project, `seq` ascending; {@link outcomesOf} narrows to one handler's. */
  outcomes: ReadonlyArray<DecodedProjectOutcome>
}

/**
 * The project kind modules a deployment ships, one per kind, and the task handlers they name. A
 * module's spec validator is also what the definition registry checks that kind's definitions
 * with.
 */
export class ProjectKindModuleRegistry {
  private readonly byKind = new Map<string, ProjectKindModule>()
  private readonly byTaskType = new Map<string, ErasedProjectTaskHandler>()
  private readonly byAgentKind = new Map<string, ErasedProjectTaskHandler>()

  /**
   * Register a kind's module. Throws on a second module for one kind, a module with no handler,
   * or a handler that differs from another (registered before or listed beside it) for the same
   * task type or agent kind: a task type and an agent kind each name exactly one handler, which
   * any kind may offer. Nothing is registered when it throws.
   */
  register(module: ProjectKindModule): void {
    if (this.byKind.has(module.kind)) {
      throw new Error(`a module for project kind '${module.kind}' is already registered`)
    }
    if (module.handlers.length === 0) {
      throw new Error(`project kind '${module.kind}' names no task handler`)
    }
    const byTaskType = new Map(this.byTaskType)
    const byAgentKind = new Map(this.byAgentKind)
    for (const handler of module.handlers) {
      const known = byTaskType.get(handler.taskType)
      if (known && known !== handler) {
        throw new Error(`two different handlers are registered for task type '${handler.taskType}'`)
      }
      const sharing = byAgentKind.get(handler.agentKind)
      if (sharing && sharing !== handler) {
        throw new Error(
          `task types '${sharing.taskType}' and '${handler.taskType}' cannot share the agent kind '${handler.agentKind}'`,
        )
      }
      byTaskType.set(handler.taskType, handler)
      byAgentKind.set(handler.agentKind, handler)
    }
    this.byKind.set(module.kind, module)
    for (const [taskType, handler] of byTaskType) this.byTaskType.set(taskType, handler)
    for (const [agentKind, handler] of byAgentKind) this.byAgentKind.set(agentKind, handler)
  }

  get(kind: string): ProjectKindModule | undefined {
    return this.byKind.get(kind)
  }

  /** The handler of `taskType`, whichever kind registered it. */
  handler(taskType: string): ErasedProjectTaskHandler | undefined {
    return this.byTaskType.get(taskType)
  }

  /** The handler whose tasks dispatch `agentKind`, if any. */
  forAgentKind(agentKind: string): ErasedProjectTaskHandler | undefined {
    return this.byAgentKind.get(agentKind)
  }

  /** The handler `kind` offers for `taskType`, or undefined when the kind does not offer it. */
  handlerOf(kind: string, taskType: string): ErasedProjectTaskHandler | undefined {
    return this.byKind.get(kind)?.handlers.find((h) => h.taskType === taskType)
  }

  /**
   * The handler that decodes an outcome of a `kind` project: the one its recorded task type names,
   * or, for an outcome with none recorded (written before outcomes recorded it, or by a build that
   * did not send it), the kind's handler when the kind has exactly one. Undefined when neither
   * resolves, and the body is then served as stored.
   */
  handlerOfOutcome(
    kind: string,
    taskType: string | null | undefined,
  ): ErasedProjectTaskHandler | undefined {
    if (taskType) return this.byTaskType.get(taskType)
    const handlers = this.byKind.get(kind)?.handlers ?? []
    return handlers.length === 1 ? handlers[0] : undefined
  }

  /** Every registered handler, each once. */
  handlers(): ErasedProjectTaskHandler[] {
    return [...this.byTaskType.values()]
  }

  all(): ProjectKindModule[] {
    return [...this.byKind.values()]
  }
}
