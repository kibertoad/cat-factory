import type {
  ProjectDefinition,
  ProjectDefinitionSpecValidator,
  ProjectKindSchemas,
  ProjectOutcome,
} from '@cat-factory/contracts'
import type { Block } from './types.js'

// ---------------------------------------------------------------------------
// The code half of a project kind: what the platform cannot do without understanding the kind's
// content. The engine owns everything else about a project task's run (the pin and its hash
// check, the task's sequence claim, the state fixed on the step, the outcome write and its
// storage placement, the credential park), and calls a module only where content matters. A
// kind's descriptor (`ProjectKindRegistry`) says what the board offers; its module says what its
// definitions and outcomes mean. Design: `backend/docs/adr/0069-projects-and-research-projects.md`.
// ---------------------------------------------------------------------------

/** What a module is told about a task when it plans it or briefs its agent. */
export interface ProjectTaskInput<Body> {
  task: Block
  /** The definition the project pinned, or null for a kind that pins none. */
  definition: ProjectDefinition | null
  /** The project's values for the definition's `inputs`. */
  inputs: Record<string, unknown>
  /** The project's outcomes so far, `seq` ascending, bodies decoded by this module. */
  outcomes: ReadonlyArray<ProjectOutcome<Body>>
}

/** A task's plan, fixed on its step at its first dispatch. */
export interface ProjectTaskPlan {
  /** What the task asks for, in the kind's own vocabulary; recorded on the outcome. */
  intent: string
  /** The stream the task's outcome is written to. */
  stream: string
  /** The kind's own plan; handed back to the module on every later call for this task. */
  plan: unknown
}

export interface ProjectKindModule<Body = unknown> extends ProjectDefinitionSpecValidator {
  /** The project kind this module is the code half of. */
  kind: string
  /** The agent kind a task of this kind dispatches: the step the engine plans and records. */
  agentKind: string
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
  /** A one-line summary of a definition of this kind, for a picker that lists definitions. */
  definitionSummary(definition: ProjectDefinition): string
  /**
   * The project's current state as this kind reads its outcomes, served opaquely by the public
   * API. A kind without one has no view; a reader lists its outcomes instead.
   */
  view?(input: ProjectViewInput<Body>): unknown
  /** The schemas of this kind's own shapes, served so a client can type what the API leaves opaque. */
  schemas?: ProjectKindSchemas
  /**
   * What a project of this kind contributes as read-only context to a task that links it. Absent:
   * the platform renders the newest outcome of each stream as recorded.
   */
  renderContext?(input: ProjectViewInput<Body>): ProjectContextRendering
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
export interface ProjectViewInput<Body> {
  definition: ProjectDefinition | null
  inputs: Record<string, unknown>
  /** Every outcome of the project, `seq` ascending, bodies decoded by this module. */
  outcomes: ReadonlyArray<ProjectOutcome<Body>>
}

/**
 * The project kind modules a deployment ships, one per kind. A module's spec validator is also
 * what the definition registry checks that kind's definitions with.
 */
export class ProjectKindModuleRegistry {
  private readonly byKind = new Map<string, ProjectKindModule<unknown>>()

  /** Register a kind's module. Throws on a second module for one kind or one agent kind. */
  register<Body>(module: ProjectKindModule<Body>): void {
    if (this.byKind.has(module.kind)) {
      throw new Error(`a module for project kind '${module.kind}' is already registered`)
    }
    const sharing = [...this.byKind.values()].find((m) => m.agentKind === module.agentKind)
    if (sharing) {
      throw new Error(
        `project kinds '${sharing.kind}' and '${module.kind}' cannot share the agent kind '${module.agentKind}'`,
      )
    }
    // The registry hands a module only bodies its own `parseOutcome` produced, so the body type
    // is erased here and holds by construction.
    this.byKind.set(module.kind, module as unknown as ProjectKindModule<unknown>)
  }

  get(kind: string): ProjectKindModule<unknown> | undefined {
    return this.byKind.get(kind)
  }

  /** The module whose tasks dispatch `agentKind`, if any. */
  forAgentKind(agentKind: string): ProjectKindModule<unknown> | undefined {
    return [...this.byKind.values()].find((m) => m.agentKind === agentKind)
  }

  all(): ProjectKindModule<unknown>[] {
    return [...this.byKind.values()]
  }
}
