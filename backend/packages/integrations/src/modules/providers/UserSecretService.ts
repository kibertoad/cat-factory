import type {
  Clock,
  ConnectionTestResult,
  SecretCipher,
  UserSecretKind,
  UserSecretRecord,
  UserSecretRepository,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type {
  StoreUserSecretInput,
  TestUserSecretInput,
  UserSecretDescriptor,
  UserSecretStatus,
} from '@cat-factory/contracts'
import { defaultUserSecretKindRegistry, type UserSecretKindRegistry } from './userSecretKinds.js'

// UserSecretService: owns each USER's generic, kind-discriminated secrets (a GitHub
// PAT today; future repository/provider tokens as new kinds). Single system-cipher
// (no personal-password layer), so any server process can resolve the secret from the
// user id at run time — the basis for `ResolveUserGitHubToken`. The secret is never
// returned to the SPA; only status metadata + a `hasSecret` flag.

export interface UserSecretServiceDependencies {
  userSecretRepository: UserSecretRepository
  secretCipher: SecretCipher
  clock: Clock
  /** Injected for tests; defaults to the global fetch (used by kind testConnection). */
  fetch?: typeof fetch
  /**
   * The app-owned registry of secret KINDS (fields + connection test per kind). Absent ⇒
   * a fresh registry with just the built-in `github_pat` kind
   * (`defaultUserSecretKindRegistry()`). A facade builds it via `createBackendRegistries()`
   * and registers any custom kinds by reference before injecting it here.
   */
  userSecretKindRegistry?: UserSecretKindRegistry
}

export class UserSecretService {
  private readonly kinds: UserSecretKindRegistry

  constructor(private readonly deps: UserSecretServiceDependencies) {
    this.kinds = deps.userSecretKindRegistry ?? defaultUserSecretKindRegistry()
  }

  /** Every secret the user has stored (metadata only, never the secret value). */
  async list(userId: string): Promise<UserSecretStatus[]> {
    const rows = await this.deps.userSecretRepository.listByUser(userId)
    return rows.map((r) => toStatus(r))
  }

  /** The user's stored secret of a kind (status only), or null. */
  async get(userId: string, kind: UserSecretKind): Promise<UserSecretStatus | null> {
    const row = await this.deps.userSecretRepository.getByUserKind(userId, kind)
    return row ? toStatus(row) : null
  }

  /** Create or replace the user's secret of a kind. */
  async store(
    userId: string,
    kind: UserSecretKind,
    input: StoreUserSecretInput,
  ): Promise<UserSecretStatus> {
    const handler = this.kinds.get(kind)
    if (!handler) throw new ValidationError(`Unknown secret kind '${kind}'`)
    const now = this.deps.clock.now()
    const existing = await this.deps.userSecretRepository.getByUserKind(userId, kind)
    const metadata = input.metadata && Object.keys(input.metadata).length ? input.metadata : null
    const record: UserSecretRecord = {
      userId,
      kind,
      label: input.label?.trim() || handler.label,
      secretCipher: await this.deps.secretCipher.encrypt(input.secret),
      metadataJson: metadata ? JSON.stringify(metadata) : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.userSecretRepository.upsert(record)
    return toStatus(record)
  }

  /** Remove the user's secret of a kind. */
  async remove(userId: string, kind: UserSecretKind): Promise<void> {
    await this.deps.userSecretRepository.remove(userId, kind)
  }

  /**
   * Resolve a user's decrypted secret for a kind (the run-time path), or null when
   * they have none. `ResolveUserGitHubToken` is `(userId) => resolve(userId, 'github_pat')`.
   */
  async resolve(userId: string, kind: UserSecretKind): Promise<string | null> {
    const row = await this.deps.userSecretRepository.getByUserKind(userId, kind)
    if (!row) return null
    return this.deps.secretCipher.decrypt(row.secretCipher)
  }

  /** A kind's self-description for the generic connect form. */
  describe(kind: UserSecretKind): UserSecretDescriptor | null {
    const handler = this.kinds.get(kind)
    if (!handler) return null
    return {
      kind: handler.kind,
      label: handler.label,
      configFields: handler.configFields,
      supportsTest: typeof handler.testConnection === 'function',
    }
  }

  /** Every registered kind's descriptor (for rendering the available connect forms). */
  describeAll(): UserSecretDescriptor[] {
    return this.kinds.list().map((h) => ({
      kind: h.kind,
      label: h.label,
      configFields: h.configFields,
      supportsTest: typeof h.testConnection === 'function',
    }))
  }

  /** Probe a (not-yet-saved) secret + metadata for the given kind. Never throws. */
  async testConnection(
    kind: UserSecretKind,
    input: TestUserSecretInput,
  ): Promise<ConnectionTestResult> {
    const handler = this.kinds.get(kind)
    if (!handler?.testConnection)
      return { ok: true, message: 'This secret has no connection test.' }
    return handler.testConnection(
      { secret: input.secret, metadata: input.metadata },
      { fetch: this.deps.fetch ?? fetch },
    )
  }
}

function toStatus(record: UserSecretRecord): UserSecretStatus {
  const metadata = record.metadataJson
    ? (JSON.parse(record.metadataJson) as Record<string, string>)
    : undefined
  return {
    kind: record.kind,
    label: record.label,
    hasSecret: true,
    ...(metadata ? { metadata } : {}),
    connectedAt: record.createdAt,
  }
}
