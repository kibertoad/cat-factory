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
import {
  CredentialRequiredError,
  getErrorMessage,
  INDIVIDUAL_VENDORS,
  isIndividualVendor,
} from '@cat-factory/kernel'
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

/** Default per-run activation lifetime (~1 week): far longer than a run needs, so a
 *  user who starts a task isn't re-prompted mid-run; deleted when the run finishes. */
export const DEFAULT_ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
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
    userId: number,
    input: StorePersonalSubscriptionInput,
  ): Promise<PersonalSubscriptionStatus> {
    this.assertIndividual(input.vendor)
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

  /** Every personal subscription the user has, metadata only (never the secret). */
  async list(userId: number): Promise<PersonalSubscriptionStatus[]> {
    const now = this.deps.clock.now()
    const rows = await this.deps.personalSubscriptionRepository.listByUser(userId)
    return rows.map((r) => this.toStatus(r, now))
  }

  /** Whether the user has a live personal credential for the vendor. */
  async has(userId: number, vendor: SubscriptionVendor): Promise<boolean> {
    return (await this.deps.personalSubscriptionRepository.getByUserVendor(userId, vendor)) !== null
  }

  /** Remove the user's personal credential for a vendor. */
  async remove(userId: number, vendor: SubscriptionVendor): Promise<void> {
    await this.deps.personalSubscriptionRepository.softDelete(userId, vendor, this.deps.clock.now())
  }

  /**
   * Decrypt the user's credential with their password, returning the raw token.
   * Throws a {@link CredentialRequiredError} when there's no credential, the
   * subscription has lapsed, or the password is wrong. Does NOT persist anything.
   */
  async unlock(userId: number, vendor: SubscriptionVendor, password: string): Promise<string> {
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
    } catch (error) {
      throw new CredentialRequiredError(
        `Incorrect personal password for your ${vendor} subscription (${getErrorMessage(error)}).`,
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
    userId: number,
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
    userId: number,
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
    userId: number,
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

  /**
   * On user interaction with a run (approve/retry/etc.), extend its activation TTL when
   * it is at least half spent, so an actively-tended long run doesn't lapse. No-op when
   * the run has no activation.
   */
  async refreshActivations(executionId: string, userId: number): Promise<void> {
    const now = this.deps.clock.now()
    for (const vendor of await this.activatedVendors(executionId, userId, now)) {
      await this.deps.subscriptionActivationRepository.refresh(
        executionId,
        userId,
        vendor,
        now + this.activationTtlMs,
      )
    }
  }

  private async activatedVendors(
    executionId: string,
    userId: number,
    now: number,
  ): Promise<SubscriptionVendor[]> {
    const out: SubscriptionVendor[] = []
    // Only individual-usage vendors are ever activated; refresh those that are present
    // and at least half through their TTL. Driven off INDIVIDUAL_VENDORS (the kernel's
    // single source of truth) so a newly individual-only vendor is covered automatically.
    for (const vendor of INDIVIDUAL_VENDORS) {
      const a = await this.deps.subscriptionActivationRepository.get(
        executionId,
        userId,
        vendor,
        now,
      )
      if (a && a.expiresAt - now <= this.activationTtlMs / 2) out.push(vendor)
    }
    return out
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
