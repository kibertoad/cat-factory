import type {
  CapabilityCredentialRecord,
  CapabilityCredentialRepository,
  Clock,
  SecretCipher,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
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

/**
 * How many times a contended per-key mutation reloads and re-applies before giving up with a
 * 409. Matches `IterativeReviewService`'s budget: the contending writers here are human saves in
 * two browser tabs, so a handful of retries covers real contention while still failing loudly on
 * a pathological hot row.
 */
const MAX_MUTATE_ATTEMPTS = 8

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
 * CONCURRENCY: the row is ONE sealed blob holding the whole set, so the per-key writes
 * ({@link put}, {@link remove}) are read-modify-write over it and ride a rev-guarded
 * `compareAndSwap`: a blind upsert would let two operators saving DIFFERENT keys silently
 * destroy each other's, with the loser's save still returning success. On a lost race the
 * mutation reloads and re-applies on the winner's snapshot (it is a pure single-key edit, so
 * re-application is trivially idempotent). The whole-set {@link set} stays a blind write on
 * purpose: replacing whatever is stored IS its semantics.
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
   * which is indistinguishable on the wire from "remove them". {@link put} and {@link remove}
   * are the narrow operations that would otherwise need that distinction.
   */
  async set(
    workspaceId: string,
    input: UpsertCapabilityCredentialsInput,
  ): Promise<CapabilityCredentialRef[]> {
    if (input.entries.length === 0) {
      await this.deps.capabilityCredentialRepository.delete(workspaceId)
      return []
    }
    const now = this.deps.clock.now()
    const existing = await this.deps.capabilityCredentialRepository.get(workspaceId)
    // Every value in the set was just (re)typed, so every key is honestly stamped `now`.
    const summary = capabilityCredentialsSummary(input.entries, now)
    await this.deps.capabilityCredentialRepository.upsert({
      workspaceId,
      credentials: await this.deps.secretCipher.encrypt(JSON.stringify(input.entries)),
      summary: JSON.stringify(summary),
      // The insert value; a conflicting update bumps the STORED rev in SQL instead, so the rev
      // stays monotonic under this blind write and a concurrent compareAndSwap reliably loses.
      rev: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return summary
  }

  /**
   * Set ONE credential's value, leaving the rest sealed as they are. Replaces the value when the
   * key is already stored, appends it otherwise.
   *
   * The narrow twin of {@link remove}, and the write a checklist UI actually performs: the
   * client holds no values, so it can neither re-send the set nor express "leave the others
   * alone" through {@link set}. Rev-guarded (see the class doc), so two operators saving
   * different keys at the same moment both land.
   */
  async put(workspaceId: string, key: string, value: string): Promise<CapabilityCredentialRef[]> {
    return this.mutate(workspaceId, key, (entries) => {
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
      return next
    })
  }

  /**
   * Remove ONE stored credential, leaving the rest sealed as they are. Re-seals the survivors
   * rather than editing the blob in place, rev-guarded like {@link put}; emptying the set
   * deletes the row through the same guard, so a concurrent save's key cannot be swept away.
   */
  async remove(workspaceId: string, key: string): Promise<CapabilityCredentialRef[]> {
    return this.mutate(workspaceId, null, (entries) => {
      const remaining = entries.filter((entry) => entry.key !== key)
      // Nothing matched: answer with the current state rather than rewriting the blob, so a
      // duplicate delete is a no-op instead of a pointless re-seal.
      if (remaining.length === entries.length) return null
      return remaining
    })
  }

  /**
   * The DECRYPTED credential set for a workspace — read once per dispatch by the composed
   * resolver. Empty when the workspace has stored none, which is the signal that the environment
   * fallback (where a facade wired one) should answer instead.
   */
  async resolveValues(workspaceId: string): Promise<CapabilityCredentialEntry[]> {
    return this.decryptEntries(await this.deps.capabilityCredentialRepository.get(workspaceId))
  }

  /**
   * Apply a pure single-key mutation under OPTIMISTIC CONCURRENCY: load, run `apply`, then
   * `compareAndSwap` (or the rev-guarded delete when the set empties); on a lost race reload and
   * re-apply on the winner's snapshot, bounded by {@link MAX_MUTATE_ATTEMPTS}.
   *
   * `apply` returns the next entry set, or null for "nothing to change" (a duplicate delete),
   * which answers with the current summary untouched. `touchedKey` is the one key whose
   * `updatedAt` this write may honestly stamp: "last set" is a per-key fact, so every OTHER
   * entry keeps the timestamp the stored summary already carries. A write that re-stamped the
   * whole set would falsify every neighbour's date.
   */
  private async mutate(
    workspaceId: string,
    touchedKey: string | null,
    apply: (entries: CapabilityCredentialEntry[]) => CapabilityCredentialEntry[] | null,
  ): Promise<CapabilityCredentialRef[]> {
    const repo = this.deps.capabilityCredentialRepository
    for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt++) {
      const record = await repo.get(workspaceId)
      const next = apply(await this.decryptEntries(record))
      if (next === null) return this.parseSummary(record)
      if (next.length === 0) {
        if (!record) return []
        if (await repo.deleteIfRev(workspaceId, record.rev)) return []
        continue
      }
      const now = this.deps.clock.now()
      const prior = new Map(this.parseSummary(record).map((ref) => [ref.key, ref.updatedAt]))
      const summary = next.map((entry) => ({
        key: entry.key,
        updatedAt: entry.key === touchedKey ? now : (prior.get(entry.key) ?? now),
      }))
      const swapped = await repo.compareAndSwap(
        {
          workspaceId,
          credentials: await this.deps.secretCipher.encrypt(JSON.stringify(next)),
          summary: JSON.stringify(summary),
          rev: (record?.rev ?? -1) + 1,
          createdAt: record?.createdAt ?? now,
          updatedAt: now,
        },
        record?.rev ?? null,
      )
      if (swapped) return summary
      // Lost the race: loop back, reload, re-apply on the winner's snapshot.
    }
    // No `reason` code, same call as ReviewContendedError: the SPA has no conflict-specific
    // handling beyond "retry", which the message already says.
    throw new ConflictError(
      `capability credentials for workspace '${workspaceId}' are being modified concurrently; retry`,
    )
  }

  /** Decrypt and validate the sealed entry blob; an absent row is an empty set. */
  private async decryptEntries(
    record: CapabilityCredentialRecord | null,
  ): Promise<CapabilityCredentialEntry[]> {
    if (!record) return []
    return parseCapabilityCredentialEntries(
      JSON.parse(await this.deps.secretCipher.decrypt(record.credentials)),
    )
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
