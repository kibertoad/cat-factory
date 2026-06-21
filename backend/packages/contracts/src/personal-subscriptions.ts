import * as v from 'valibot'
import { subscriptionVendorSchema } from './vendor-credentials.js'

// ---------------------------------------------------------------------------
// Personal (individual-usage) subscription wire contracts.
//
// Some subscriptions are licensed for INDIVIDUAL use only (Anthropic's consumer
// Claude subscription). Those are NOT pooled per workspace like the commercial
// coding-plan vendors; instead each user stores their OWN credential, and only
// that user's runs may use it. To make "only the user can use it" true even
// against an operator with the database + system key, the credential is
// **double-encrypted**: the raw token is sealed under a key derived from the
// user's PERSONAL PASSWORD (never stored), then encrypted again with the system
// key. The password is supplied at task start/retry (cached client-side with a
// TTL to stay low-friction) to mint a short-lived, per-run activation the async
// container steps use.
//
// See docs/individual-subscription-usage.md for the full model + safeguards.
// ---------------------------------------------------------------------------

/** Store (or replace) the signed-in user's personal subscription for a vendor. */
export const storePersonalSubscriptionSchema = v.object({
  vendor: subscriptionVendorSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** The raw secret (write-only): the `claude setup-token` OAuth token for `claude`. */
  token: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** Personal password that gates the second encryption layer. Never stored. */
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(256)),
  /**
   * Epoch ms the subscription itself expires (so we can warn well in advance and
   * block runs once lapsed). Optional — omit if the plan has no fixed end date.
   */
  expiresAt: v.optional(v.nullable(v.number())),
})
export type StorePersonalSubscriptionInput = v.InferOutput<typeof storePersonalSubscriptionSchema>

/** Read-only status of one personal subscription — metadata only, never the secret. */
export const personalSubscriptionStatusSchema = v.object({
  vendor: subscriptionVendorSchema,
  label: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastUsedAt: v.nullable(v.number()),
  /** Subscription's own expiry (null = no fixed end date). */
  expiresAt: v.nullable(v.number()),
  /** Whole days until `expiresAt` (negative once lapsed; null when no expiry). */
  expiresInDays: v.nullable(v.number()),
  /** Whether the subscription's expiry has already passed. */
  expired: v.boolean(),
  /** Whether renewal should be surfaced now (expiry within the warning window). */
  renewSoon: v.boolean(),
})
export type PersonalSubscriptionStatus = v.InferOutput<typeof personalSubscriptionStatusSchema>

export const personalSubscriptionListSchema = v.array(personalSubscriptionStatusSchema)
export type PersonalSubscriptionList = v.InferOutput<typeof personalSubscriptionListSchema>

/**
 * An optional personal password carried by a task-start / retry request. When the
 * task's pipeline resolves to an individual-usage model, the server uses it to
 * unlock the user's stored credential and mint the run activation. The frontend
 * caches it locally (TTL) so it usually rides along transparently; when absent and
 * required, the server replies `428 credential_required`.
 */
export const personalPasswordFieldSchema = v.optional(
  v.pipe(v.string(), v.minLength(8), v.maxLength(256)),
)
