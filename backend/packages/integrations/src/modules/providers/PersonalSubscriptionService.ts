import type {
  Clock,
  IdGenerator,
  PersonalSecretCipher,
  PersonalSubscriptionRecord,
  PersonalSubscriptionRepository,
  SecretCipher,
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { CredentialRequiredError, isIndividualVendor, ValidationError } from '@cat-factory/kernel'
import type {
  PersonalSubscriptionStatus,
  StorePersonalSubscriptionInput,
} from '@cat-factory/contracts'

// PersonalSubscriptionService: owns each USER's individual-usage subscription
// credentials (Claude / GLM / Codex) — the per-user analogue of the per-workspace
// ProviderSubscriptionService pool. The credential is stored DOUBLE-encrypted
// (`secretCipher.encrypt(personalCipher.seal(token, password))`), so it cannot be
// recovered without BOTH the system key AND the user's personal password. To let
// asynchronous container steps use it without the user present, the user supplies
// their password at task start/retry to mint a short-lived, per-run ACTIVATION
// (the token re-encrypted with the system key only), which the run's steps lease.
//
// See docs/individual-subscription-usage.md for the full model + safeguards.

/**
 * Default per-run activation lifetime (~12h). This bounds the window in which the
 * raw token is recoverable with the SYSTEM key alone (the activation has no password
 * layer), so it is kept deliberately short. It does NOT need to cover a long run: a
 * healthy run deletes its activation the moment it finishes, and any run a user keeps
 * tending transparently RE-MINTS the activation on each interaction (resolve/approve/
 * retry) from the password cached client-side — so the user is only re-prompted once
 * that cache lapses, never because the activation TTL did. 12h is simply long enough to
 * cover a fully-autonomous run (no human touch-points to re-mint at) while keeping the
 * stuck/abandoned-run exposure window an order of magnitude tighter than a week.
 */
export const DEFAULT_ACTIVATION_TTL_MS = 12 * 60 * 60 * 1000
/** Surface "renew your subscription" once it expires within this horizon (~7 days). */
export const DEFAULT_RENEW_WARNING_MS = 7 * 24 * 60 * 60 * 1000

export interface PersonalSubscriptionServiceDependencies {
  personalSubscriptionRepository: PersonalSubscriptionRepository
  subscriptionActivationRepository: SubscriptionActivationRepository
  /** System encryption layer (master key); applied OUTSIDE the password layer. */
  secretCipher: SecretCipher
  /** Password-derived encryption layer; the password is never stored. */
  personalCipher: PersonalSecretCipher
  idGenerator: IdGenerator
  clock: Clock
  activationTtlMs?: number
  renewWarningMs?: number
}

/** A leased personal credential for a run step — the decrypted raw token. */
export interface LeasedPersonalToken {
  vendor: SubscriptionVendor
  secret: string
}

export class PersonalSubscriptionService {
  constructor(private readonly deps: PersonalSubscriptionServiceDependencies) {}

  private get activationTtlMs(): number {
    return this.deps.activationTtlMs ?? DEFAULT_ACTIVATION_TTL_MS
  }
  private get renewWarningMs(): number {
    return this.deps.renewWarningMs ?? DEFAULT_RENEW_WARNING_MS
  }

  private assertIndividual(vendor: SubscriptionVendor): void {
    if (!isIndividualVendor(vendor)) {
      throw new CredentialRequiredError(
        `Vendor '${vendor}' is not an individual-usage subscription; use the workspace credential pool instead.`,
        { vendor, reason: 'no_subscription' },
      )
    }
  }

  /** Store (or replace) the user's personal credential for an individual-usage vendor. */
  async store(
    userId: string,
    input: StorePersonalSubscriptionInput,
  ): Promise<PersonalSubscriptionStatus> {
    this.assertIndividual(input.vendor)
    await this.assertSamePasswordAsOthers(userId, input.vendor, input.password)
    const sealed = await this.deps.personalCipher.seal(input.token, input.password)
    const tokenCipher = await this.deps.secretCipher.encrypt(sealed)
    const now = this.deps.clock.now()
    const existing = await this.deps.personalSubscriptionRepository.getByUserVendor(
      userId,
      input.vendor,
    )
    const record: PersonalSubscriptionRecord = {
      id: existing?.id ?? this.deps.idGenerator.next('psub'),
      userId,
      vendor: input.vendor,
      label: input.label,
      tokenCipher,
      expiresAt: input.expiresAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      deletedAt: null,
    }
    await this.deps.personalSubscriptionRepository.upsert(record)
    return this.toStatus(record, now)
  }

  /**
   * Enforce ONE personal password across all of a user's individual-usage subscriptions.
   * The run gate unlocks every vendor a single run touches with the SAME password (and the
   * client caches just one), so a second credential sealed under a different password would
   * be silently un-unlockable in any run that uses both. Rather than let that latent
   * dead-end ship, we verify the new password decrypts an existing (non-expired) credential
   * and reject up-front otherwise. No-op for the user's first credential. The check unlocks
   * an arbitrary existing credential purely to compare the password — nothing is persisted.
   */
  private async assertSamePasswordAsOthers(
    userId: string,
    vendor: SubscriptionVendor,
    password: string,
  ): Promise<void> {
    const now = this.deps.clock.now()
    const other = (await this.deps.personalSubscriptionRepository.listByUser(userId)).find(
      (r) => r.vendor !== vendor && (r.expiresAt === null || r.expiresAt > now),
    )
    if (!other) return
    const sealed = await this.deps.secretCipher.decrypt(other.tokenCipher)
    try {
      await this.deps.personalCipher.open(sealed, password)
    } catch {
      throw new ValidationError(
        `This personal password doesn't match your other connected subscription(s). Use the ` +
          `same personal password for all of them — one run unlocks every individual-usage ` +
          `vendor it touches with a single password — or remove the others first.`,
      )
    }
  }

  /** Every personal subscription the user has, metadata only (never the secret). */
  async list(userId: string): Promise<PersonalSubscriptionStatus[]> {
    const now = this.deps.clock.now()
    const rows = await this.deps.personalSubscriptionRepository.listByUser(userId)
    return rows.map((r) => this.toStatus(r, now))
  }

  /** Whether the user has a live personal credential for the vendor. */
  async has(userId: string, vendor: SubscriptionVendor): Promise<boolean> {
    return (await this.deps.personalSubscriptionRepository.getByUserVendor(userId, vendor)) !== null
  }

  /** Remove the user's personal credential for a vendor. */
  async remove(userId: string, vendor: SubscriptionVendor): Promise<void> {
    await this.deps.personalSubscriptionRepository.softDelete(userId, vendor, this.deps.clock.now())
  }

  /**
   * Decrypt the user's credential with their password, returning the raw token.
   * Throws a {@link CredentialRequiredError} when there's no credential, the
   * subscription has lapsed, or the password is wrong. Does NOT persist anything.
   */
  async unlock(userId: string, vendor: SubscriptionVendor, password: string): Promise<string> {
    const record = await this.deps.personalSubscriptionRepository.getByUserVendor(userId, vendor)
    if (!record) {
      throw new CredentialRequiredError(
        `No personal ${vendor} subscription is connected for this user.`,
        { vendor, reason: 'no_subscription' },
      )
    }
    const now = this.deps.clock.now()
    if (record.expiresAt !== null && record.expiresAt <= now) {
      throw new CredentialRequiredError(
        `Your ${vendor} subscription expired; renew it before starting runs that use it.`,
        { vendor, reason: 'subscription_expired' },
      )
    }
    const sealed = await this.deps.secretCipher.decrypt(record.tokenCipher)
    try {
      return await this.deps.personalCipher.open(sealed, password)
    } catch {
      // Any failure opening the inner (password-derived) envelope is attributed to a wrong
      // password: for this layer that is the only realistically reachable cause — the GCM
      // auth tag can't be reproduced without the right password, and the outer system cipher
      // (line above) already validated the stored envelope's structure before this point, so
      // a malformed/corrupt inner envelope is near-unreachable. The residual corruption case
      // is still covered by the shared "remove and re-add" remedy. The `wrong_password`
      // reason drives the SPA's password re-prompt (428); keep the surfaced text clean and
      // self-sufficient rather than nesting the raw cipher message.
      throw new CredentialRequiredError(
        `The personal password you entered does not unlock your ${vendor} subscription. ` +
          `Re-enter it, or remove and re-add the subscription.`,
        { vendor, reason: 'wrong_password' },
      )
    }
  }

  /**
   * Mint a per-run activation: unlock the credential with the password, re-encrypt the
   * raw token with the system key only, and store it scoped to the run with a TTL so
   * every (async) step of that run can use it without the password. Idempotent —
   * replaces any prior activation for the run+user+vendor.
   */
  async activateForRun(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    password: string,
  ): Promise<void> {
    const token = await this.unlock(userId, vendor, password)
    const now = this.deps.clock.now()
    const tokenCipher = await this.deps.secretCipher.encrypt(token)
    const record: SubscriptionActivationRecord = {
      id: this.deps.idGenerator.next('act'),
      executionId,
      userId,
      vendor,
      tokenCipher,
      createdAt: now,
      expiresAt: now + this.activationTtlMs,
    }
    await this.deps.subscriptionActivationRepository.upsert(record)
    await this.deps.personalSubscriptionRepository.markUsed(userId, vendor, now)
  }

  /**
   * Lease the run's activated token for a step. Throws a {@link CredentialRequiredError}
   * (`password_required`) when the run has no live activation — the dispatch path turns
   * that into a clear, retriable failure (the user re-enters their password on retry).
   */
  async leaseForRun(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ): Promise<LeasedPersonalToken> {
    const now = this.deps.clock.now()
    const activation = await this.deps.subscriptionActivationRepository.get(
      executionId,
      userId,
      vendor,
      now,
    )
    if (!activation) {
      throw new CredentialRequiredError(
        `This run has no active ${vendor} credential; re-enter your personal password to continue.`,
        { vendor, reason: 'password_required' },
      )
    }
    const secret = await this.deps.secretCipher.decrypt(activation.tokenCipher)
    return { vendor, secret }
  }

  /** Whether the run currently has a live activation for the user+vendor. */
  async hasActivation(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ): Promise<boolean> {
    return (
      (await this.deps.subscriptionActivationRepository.get(
        executionId,
        userId,
        vendor,
        this.deps.clock.now(),
      )) !== null
    )
  }

  /** Delete every activation for a finished run (called when a run terminates). */
  async clearRun(executionId: string): Promise<void> {
    await this.deps.subscriptionActivationRepository.deleteByExecution(executionId)
  }

  /** Delete activations whose TTL has passed. Returns the count (for the sweep log). */
  async sweepExpiredActivations(): Promise<number> {
    return this.deps.subscriptionActivationRepository.deleteExpired(this.deps.clock.now())
  }

  /** Live subscriptions expiring within the renewal-warning horizon (for the nudge sweep). */
  async expiringSubscriptions(): Promise<PersonalSubscriptionRecord[]> {
    const now = this.deps.clock.now()
    return this.deps.personalSubscriptionRepository.listExpiring(now, now + this.renewWarningMs)
  }

  private toStatus(record: PersonalSubscriptionRecord, now: number): PersonalSubscriptionStatus {
    const expiresInDays =
      record.expiresAt === null
        ? null
        : Math.floor((record.expiresAt - now) / (24 * 60 * 60 * 1000))
    return {
      vendor: record.vendor,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
      expiresInDays,
      expired: record.expiresAt !== null && record.expiresAt <= now,
      renewSoon: record.expiresAt !== null && record.expiresAt <= now + this.renewWarningMs,
    }
  }
}
