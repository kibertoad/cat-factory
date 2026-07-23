import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Provider-subscription (vendor) credential wire contracts.
//
// A workspace connects one or more subscription credentials per vendor so the
// Claude Code / Codex harnesses can authenticate inside a per-run container
// without an API key:
//   - `claude`: a long-lived OAuth token from `claude setup-token`
//     (injected as CLAUDE_CODE_OAUTH_TOKEN, talks to api.anthropic.com).
//   - `glm` / `kimi` / `deepseek`: a coding-plan API key for a vendor that exposes
//     an Anthropic-compatible endpoint (Z.ai / Moonshot / DeepSeek), driven by
//     Claude Code via ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.
//   - `codex`: the full ChatGPT `auth.json` bundle (written to $CODEX_HOME).
//
// Tokens form a pool, leased with usage-aware rotation. The raw secret is
// write-only — it is encrypted at rest and never returned; only metadata +
// rolling-window usage counters are exposed back to clients.
// ---------------------------------------------------------------------------

/** Vendors whose subscription harnesses we support. */
export const subscriptionVendorSchema = v.picklist(['claude', 'codex', 'glm', 'kimi', 'deepseek'])
export type SubscriptionVendor = v.InferOutput<typeof subscriptionVendorSchema>

/** One pool token as exposed to clients — metadata + usage, never the secret. */
export const vendorCredentialSchema = v.object({
  id: v.string(),
  vendor: subscriptionVendorSchema,
  label: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.nullable(v.number()),
  /** Rolling-window usage so the UI can show load and rotation fairness. */
  inputTokens: v.number(),
  outputTokens: v.number(),
  requestCount: v.number(),
  /** Whether this token is eligible for leasing. A disabled token stays in the pool
   * (visible + re-enablable) but is never leased and doesn't make its vendor "configured". */
  enabled: v.boolean(),
  /** Whether this token is the pinned default for its vendor: preferred at lease time over
   * usage-aware rotation. At most one default per (workspace, vendor); a disabled default
   * is ignored (leasing falls back to rotation among the remaining enabled tokens). */
  isDefault: v.boolean(),
})
export type VendorCredential = v.InferOutput<typeof vendorCredentialSchema>

export const vendorCredentialListSchema = v.array(vendorCredentialSchema)
export type VendorCredentialList = v.InferOutput<typeof vendorCredentialListSchema>

/** Add a token to the pool. `token` is write-only (the raw secret blob). */
export const addVendorCredentialSchema = v.object({
  vendor: subscriptionVendorSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  token: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type AddVendorCredentialInput = v.InferOutput<typeof addVendorCredentialSchema>

/**
 * Update a pool token's lifecycle flags. Both fields are optional — only the supplied
 * ones change. `enabled: false` takes the token out of rotation without deleting it;
 * `isDefault: true` pins it as the vendor's default (clearing any prior default), and
 * `isDefault: false` un-pins it (the vendor reverts to usage-aware rotation).
 */
export const updateVendorCredentialSchema = v.object({
  enabled: v.optional(v.boolean()),
  isDefault: v.optional(v.boolean()),
})
export type UpdateVendorCredentialInput = v.InferOutput<typeof updateVendorCredentialSchema>
