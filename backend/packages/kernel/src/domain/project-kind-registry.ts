import {
  parseProjectKindDescriptor,
  type ProjectKindDescriptor,
  type ProjectKindTaskType,
  type TaskType,
} from '@cat-factory/contracts'
import { ProjectDefinitionRegistry } from './project-definition-registry.js'
import { ProjectKindModuleRegistry } from './project-kind-module.js'
import { RESEARCH_PROJECT_KIND, researchKindModule } from './research-kind.js'

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
 * A registry holding the platform's built-in kind. A deployment that adds kinds of its own
 * registers them on this instance; one that wants none of the built-ins news a bare registry.
 */
export function defaultProjectKindRegistry(): ProjectKindRegistry {
  const registry = new ProjectKindRegistry()
  registry.register(RESEARCH_PROJECT_KIND)
  return registry
}

/**
 * The modules of the platform's built-in kinds. A deployment adding a kind registers its module on
 * this instance, beside the kind's descriptor on the {@link defaultProjectKindRegistry} one.
 */
export function defaultProjectKindModuleRegistry(): ProjectKindModuleRegistry {
  const registry = new ProjectKindModuleRegistry()
  registry.register(researchKindModule)
  return registry
}

/**
 * An empty definition registry that validates the built-in kinds' definitions. A deployment with
 * kinds of its own passes their modules instead: `new ProjectDefinitionRegistry(modules.all())`.
 */
export function defaultProjectDefinitionRegistry(): ProjectDefinitionRegistry {
  return new ProjectDefinitionRegistry(defaultProjectKindModuleRegistry().all())
}

/** The entry a kind declares for `taskType`, or undefined when the kind does not offer it. */
export function projectKindTaskType(
  kind: ProjectKindDescriptor,
  taskType: TaskType,
): ProjectKindTaskType | undefined {
  return kind.taskTypes.find((entry) => entry.taskType === taskType)
}
