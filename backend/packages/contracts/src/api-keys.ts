import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Direct-provider API-key wire contracts.
//
// Vendor API keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot) are onboarded via the
// UI and stored encrypted in the DB, replacing the old deployment-env onboarding.
// A key lives at one of three SCOPES — account, workspace, or user. Within a
// workspace the candidate pool is the union of the workspace's keys, its owning
// account's keys, and the run initiator's own user keys; keys are leased with
// usage-aware rotation. The raw key is write-only — encrypted at rest and never
// returned; only metadata + rolling-window usage is exposed back to clients.
// ---------------------------------------------------------------------------

/** The scope a stored API key belongs to. */
export const apiKeyScopeSchema = v.picklist(['account', 'workspace', 'user'])
export type ApiKeyScope = v.InferOutput<typeof apiKeyScopeSchema>

/** The direct providers that own a poolable API key. */
export const apiKeyProviderSchema = v.picklist([
  'openai',
  'anthropic',
  'qwen',
  'deepseek',
  'moonshot',
  // OpenAI-compatible aggregator/gateway providers: OpenRouter (a single hosted gateway
  // to 300+ models) and LiteLLM (an operator-hosted gateway; its base URL comes from the
  // deployment's LITELLM_BASE_URL). Both resolve via the shared OpenAI-compatible path.
  'openrouter',
  'litellm',
])
export type ApiKeyProvider = v.InferOutput<typeof apiKeyProviderSchema>

/** One pool key as exposed to clients — metadata + usage, never the secret. */
export const apiKeySchema = v.object({
  id: v.string(),
  scope: apiKeyScopeSchema,
  scopeId: v.string(),
  provider: apiKeyProviderSchema,
  label: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.nullable(v.number()),
  /** Rolling-window usage so the UI can show load and rotation fairness. */
  inputTokens: v.number(),
  outputTokens: v.number(),
  requestCount: v.number(),
  /** Whether this key is eligible for leasing. A disabled key stays in the pool (visible +
   * re-enablable) but is never leased and doesn't make its provider "configured". */
  enabled: v.boolean(),
  /** Whether this key is the pinned default for its provider within its scope: preferred at
   * lease time over usage-aware rotation. At most one default per (scope, scopeId, provider);
   * a disabled default is ignored (leasing falls back to rotation among the enabled keys). */
  isDefault: v.boolean(),
})
export type ApiKey = v.InferOutput<typeof apiKeySchema>

export const apiKeyListSchema = v.array(apiKeySchema)
export type ApiKeyList = v.InferOutput<typeof apiKeyListSchema>

/** The `{ keys }` envelope every key-list endpoint (workspace/user/account) returns. */
export const apiKeyListResultSchema = v.object({ keys: apiKeyListSchema })
export type ApiKeyListResult = v.InferOutput<typeof apiKeyListResultSchema>

/** Add a key to a pool. `key` is write-only (the raw secret). */
export const addApiKeySchema = v.object({
  provider: apiKeyProviderSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  key: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type AddApiKeyInput = v.InferOutput<typeof addApiKeySchema>

/**
 * Update a pool key's lifecycle flags. Both fields are optional — only the supplied ones
 * change. `enabled: false` takes the key out of rotation without deleting it; `isDefault:
 * true` pins it as the provider's default within its scope (clearing any prior default),
 * and `isDefault: false` un-pins it (the provider reverts to usage-aware rotation).
 */
export const updateApiKeySchema = v.object({
  enabled: v.optional(v.boolean()),
  isDefault: v.optional(v.boolean()),
})
export type UpdateApiKeyInput = v.InferOutput<typeof updateApiKeySchema>
