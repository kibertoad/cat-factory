import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Inbound public-API key wire contracts.
//
// Unlike the direct-provider API keys (`api-keys.ts`, OUTBOUND credentials the
// platform hands to an LLM vendor and therefore stores ENCRYPTED so it can be
// recovered), a public-API key authenticates an EXTERNAL CALLER to our own
// `/api/v1` surface. The platform only ever VERIFIES it, never replays it, so
// the secret is stored as a one-way peppered hash (`HMAC-SHA256(secret,
// ENCRYPTION_KEY)`) — irrecoverable, DB-leak-resistant. The raw key is returned
// exactly once, on create; thereafter only metadata is exposed.
//
// A key is scoped to one account + workspace: every `/api/v1` call it makes is
// bound to that workspace.
// ---------------------------------------------------------------------------

/** One public-API key as exposed to clients — metadata only, never the secret. */
export const publicApiKeySchema = v.object({
  /** `pak_*` — also the non-secret lookup id embedded in the raw key. */
  id: v.string(),
  accountId: v.string(),
  workspaceId: v.string(),
  label: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.nullable(v.number()),
  /** Set when the key was revoked (tombstone); a revoked key never authenticates. */
  revokedAt: v.nullable(v.number()),
})
export type PublicApiKey = v.InferOutput<typeof publicApiKeySchema>

export const publicApiKeyListResultSchema = v.object({ keys: v.array(publicApiKeySchema) })
export type PublicApiKeyListResult = v.InferOutput<typeof publicApiKeyListResultSchema>

/** Mint a new key. Only a label is supplied; the scope comes from the mounting workspace. */
export const createPublicApiKeySchema = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
})
export type CreatePublicApiKeyInput = v.InferOutput<typeof createPublicApiKeySchema>

/**
 * The create response: the key metadata PLUS the raw secret (`cf_live_<id>.<secret>`),
 * returned exactly once and never again — the caller must store it now.
 */
export const createdPublicApiKeySchema = v.object({
  key: publicApiKeySchema,
  /** The full raw key, shown once. Store it — it is not recoverable. */
  secret: v.string(),
})
export type CreatedPublicApiKey = v.InferOutput<typeof createdPublicApiKeySchema>
