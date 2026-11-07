import {
  parseProjectKindDescriptor,
  type ProjectKindDescriptor,
  type ProjectKindTaskType,
  type TaskType,
} from '@cat-factory/contracts'

// App-owned registry of project kinds, beside the task-type and pipeline registries. The
// composition root news one and a deployment registers its kinds on it by reference. A kind
// declares the task types its projects offer, so task admission under a project reads it.

export class ProjectKindRegistry {
  private readonly kinds = new Map<string, ProjectKindDescriptor>()

  /** Register a kind. Throws on an invalid descriptor; a repeated id replaces the earlier one. */
  register(input: ProjectKindDescriptor): void {
    const parsed = parseProjectKindDescriptor(input)
    if (!parsed.ok) throw new Error(`invalid project kind: ${parsed.issues.join('; ')}`)
    this.kinds.set(parsed.kind.id, parsed.kind)
  }

  get(id: string): ProjectKindDescriptor | undefined {
    return this.kinds.get(id)
  }

  /** Every registered kind, in registration order. */
  all(): ProjectKindDescriptor[] {
    return [...this.kinds.values()]
  }
}

/**
 * The project kind the platform ships: a RESEARCH project pins a research definition and runs
 * `research` tasks that read its linked services' repos and write nothing to any of them.
 */
export const RESEARCH_PROJECT_KIND: ProjectKindDescriptor = {
  id: 'research',
  label: 'Research',
  description: 'Research a vendor or system against a research definition and keep the findings.',
  data: 'research',
  taskTypes: [
    { taskType: 'research', repoAccess: 'linked-read-only', defaultPipelineId: 'pl_research' },
  ],
}

/**
 * A registry holding the platform's built-in kind. A deployment that adds kinds of its own
 * registers them on this instance; one that wants none of the built-ins news a bare registry.
 */
export function defaultProjectKindRegistry(): ProjectKindRegistry {
  const registry = new ProjectKindRegistry()
  registry.register(RESEARCH_PROJECT_KIND)
  return registry
}

/** The entry a kind declares for `taskType`, or undefined when the kind does not offer it. */
export function projectKindTaskType(
  kind: ProjectKindDescriptor,
  taskType: TaskType,
): ProjectKindTaskType | undefined {
  return kind.taskTypes.find((entry) => entry.taskType === taskType)
}
