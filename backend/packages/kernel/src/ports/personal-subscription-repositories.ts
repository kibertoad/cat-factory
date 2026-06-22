import type { SubscriptionVendor } from './provider-subscription-repositories.js'

// Persistence ports for INDIVIDUAL-usage subscriptions (currently Claude). Unlike
// the per-workspace pool (provider-subscription-repositories), these are scoped to a
// single USER and never pooled or rotated: a personal subscription is licensed for
// that individual only.
//
// Two records back the flow:
//   1. PersonalSubscriptionRecord — the credential at rest, DOUBLE-encrypted
//      (sealed under a password-derived key, then the system SecretCipher). The
//      server can never decrypt it without the user's password.
//   2. SubscriptionActivationRecord — a short-lived, per-run copy re-encrypted with
//      the SYSTEM key only, minted when the user supplies their password at task
//      start/retry, so the asynchronous container steps of that one run can use the
//      token without the user present. Deleted when the run finishes.
//
// Both runtimes (Cloudflare D1 + Node/local Postgres) implement these so the
// behaviour is identical everywhere.

/**
 * A user's personal subscription credential at rest. `tokenCipher` is the
 * double-encrypted envelope: `system.encrypt(personal.seal(rawToken, password))`.
 * `expiresAt` is the subscription's own end date (for renewal warnings + a hard
 * block once lapsed), distinct from an activation's short TTL.
 */
export interface PersonalSubscriptionRecord {
  id: string
  /** Internal user id (`usr_*`) of the owner. */
  userId: string
  vendor: SubscriptionVendor
  label: string
  /** Double-encrypted credential (password layer inside the system layer). */
  tokenCipher: string
  /** Subscription's own expiry (null = no fixed end date). */
  expiresAt: number | null
  createdAt: number
  updatedAt: number
  /** When a run last activated this credential (null = never). */
  lastUsedAt: number | null
  /** Tombstone when the user removes it. */
  deletedAt: number | null
}

export interface PersonalSubscriptionRepository {
  /** The user's live credential for a vendor, or null. */
  getByUserVendor(
    userId: string,
    vendor: SubscriptionVendor,
  ): Promise<PersonalSubscriptionRecord | null>
  /** Every live credential the user owns (metadata for the status surface). */
  listByUser(userId: string): Promise<PersonalSubscriptionRecord[]>
  /** Insert or replace the user's credential for a vendor (one per user+vendor). */
  upsert(record: PersonalSubscriptionRecord): Promise<void>
  /** Stamp `lastUsedAt` when a run activates the credential. */
  markUsed(userId: string, vendor: SubscriptionVendor, at: number): Promise<void>
  /** Tombstone the user's credential for a vendor. */
  softDelete(userId: string, vendor: SubscriptionVendor, at: number): Promise<void>
  /**
   * Live credentials whose subscription `expiresAt` is at/after `now` but at/before
   * `before` (the advance-warning horizon) — the renewal-nudge sweep reads these.
   * Excludes ones with no expiry.
   */
  listExpiring(now: number, before: number): Promise<PersonalSubscriptionRecord[]>
}

/**
 * A per-run, system-key-only activation of a personal credential. Scoped to one
 * execution (`executionId`) + its owner; `tokenCipher` is `system.encrypt(rawToken)`
 * so the durable driver/executor can decrypt it for every step of that run without
 * the password. `expiresAt` is the activation TTL (longer than a run normally needs,
 * refreshed on user interaction, and the row is deleted when the run completes).
 */
export interface SubscriptionActivationRecord {
  id: string
  executionId: string
  userId: string
  vendor: SubscriptionVendor
  /** System-key-only ciphertext of the raw token. */
  tokenCipher: string
  createdAt: number
  expiresAt: number
}

export interface SubscriptionActivationRepository {
  /** The live (unexpired) activation for a run+user+vendor, or null. */
  get(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    now: number,
  ): Promise<SubscriptionActivationRecord | null>
  /** Create or replace the activation for a run+user+vendor. */
  upsert(record: SubscriptionActivationRecord): Promise<void>
  /** Extend an existing activation's TTL (refresh on interaction). No-op if absent. */
  refresh(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    expiresAt: number,
  ): Promise<void>
  /** Delete every activation for a finished run. */
  deleteByExecution(executionId: string): Promise<void>
  /** Delete activations whose TTL has passed (the expiry sweep). Returns the count. */
  deleteExpired(now: number): Promise<number>
}
