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
})
export type ApiKey = v.InferOutput<typeof apiKeySchema>

export const apiKeyListSchema = v.array(apiKeySchema)
export type ApiKeyList = v.InferOutput<typeof apiKeyListSchema>

/** Add a key to a pool. `key` is write-only (the raw secret). */
export const addApiKeySchema = v.object({
  provider: apiKeyProviderSchema,
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  key: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type AddApiKeyInput = v.InferOutput<typeof addApiKeySchema>
