import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Account-wide model-family allow/block policy.
//
// An account admin can constrain which LLM FAMILIES their teams may run — e.g. block
// all DeepSeek/Qwen, or only allow Claude + OpenAI. Because data-residency risk is a
// property of the SERVING ROUTE and not the model weights (a China-origin family served
// via AWS Bedrock's geographic cross-Region inference, or Azure's EU Data Boundary,
// stays in-region), the policy is evaluated against `(family, effective-provider)`: a
// blocked family is still allowed when its effective route's provider is in
// `trustedProviders` (a residency-guaranteed route the operator vouches for, e.g.
// `bedrock`). Stored on the account settings config blob (no migration); gated to the
// Cloudflare / remote-Node / mothership runtimes (never plain local mode).
// ---------------------------------------------------------------------------

/**
 * The curated model families the policy operates on — the coarse "family" axis of the
 * built-in catalog. `familyForModelId` (kernel) maps a catalog id (and OpenRouter slug)
 * onto one of these; ids with no family (an operator's LiteLLM gateway, an arbitrary
 * OpenRouter slug, a per-user local runner) are UNCLASSIFIED and handled per the mode
 * (allowlist ⇒ blocked, blocklist ⇒ allowed — see `isAllowedByFamilyPolicy`).
 */
export const modelFamilySchema = v.picklist([
  'llama',
  'qwen',
  'kimi',
  'deepseek',
  'glm',
  'claude',
  'openai',
  'gemini',
])
export type ModelFamily = v.InferOutput<typeof modelFamilySchema>

/**
 * The account's operating region. Informational only — it drives WHICH built-in presets
 * the admin UI offers (residency risk is relative to where the account operates: what is
 * a concern for a European account is business-as-usual for a Chinese one). It does NOT
 * itself restrict anything; the effective restriction is `mode` + `families`.
 */
export const accountRegionSchema = v.picklist(['usa', 'europe', 'china', 'other'])
export type AccountRegion = v.InferOutput<typeof accountRegionSchema>

/** How the family set is interpreted. `off` ⇒ no restriction at all. */
export const modelPolicyModeSchema = v.picklist(['off', 'blocklist', 'allowlist'])
export type ModelPolicyMode = v.InferOutput<typeof modelPolicyModeSchema>

/**
 * The account-wide model-family policy.
 *
 * - `blocklist`: a model is blocked when its family ∈ `families` AND its effective
 *   route provider ∉ `trustedProviders`.
 * - `allowlist`: a model is allowed when its family ∈ `families` OR its effective route
 *   provider ∈ `trustedProviders`; everything else (incl. unclassified families) is
 *   blocked.
 * - `off`: no restriction.
 *
 * `trustedProviders` holds effective-route provider ids the operator treats as
 * residency-guaranteed (e.g. `bedrock`). They exempt an otherwise-blocked family so a
 * "block DeepSeek, but DeepSeek-via-Bedrock-EU is fine" rule is expressible.
 */
export const modelFamilyPolicySchema = v.object({
  mode: modelPolicyModeSchema,
  families: v.array(modelFamilySchema),
  trustedProviders: v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))),
  region: v.optional(accountRegionSchema),
})
export type ModelFamilyPolicy = v.InferOutput<typeof modelFamilyPolicySchema>

/** The inert default: no restriction. */
export const MODEL_POLICY_OFF: ModelFamilyPolicy = { mode: 'off', families: [], trustedProviders: [] }

/**
 * A built-in policy template the admin can apply into the editable account policy. `id`
 * is stable (the SPA keys its translated label/description off it); `region` groups which
 * presets the UI surfaces for an account's selected region. Presets are TEMPLATES, not
 * stored rows.
 */
export interface ModelFamilyPolicyPreset {
  id: string
  region: AccountRegion
  policy: ModelFamilyPolicy
}

// The China-based vendors integrated in this deployment (their DIRECT routes serve from
// China). Blocking these families steers a residency-conscious account to the models'
// residency-guaranteed routes (Bedrock/Azure regions) via `trustedProviders`, or to the
// Western families.
const CN_HOSTED_FAMILIES: ModelFamily[] = ['deepseek', 'qwen', 'kimi', 'glm']

/** Effective-route providers treated as residency-guaranteed out of the box. */
const RESIDENCY_GUARANTEED_PROVIDERS = ['bedrock']

export const MODEL_FAMILY_POLICY_PRESETS: ModelFamilyPolicyPreset[] = [
  {
    id: 'us-block-cn',
    region: 'usa',
    policy: {
      mode: 'blocklist',
      families: [...CN_HOSTED_FAMILIES],
      trustedProviders: [...RESIDENCY_GUARANTEED_PROVIDERS],
    },
  },
  {
    id: 'eu-block-cn',
    region: 'europe',
    policy: {
      mode: 'blocklist',
      families: [...CN_HOSTED_FAMILIES],
      trustedProviders: [...RESIDENCY_GUARANTEED_PROVIDERS],
    },
  },
  {
    // Strictest EU stance: only families reached over a residency-guaranteed route pass.
    // An empty allow set means NO family is allowed on its own — a model is selectable
    // only when its effective route provider is in `trustedProviders` (Bedrock-EU, etc.).
    id: 'eu-guaranteed-only',
    region: 'europe',
    policy: {
      mode: 'allowlist',
      families: [],
      trustedProviders: [...RESIDENCY_GUARANTEED_PROVIDERS],
    },
  },
  {
    // Mirror image for China-based accounts: prefer domestically-hosted families; a
    // residency-guaranteed route stays available too.
    id: 'cn-prefer-domestic',
    region: 'china',
    policy: {
      mode: 'allowlist',
      families: [...CN_HOSTED_FAMILIES, 'llama'],
      trustedProviders: [...RESIDENCY_GUARANTEED_PROVIDERS],
    },
  },
  {
    id: 'other-block-cn',
    region: 'other',
    policy: {
      mode: 'blocklist',
      families: [...CN_HOSTED_FAMILIES],
      trustedProviders: [...RESIDENCY_GUARANTEED_PROVIDERS],
    },
  },
]
