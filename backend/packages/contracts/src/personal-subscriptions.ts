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
// key. The password is supplied at task start/retry — carried on the ambient
// `X-Personal-Password` header (not a body field) and cached client-side with a TTL to
// stay low-friction — to mint a short-lived, per-run activation the async container steps
// use (re-minted transparently while the run is tended; see the docs).
//
// The password layer's purpose is preventing ACCIDENTAL misuse (a credential can't be
// silently pooled), not defending against a system-key holder — the system encryption is
// the primary at-rest protection. See docs/individual-subscription-usage.md §3 for the
// honest threat model + the full safeguards.
// ---------------------------------------------------------------------------

/**
 * The personal password that gates the second encryption layer (6–256 chars). Restricted
 * to printable ASCII so the same value can ride **raw** in the `X-Personal-Password`
 * request header (see below) when unlocking a run — HTTP header values must be Latin-1, so
 * a non-ASCII password could not be sent without encoding. Never stored server-side.
 */
export const personalPasswordSchema = v.pipe(
  v.string(),
  v.minLength(6),
  v.maxLength(256),
  v.regex(/^[\x20-\x7e]+$/, 'Password must use printable ASCII characters (no tabs/newlines).'),
)

/**
 * HTTP header carrying the personal password to unlock a run's individual-usage
 * credential(s). It is an AMBIENT credential — like the bearer token, the client attaches
 * it on the gated calls (start / retry / resolve / approve / request-changes) rather than
 * baking it into each request body — so it never appears in a wire-contract payload. The
 * server reads it, unlocks, and mints/re-mints the per-run activation; absent + required ⇒
 * `428 credential_required`.
 */
export const PERSONAL_PASSWORD_HEADER = 'X-Personal-Password'

/** Store (or replace) the signed-in user's personal subscription for a vendor. */
export const storePersonalSubscriptionSchema = v.object({
  vendor: subscriptionVendorSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  /** The raw secret (write-only): the `claude setup-token` OAuth token for `claude`. */
  token: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** Personal password that gates the second encryption layer. Never stored. */
  password: personalPasswordSchema,
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
