import {
  parseResearchDefinition,
  type ResearchDefinition,
  type ResearchDefinitionInput,
} from '@cat-factory/contracts'
import { sha256HexOfString } from '../shared/sha256.logic.js'

// App-owned registry of research definitions a DEPLOYMENT ships in code, beside the stored
// definitions an account publishes through the API. A registered definition is validated at
// registration, so a malformed one fails the deployment's boot rather than a research run.

/**
 * A registered definition is held immutable by nothing but the deployment's code, so a project
 * pinned to one also records this hash. A dispatch whose registered body no longer hashes to it
 * refuses rather than running a question list the project never agreed to.
 */
export function researchDefinitionContentHash(definition: ResearchDefinition): Promise<string> {
  return sha256HexOfString(canonicalJson(definition))
}

/** JSON with object keys sorted at every depth, so equal content always hashes equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    const record = inner as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}

export class ResearchDefinitionRegistry {
  private readonly byKey = new Map<string, Map<number, ResearchDefinition>>()

  /**
   * Register one version. Throws on an invalid definition, or on a key and version already
   * registered with different content: a version names one question list forever.
   */
  register(input: ResearchDefinitionInput): void {
    const parsed = parseResearchDefinition(input)
    if (!parsed.ok) {
      throw new Error(`invalid research definition: ${parsed.issues.join('; ')}`)
    }
    const definition = parsed.definition
    const versions = this.byKey.get(definition.key) ?? new Map<number, ResearchDefinition>()
    const existing = versions.get(definition.version)
    if (existing && canonicalJson(existing) !== canonicalJson(definition)) {
      throw new Error(
        `research definition ${definition.key} v${definition.version} is already registered with different content; publish a new version instead`,
      )
    }
    versions.set(definition.version, definition)
    this.byKey.set(definition.key, versions)
  }

  registerAll(inputs: Iterable<ResearchDefinitionInput>): void {
    for (const input of inputs) this.register(input)
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  get(key: string, version: number): ResearchDefinition | undefined {
    return this.byKey.get(key)?.get(version)
  }

  /** The highest registered version of `key`. */
  latest(key: string): ResearchDefinition | undefined {
    const versions = this.byKey.get(key)
    if (!versions) return undefined
    return versions.get(Math.max(...versions.keys()))
  }

  /** Every registered version, keys in registration order and versions ascending. */
  all(): ResearchDefinition[] {
    return [...this.byKey.values()].flatMap((versions) =>
      [...versions.values()].sort((a, b) => a.version - b.version),
    )
  }
}
