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
//   2. SubscriptionActivationRecord - a short-lived copy re-encrypted with the SYSTEM
//      key only, minted when the user supplies their password, so work that outlives
//      the request can use the token without the user present. It is keyed by an
//      ACTIVATION SCOPE ({@link ActivationScopeId}), of which a run is one kind: an
//      environment test and a run-less inline surface mint their own, and each is
//      reclaimed on its own terms.
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
  /** The activation scope this copy belongs to. See {@link ActivationScopeId}. */
  scopeId: ActivationScopeId
  userId: string
  vendor: SubscriptionVendor
  /** System-key-only ciphertext of the raw token. */
  tokenCipher: string
  createdAt: number
  expiresAt: number
}

export interface SubscriptionActivationRepository {
  /** The live (unexpired) activation for a scope+user+vendor, or null. */
  get(
    scopeId: ActivationScopeId,
    userId: string,
    vendor: SubscriptionVendor,
    now: number,
  ): Promise<SubscriptionActivationRecord | null>
  /** Create or replace the activation for a scope+user+vendor. */
  upsert(record: SubscriptionActivationRecord): Promise<void>
  /** Delete every activation for a settled scope (a finished run, a finished test). */
  deleteByScope(scopeId: ActivationScopeId): Promise<void>
  /** Delete activations whose TTL has passed (the expiry sweep). Returns the count. */
  deleteExpired(now: number): Promise<number>
}

/**
 * The key an activation is stored under: an opaque, PREFIXED string naming which kind of scope
 * minted it, built only by {@link runActivationScope} / {@link userActivationScope}.
 *
 * Prefixed rather than a bare id because there is now more than one kind, and they are reclaimed
 * differently: a run's activations are deleted the moment the run settles, while a user's outlive
 * any single request and are reclaimed by the TTL sweep alone. An unprefixed key made the first
 * synthetic scope (an environment test's id) read as a run id that no run would ever settle, and a
 * second kind on the same footing would make that ambiguity structural.
 */
export type ActivationScopeId = string & { readonly __activationScope: unique symbol }

/**
 * The activation scope of a RUN: its container steps and any inline call it makes lease the
 * initiator's credential for as long as the run is live, and settling it deletes them all.
 *
 * Also the scope an environment test mints under, which is the honest reading: a test is a
 * run-shaped unit of work with its own id and its own settlement.
 */
export function runActivationScope(executionId: string): ActivationScopeId {
  return `run:${executionId}` as ActivationScopeId
}

/**
 * The activation scope of a PERSON: the run-less surfaces (the in-app assistant, the bug hunt)
 * where a signed-in user asks for something a model answers immediately.
 *
 * There is exactly one per user rather than one per request, because the point of an activation is
 * to spare the person their password on the next interaction, and a per-request scope would ask
 * again every time. Nothing deletes it explicitly: it expires on the same TTL a run's does, which
 * is what bounds how long the raw token is recoverable with the system key alone.
 */
export function userActivationScope(userId: string): ActivationScopeId {
  return `user:${userId}` as ActivationScopeId
}
