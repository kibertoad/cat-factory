import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
  Clock,
  SecretCipher,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type {
  CapabilityCredentialEntry,
  CapabilityCredentialRef,
  UpsertCapabilityCredentialsInput,
} from '@cat-factory/contracts'
import {
  MAX_CAPABILITY_CREDENTIALS,
  capabilityCredentialsSummary,
  parseCapabilityCredentialEntries,
} from '@cat-factory/contracts'

/**
 * HKDF domain tag separating the sealed capability-credential blob from every other cipher
 * (mirrors {@link TEST_SECRETS_CIPHER_INFO} et al). The facade builds a `WebCryptoSecretCipher`
 * keyed by `ENCRYPTION_KEY` with this info tag.
 */
export const CAPABILITY_CREDENTIALS_CIPHER_INFO = 'cat-factory:capability-credentials'

export interface CapabilityCredentialsServiceDependencies {
  capabilityCredentialRepository: CapabilityCredentialRepository
  /** Seals the entry blob at rest (domain tag {@link CAPABILITY_CREDENTIALS_CIPHER_INFO}). */
  secretCipher: SecretCipher
  clock: Clock
}

/**
 * Owns a workspace's capability credentials: the tenant-scoped, sealed home for the secrets a
 * tool server or a generative binary integration declares by name.
 *
 * The shipped `ToolSecretResolver` read those names off the DEPLOYMENT'S OWN ENVIRONMENT, which
 * is a single-tenant answer — one process serves many workspaces, so one variable serves them
 * all: every tenant's runs authenticate as whoever set it, a tenant cannot bring its own vendor
 * account, and rotating one tenant's key is a redeploy. Every other credential in the platform
 * (provider keys, tracker/document/runner/observability connections, package registries, test
 * secrets) is already a per-tenant sealed row; this is that answer for capabilities.
 *
 * STRICTLY the store. What a deployment's capabilities DECLARE is registry state, and joining the
 * two is the controller's job (`collectDeclaredCapabilityCredentials` +
 * `buildCapabilityCredentialsView`) — this package has no business reaching into the agent-kind
 * or binary-generator registries, and the generator half must be read through
 * `BinaryGeneratorSource` rather than a registry anyway, which only the composition root can
 * supply.
 *
 * {@link resolveValues} is the one place a value is decrypted, and its result reaches nothing but
 * the job body.
 */
export class CapabilityCredentialsService {
  constructor(private readonly deps: CapabilityCredentialsServiceDependencies) {}

  /**
   * The keys this workspace has stored, with when each was written. Decrypts NOTHING: read off
   * the non-secret summary persisted beside the sealed blob, which is why that summary exists.
   */
  async listStored(workspaceId: string): Promise<CapabilityCredentialRef[]> {
    const record = await this.deps.capabilityCredentialRepository.get(workspaceId)
    return this.parseSummary(record)
  }

  /**
   * Replace a workspace's credential set. An empty set deletes the row, so a cleared form leaves
   * nothing sealed.
   *
   * A whole-set REPLACE rather than a merge, because the client cannot merge: it never received
   * the values, so a partial write would have to mean "leave the ones I did not send alone",
   * which is indistinguishable on the wire from "remove them". {@link remove} is the narrow
   * operation that would otherwise need that distinction.
   */
  async set(
    workspaceId: string,
    input: UpsertCapabilityCredentialsInput,
  ): Promise<CapabilityCredentialRef[]> {
    if (input.entries.length === 0) {
      await this.deps.capabilityCredentialRepository.delete(workspaceId)
      return []
    }
    return this.write(workspaceId, input.entries)
  }

  /**
   * Set ONE credential's value, leaving the rest sealed as they are. Replaces the value when the
   * key is already stored, appends it otherwise.
   *
   * The narrow twin of {@link remove}, and the write a checklist UI actually performs: the client
   * holds no values, so it can neither re-send the set nor express "leave the others alone"
   * through {@link set}. Same read-modify-write trade, and the same accepted consequence — two
   * operators saving different keys at the same moment costs one retyped secret, where the
   * alternative row-per-key shape costs every dispatch an N-row read.
   */
  async put(workspaceId: string, key: string, value: string): Promise<CapabilityCredentialRef[]> {
    const entries = await this.resolveValues(workspaceId)
    const existing = entries.findIndex((entry) => entry.key === key)
    if (existing === -1 && entries.length >= MAX_CAPABILITY_CREDENTIALS) {
      throw new ValidationError(
        `at most ${MAX_CAPABILITY_CREDENTIALS} capability credentials per workspace`,
        { reason: 'capability_credential_limit' },
      )
    }
    const next = [...entries]
    // Replace IN PLACE for a known key, so re-typing a value does not reorder the stored set.
    if (existing === -1) next.push({ key, value })
    else next[existing] = { key, value }
    return this.write(workspaceId, next)
  }

  /**
   * Remove ONE stored credential, leaving the rest sealed as they are.
   *
   * Re-seals the survivors rather than editing the blob in place, so this is a read-modify-write
   * and the last writer wins. That is the right trade for a form an operator edits: the
   * alternative is a row per key, and a lost update here costs one retyped secret where the N-row
   * shape costs every dispatch an N-row read.
   */
  async remove(workspaceId: string, key: string): Promise<CapabilityCredentialRef[]> {
    const entries = await this.resolveValues(workspaceId)
    const remaining = entries.filter((entry) => entry.key !== key)
    // Nothing matched: answer with the current state rather than rewriting the blob, so a
    // duplicate delete is a no-op instead of a pointless re-seal.
    if (remaining.length === entries.length) return this.listStored(workspaceId)
    if (remaining.length === 0) {
      await this.deps.capabilityCredentialRepository.delete(workspaceId)
      return []
    }
    return this.write(workspaceId, remaining)
  }

  /**
   * The DECRYPTED credential set for a workspace — read once per dispatch by the composed
   * resolver. Empty when the workspace has stored none, which is the signal that the environment
   * fallback (where a facade wired one) should answer instead.
   */
  async resolveValues(workspaceId: string): Promise<CapabilityCredentialEntry[]> {
    const record = await this.deps.capabilityCredentialRepository.get(workspaceId)
    if (!record) return []
    return parseCapabilityCredentialEntries(
      JSON.parse(await this.deps.secretCipher.decrypt(record.credentials)),
    )
  }

  private async write(
    workspaceId: string,
    entries: CapabilityCredentialEntry[],
  ): Promise<CapabilityCredentialRef[]> {
    const now = this.deps.clock.now()
    const existing = await this.deps.capabilityCredentialRepository.get(workspaceId)
    const summary = capabilityCredentialsSummary(entries, now)
    await this.deps.capabilityCredentialRepository.upsert({
      workspaceId,
      credentials: await this.deps.secretCipher.encrypt(JSON.stringify(entries)),
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return summary
  }

  /** Parse the persisted non-secret summary, tolerating a corrupt row (the view still loads). */
  private parseSummary(record: CapabilityCredentialRecord | null): CapabilityCredentialRef[] {
    if (!record) return []
    try {
      const parsed = JSON.parse(record.summary) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (entry): entry is CapabilityCredentialRef =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as CapabilityCredentialRef).key === 'string',
      )
    } catch {
      return []
    }
  }
}
