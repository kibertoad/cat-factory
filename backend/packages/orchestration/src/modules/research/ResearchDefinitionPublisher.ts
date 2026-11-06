import {
  type ResearchDefinition,
  type ResearchDefinitionInput,
  parseResearchDefinition,
  researchDefinitionNamespace,
} from '@cat-factory/contracts'
import {
  ConflictError,
  type Clock,
  type RegisteredResearchDefinitionSource,
  type ResearchDefinitionRepository,
  type StoredResearchDefinition,
  ValidationError,
  researchDefinitionContentHash,
} from '@cat-factory/kernel'

export interface ResearchDefinitionPublisherDeps {
  registered: RegisteredResearchDefinitionSource
  repository: ResearchDefinitionRepository
  clock: Clock
}

/**
 * Publishes the research definitions an account authors through the API. A version is immutable,
 * so a project pinned to it never changes meaning underneath. A stored definition may not take a
 * namespace the deployment's registered definitions use, so a key always resolves from exactly one
 * side. Its credential keys resolve from the credential store only; a key the deployment reserves
 * for its own configuration is already refused by the credential key schema.
 */
export class ResearchDefinitionPublisher {
  constructor(private readonly deps: ResearchDefinitionPublisherDeps) {}

  async publish(
    accountId: string,
    input: ResearchDefinitionInput,
  ): Promise<StoredResearchDefinition> {
    const parsed = parseResearchDefinition(input)
    if (!parsed.ok) {
      throw new ValidationError('The research definition is invalid', {
        reason: 'research_definition_invalid',
        problems: parsed.issues,
      })
    }
    const definition = parsed.definition
    await this.assertNamespaceFree(definition)
    const stored: StoredResearchDefinition = {
      accountId,
      definition,
      contentHash: await researchDefinitionContentHash(definition),
      createdAt: this.deps.clock.now(),
    }
    if (!(await this.deps.repository.insert(stored))) {
      throw new ConflictError(
        `Research definition ${definition.key} v${definition.version} is already published`,
        'research_definition_version_exists',
        { key: definition.key, version: definition.version },
      )
    }
    return stored
  }

  private async assertNamespaceFree(definition: ResearchDefinition): Promise<void> {
    const namespace = researchDefinitionNamespace(definition.key)
    const registered = await this.deps.registered.all()
    if (registered.some((d) => researchDefinitionNamespace(d.key) === namespace)) {
      throw new ConflictError(
        `The namespace '${namespace}' belongs to definitions this deployment ships`,
        'research_definition_key_registered',
        { namespace },
      )
    }
  }
}
