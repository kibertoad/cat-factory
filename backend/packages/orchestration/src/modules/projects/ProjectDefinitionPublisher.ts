import { projectDefinitionNamespace } from '@cat-factory/contracts'
import {
  type Clock,
  ConflictError,
  type ProjectDefinitionRepository,
  type ProjectKindModuleRegistry,
  type RegisteredProjectDefinitionSource,
  type StoredProjectDefinition,
  ValidationError,
  projectDefinitionContentHash,
  validateProjectDefinition,
} from '@cat-factory/kernel'

export interface ProjectDefinitionPublisherDeps {
  registered: RegisteredProjectDefinitionSource
  repository: ProjectDefinitionRepository
  modules: ProjectKindModuleRegistry
  clock: Clock
}

/**
 * Publishes the project definitions an account authors through the API, for every kind. The
 * envelope is the platform's to check and the `spec` its kind's module's, so a kind with no
 * module in this process cannot be published to. A version is immutable, so a project pinned to it
 * never changes meaning underneath. A stored definition may not take a namespace the deployment's
 * registered definitions of the same kind use, so a kind and key always resolve from exactly one
 * side. Its credential keys resolve from the credential store only; a key the deployment reserves
 * for its own configuration is already refused by the credential key schema.
 */
export class ProjectDefinitionPublisher {
  constructor(private readonly deps: ProjectDefinitionPublisherDeps) {}

  async publish(accountId: string, input: unknown): Promise<StoredProjectDefinition> {
    const parsed = validateProjectDefinition(input, (kind) => this.deps.modules.get(kind))
    if (!parsed.ok) {
      throw new ValidationError('The project definition is invalid', {
        reason: 'project_definition_invalid',
        problems: parsed.issues,
      })
    }
    const definition = parsed.value
    const namespace = projectDefinitionNamespace(definition.key)
    const registered = await this.deps.registered.all()
    if (
      registered.some(
        (d) => d.kind === definition.kind && projectDefinitionNamespace(d.key) === namespace,
      )
    ) {
      throw new ConflictError(
        `The namespace '${namespace}' belongs to ${definition.kind} definitions this deployment ships`,
        'project_definition_key_registered',
        { kind: definition.kind, namespace },
      )
    }
    const stored: StoredProjectDefinition = {
      accountId,
      definition,
      contentHash: await projectDefinitionContentHash(definition),
      createdAt: this.deps.clock.now(),
    }
    if (!(await this.deps.repository.insert(stored))) {
      throw new ConflictError(
        `${definition.kind} definition ${definition.key} v${definition.version} is already published`,
        'project_definition_version_exists',
        { kind: definition.kind, key: definition.key, version: definition.version },
      )
    }
    return stored
  }
}
