import type { ProjectDefinition } from '@cat-factory/contracts'
import {
  projectDefinitionContentHash,
  type ProjectDefinitionRegistry,
} from '../domain/project-definition-registry.js'
import type {
  ProjectDefinitionRepository,
  StoredProjectDefinition,
} from './project-outcome-repositories.js'

/** A definition as a project pins it: its body, its content hash, and where it came from. */
export interface ResolvedProjectDefinition {
  definition: ProjectDefinition
  contentHash: string
  origin: 'registered' | 'stored'
}

/**
 * Where the definitions a deployment registers in CODE are read from, every kind's at once. A
 * run resolves them, so in mothership mode the mothership owns them and a node reads them over
 * the machine API. A read failure THROWS rather than answering with none: "the mothership is
 * unreachable" and "this deployment registers no definitions" are the same value and opposite
 * facts.
 */
export interface RegisteredProjectDefinitionSource {
  all(): Promise<ProjectDefinition[]>
}

/** The in-process source: this deployment's own registry. */
export function registryProjectDefinitionSource(
  registry: ProjectDefinitionRegistry,
): RegisteredProjectDefinitionSource {
  return { all: async () => registry.all() }
}

/** The one read of project definitions: the registered ones and an account's stored ones. */
export interface ProjectDefinitionSource {
  get(
    accountId: string,
    kind: string,
    key: string,
    version: number,
  ): Promise<ResolvedProjectDefinition | null>
  /** The highest version of `key` for `kind` the account can pin. */
  latest(accountId: string, kind: string, key: string): Promise<ResolvedProjectDefinition | null>
  /** Every version of `kind` the account can pin, registered first. */
  list(accountId: string, kind: string): Promise<ResolvedProjectDefinition[]>
}

/**
 * Compose the registered definitions with an account's stored ones. The two key spaces never
 * overlap within a kind (a stored key carries the account's namespace and a publish naming a
 * registered key is refused), so a kind and key resolve from exactly one of them.
 */
export function composeProjectDefinitionSource(deps: {
  registered: RegisteredProjectDefinitionSource
  stored?: ProjectDefinitionRepository
}): ProjectDefinitionSource {
  const registered = async (kind: string, key?: string): Promise<ResolvedProjectDefinition[]> => {
    const matching = (await deps.registered.all()).filter(
      (d) => d.kind === kind && (key === undefined || d.key === key),
    )
    return Promise.all(
      matching.map(async (definition) => ({
        definition,
        contentHash: await projectDefinitionContentHash(definition),
        origin: 'registered' as const,
      })),
    )
  }
  const fromStore = (row: StoredProjectDefinition): ResolvedProjectDefinition => ({
    definition: row.definition,
    contentHash: row.contentHash,
    origin: 'stored',
  })
  const stored = async (accountId: string, kind: string): Promise<ResolvedProjectDefinition[]> =>
    ((await deps.stored?.listByAccount(accountId, kind)) ?? []).map(fromStore)
  const versionsOf = async (accountId: string, kind: string, key: string) => {
    const fromCode = await registered(kind, key)
    if (fromCode.length > 0) return fromCode
    return (await stored(accountId, kind)).filter((d) => d.definition.key === key)
  }
  return {
    async get(accountId, kind, key, version) {
      const fromCode = await registered(kind, key)
      if (fromCode.length > 0) {
        return fromCode.find((d) => d.definition.version === version) ?? null
      }
      const row = await deps.stored?.get(accountId, kind, key, version)
      return row ? fromStore(row) : null
    },
    async latest(accountId, kind, key) {
      const versions = await versionsOf(accountId, kind, key)
      return versions.reduce<ResolvedProjectDefinition | null>(
        (best, d) => (!best || d.definition.version > best.definition.version ? d : best),
        null,
      )
    },
    async list(accountId, kind) {
      return [...(await registered(kind)), ...(await stored(accountId, kind))]
    },
  }
}
