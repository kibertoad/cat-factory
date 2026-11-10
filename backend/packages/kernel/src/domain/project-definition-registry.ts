import {
  parseProjectDefinition,
  type ProjectDefinition,
  type ProjectDefinitionSpecValidator,
} from '@cat-factory/contracts'
import { sha256HexOfString } from '../shared/sha256.logic.js'

// App-owned registry of project definitions a DEPLOYMENT ships in code, beside the stored
// definitions an account publishes through the API. The registry validates the envelope and
// hands `spec` to the validator its kind supplies, so a malformed definition fails the
// deployment's boot rather than a run, and the platform never learns what a spec holds.

/**
 * A registered definition is held immutable by nothing but the deployment's code, so a project
 * pinned to one also records this hash. A dispatch whose registered body no longer hashes to it
 * refuses rather than running a definition the project never agreed to.
 */
export function projectDefinitionContentHash(definition: ProjectDefinition): Promise<string> {
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

const versionKey = (kind: string, key: string) => `${kind}\u0000${key}`

export class ProjectDefinitionRegistry {
  private readonly validators = new Map<string, ProjectDefinitionSpecValidator>()
  private readonly byKey = new Map<string, Map<number, ProjectDefinition>>()

  /** @param validators one per project kind whose definitions this registry may hold. */
  constructor(validators: Iterable<ProjectDefinitionSpecValidator> = []) {
    for (const validator of validators) this.validators.set(validator.kind, validator)
  }

  /**
   * Register one version. Throws on an invalid envelope, on a kind with no spec validator, on a
   * spec its kind refuses, or on a kind, key and version already registered with different
   * content: a version names one definition forever.
   */
  register(input: unknown): void {
    const definition = this.parse(input)
    const slot = versionKey(definition.kind, definition.key)
    const versions = this.byKey.get(slot) ?? new Map<number, ProjectDefinition>()
    const existing = versions.get(definition.version)
    if (existing && canonicalJson(existing) !== canonicalJson(definition)) {
      throw new Error(
        `${definition.kind} definition ${definition.key} v${definition.version} is already registered with different content; publish a new version instead`,
      )
    }
    versions.set(definition.version, definition)
    this.byKey.set(slot, versions)
  }

  registerAll(inputs: Iterable<unknown>): void {
    for (const input of inputs) this.register(input)
  }

  has(kind: string, key: string): boolean {
    return this.byKey.has(versionKey(kind, key))
  }

  get(kind: string, key: string, version: number): ProjectDefinition | undefined {
    return this.byKey.get(versionKey(kind, key))?.get(version)
  }

  /** The highest registered version of `key` for `kind`. */
  latest(kind: string, key: string): ProjectDefinition | undefined {
    const versions = this.byKey.get(versionKey(kind, key))
    if (!versions) return undefined
    return versions.get(Math.max(...versions.keys()))
  }

  /** Every registered version of `kind`, keys in registration order and versions ascending. */
  list(kind: string): ProjectDefinition[] {
    return this.all().filter((definition) => definition.kind === kind)
  }

  /** Every registered version of every kind, in the order {@link list} gives. */
  all(): ProjectDefinition[] {
    return [...this.byKey.values()].flatMap((versions) =>
      [...versions.values()].sort((a, b) => a.version - b.version),
    )
  }

  private parse(input: unknown): ProjectDefinition {
    const envelope = parseProjectDefinition(input)
    if (!envelope.ok) {
      throw new Error(`invalid project definition: ${envelope.issues.join('; ')}`)
    }
    const validator = this.validators.get(envelope.value.kind)
    if (!validator) {
      throw new Error(
        `no spec validator is registered for project kind '${envelope.value.kind}', so its definitions cannot be checked`,
      )
    }
    const spec = validator.parseSpec(envelope.value)
    if (!spec.ok) {
      throw new Error(
        `invalid ${envelope.value.kind} definition ${envelope.value.key}: ${spec.issues.join('; ')}`,
      )
    }
    return { ...envelope.value, spec: spec.value }
  }
}
