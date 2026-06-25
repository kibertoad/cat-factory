import * as v from 'valibot'
import { providerConfigFieldSchema } from './provider-config.js'

// ---------------------------------------------------------------------------
// Per-user secret wire contracts. A generic, `kind`-discriminated store for
// token-style per-user credentials — a GitHub personal access token today, and
// future repository/provider tokens (GitLab PAT, …) as new kinds with NO schema
// change. Each kind declares the config fields it needs (rendered generically,
// like the provider descriptors) and may expose a connection test.
//
// Distinct from `personal_subscriptions` (double-encrypted under a personal
// password, with per-run activation) and `local_model_endpoints` (base URL +
// enabled-model selection) — those carry real specializations and stay separate.
// This store is only for `{ secret, optional non-secret metadata }`.
// ---------------------------------------------------------------------------

/** The per-user secret kinds. Each maps to a registered handler (fields + test). */
export const USER_SECRET_KINDS = ['github_pat'] as const
export const userSecretKindSchema = v.picklist(USER_SECRET_KINDS)
export type UserSecretKind = v.InferOutput<typeof userSecretKindSchema>

/** Read-only status of one stored per-user secret — never the secret value. */
export const userSecretStatusSchema = v.object({
  kind: userSecretKindSchema,
  label: v.string(),
  /** Whether a (write-only) secret is stored for this kind. */
  hasSecret: v.boolean(),
  /** Non-secret metadata the kind keeps (e.g. `{ apiBase }`). */
  metadata: v.optional(v.record(v.string(), v.string())),
  connectedAt: v.number(),
})
export type UserSecretStatus = v.InferOutput<typeof userSecretStatusSchema>

const labelSchema = v.pipe(v.string(), v.trim(), v.maxLength(120))
const secretSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))
const metadataSchema = v.record(v.string(), v.pipe(v.string(), v.trim(), v.maxLength(2000)))

/** Store (or replace) the signed-in user's secret for a kind. */
export const storeUserSecretSchema = v.object({
  label: v.optional(labelSchema),
  /** The raw secret (write-only); stored encrypted at rest. */
  secret: secretSchema,
  /** Optional non-secret metadata the kind understands (e.g. `apiBase`). */
  metadata: v.optional(metadataSchema),
})
export type StoreUserSecretInput = v.InferOutput<typeof storeUserSecretSchema>

/** Probe a (not-yet-saved) secret + metadata for reachability/validity. */
export const testUserSecretSchema = v.object({
  secret: secretSchema,
  metadata: v.optional(metadataSchema),
})
export type TestUserSecretInput = v.InferOutput<typeof testUserSecretSchema>

/** A kind's self-description for the generic connect form. */
export const userSecretDescriptorSchema = v.object({
  kind: userSecretKindSchema,
  label: v.string(),
  configFields: v.array(providerConfigFieldSchema),
  supportsTest: v.boolean(),
})
export type UserSecretDescriptor = v.InferOutput<typeof userSecretDescriptorSchema>
