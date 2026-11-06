import type { ResearchDefinition } from '@cat-factory/contracts'
import {
  researchDefinitionContentHash,
  type ResearchDefinitionRegistry,
} from '../domain/research-definition-registry.js'
import type { ResearchDefinitionRepository } from './research-repositories.js'

/** A definition as a project pins it: its body, its content hash, and where it came from. */
export interface ResolvedResearchDefinition {
  definition: ResearchDefinition
  contentHash: string
  origin: 'registered' | 'stored'
}

/**
 * Where the definitions a deployment registers in CODE are read from. A run resolves them, so in
 * mothership mode the mothership owns them and a node reads them over the machine API. A read
 * failure THROWS rather than answering with none: "the mothership is unreachable" and "this
 * deployment registers no definitions" are the same value and opposite facts.
 */
export interface RegisteredResearchDefinitionSource {
  all(): Promise<ResearchDefinition[]>
}

/** The in-process source: this deployment's own registry. */
export function registryResearchDefinitionSource(
  registry: ResearchDefinitionRegistry,
): RegisteredResearchDefinitionSource {
  return { all: async () => registry.all() }
}

/** The one read of research definitions: the registered ones and an account's stored ones. */
export interface ResearchDefinitionSource {
  get(accountId: string, key: string, version: number): Promise<ResolvedResearchDefinition | null>
  /** The highest version of `key` the account can pin. */
  latest(accountId: string, key: string): Promise<ResolvedResearchDefinition | null>
  /** Every version the account can pin, registered first. */
  list(accountId: string): Promise<ResolvedResearchDefinition[]>
}

/**
 * Compose the registered definitions with an account's stored ones. The two key spaces never
 * overlap (a stored key carries the account's namespace and a publish naming a registered key is
 * refused), so a key resolves from exactly one of them.
 */
export function composeResearchDefinitionSource(deps: {
  registered: RegisteredResearchDefinitionSource
  stored?: ResearchDefinitionRepository
}): ResearchDefinitionSource {
  const registered = async (key?: string): Promise<ResolvedResearchDefinition[]> => {
    const all = await deps.registered.all()
    const matching = key === undefined ? all : all.filter((d) => d.key === key)
    return Promise.all(
      matching.map(async (definition) => ({
        definition,
        contentHash: await researchDefinitionContentHash(definition),
        origin: 'registered' as const,
      })),
    )
  }
  const stored = async (accountId: string): Promise<ResolvedResearchDefinition[]> =>
    ((await deps.stored?.listByAccount(accountId)) ?? []).map((row) => ({
      definition: row.definition,
      contentHash: row.contentHash,
      origin: 'stored' as const,
    }))
  const versionsOf = async (accountId: string, key: string) => {
    const fromCode = await registered(key)
    if (fromCode.length > 0) return fromCode
    return (await stored(accountId)).filter((d) => d.definition.key === key)
  }
  return {
    async get(accountId, key, version) {
      const versions = await versionsOf(accountId, key)
      return versions.find((d) => d.definition.version === version) ?? null
    },
    async latest(accountId, key) {
      const versions = await versionsOf(accountId, key)
      return versions.reduce<ResolvedResearchDefinition | null>(
        (best, d) => (!best || d.definition.version > best.definition.version ? d : best),
        null,
      )
    },
    async list(accountId) {
      return [...(await registered()), ...(await stored(accountId))]
    },
  }
}
