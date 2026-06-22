import type { ModelCost, ModelOption, SubscriptionVendor } from '@cat-factory/contracts'
import type { HarnessKind, ModelRef } from '../ports/model-provider.js'

// How each subscription vendor authenticates and which harness runs it. Claude
// Code is an Anthropic-API client that honours ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN, so it drives any vendor with an Anthropic-compatible
// endpoint (GLM via Z.ai, Kimi via Moonshot, DeepSeek) as well as Anthropic itself;
// Codex runs the ChatGPT backend. The executor reads `baseUrl` here to tell the harness
// where to point a non-Anthropic Claude-Code vendor (absent ⇒ api.anthropic.com
// with the OAuth token).
export interface SubscriptionVendorConfig {
  harness: Extract<HarnessKind, 'claude-code' | 'codex'>
  /** Anthropic-compatible base URL for a non-Anthropic claude-code vendor. */
  baseUrl?: string
  /** Short label shown in the picker / credential UI. */
  label: string
  /**
   * The vendor's subscription credential is licensed for INDIVIDUAL use only, so it may
   * NOT be pooled on a workspace (any member's runs leasing it) — it is stored per-user
   * and only its owner's runs may use it. Set from each vendor's own terms of service:
   *
   *  - `claude`  — Anthropic consumer Claude (Pro/Max) is individual-use only.
   *  - `codex`   — a ChatGPT `auth.json` is a per-seat credential; OpenAI prohibits
   *                credential sharing at EVERY tier (Plus/Pro and Team/Business/
   *                Enterprise alike — Team/Enterprise just grant more individual seats).
   *  - `glm`     — Z.ai's GLM Coding Plan is "licensed only to the individual natural
   *                person" and forbids any organization using its quota.
   *
   * This is the right axis even across tiers: the pool models SHARING a subscription
   * credential, which no consumer tier permits. Genuine org-wide / programmatic access
   * goes through the DIRECT-PROVIDER API-KEY path (OpenAI/Anthropic keys), which is
   * unaffected by this flag — so flagging a vendor here routes orgs to API keys, it does
   * not lock them out. The commercial coding-plan vendors that DO permit org use stay
   * poolable: `kimi` (Moonshot explicitly permits authorized enterprise use) and
   * `deepseek` (a commercial API platform serving internal/external end users). See
   * backend/docs/individual-subscription-usage.md §1 for the per-vendor ToS citations.
   */
  individualOnly?: boolean
}

export const SUBSCRIPTION_VENDORS: Record<SubscriptionVendor, SubscriptionVendorConfig> = {
  claude: { harness: 'claude-code', label: 'Claude', individualOnly: true },
  glm: {
    harness: 'claude-code',
    baseUrl: 'https://api.z.ai/api/anthropic',
    label: 'GLM (Z.ai)',
    individualOnly: true,
  },
  kimi: {
    harness: 'claude-code',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    label: 'Kimi (Moonshot)',
  },
  deepseek: {
    harness: 'claude-code',
    baseUrl: 'https://api.deepseek.com/anthropic',
    label: 'DeepSeek',
  },
  codex: { harness: 'codex', label: 'ChatGPT (Codex)', individualOnly: true },
}

// The curated catalog of LLM models a user can pick for a single block. Selection
// persists as a stable `id` on the block (see `Block.modelId`); at run time the
// executor resolves that id to a concrete {@link ModelRef}.
//
// Each model has two flavours: a Cloudflare Workers AI variant that is always
// available (via the `AI` binding), and — for models that also offer their own
// API — a `direct` variant. The direct variant transparently replaces the
// Cloudflare one whenever its API key is configured; with no key, the model
// stays on (and is shown as) its Cloudflare flavour. This makes "go direct" a
// zero-config upgrade with an automatic Cloudflare fallback.

export interface ModelVariant {
  ref: ModelRef
  /** Env var whose presence switches this model to its direct provider. */
  keyEnv: string
  /** Short provider label shown in the picker, e.g. `DashScope`. */
  providerLabel: string
}

/**
 * A subscription-only variant: the model runs in the Claude Code / Codex harness
 * authenticated with a pooled subscription token (no Cloudflare/API-key fallback).
 * The `ref` carries the `harness` the executor dispatches to.
 */
export interface SubscriptionVariant {
  ref: ModelRef
  /** Vendor whose pooled token authenticates this model. */
  vendor: SubscriptionVendor
}

export interface SelectableModel {
  /** Stable id stored on a block, e.g. `qwen`. */
  id: string
  /** Model-family label shown in the picker, e.g. `Qwen3`. */
  label: string
  /** One-line description shown alongside the label. */
  description: string
  /** Always-available Cloudflare Workers AI variant (absent for subscription-only models). */
  cloudflare?: ModelRef
  /** Optional direct-provider variant, used when its key is configured. */
  direct?: ModelVariant
  /**
   * Optional subscription variant (Claude Code / Codex). For subscription-ONLY
   * models (Opus/Sonnet/GPT) it is the only variant; for dual-mode models
   * (GLM/Kimi) it sits alongside a Cloudflare/direct base and WINS whenever the
   * workspace has a token for its vendor.
   */
  subscription?: SubscriptionVariant
}

export const MODEL_CATALOG: SelectableModel[] = [
  {
    id: 'cloudflare-llama',
    label: 'Llama 3.1',
    description: "Meta's fast 8B instruct model — Cloudflare Workers AI's default.",
    cloudflare: { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' },
  },
  {
    id: 'qwen',
    label: 'Qwen3',
    description: "Alibaba's Qwen3 — Qwen3-30B on Cloudflare, flagship Qwen3-Max when direct.",
    cloudflare: { provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' },
    direct: {
      ref: { provider: 'qwen', model: 'qwen3-max' },
      keyEnv: 'QWEN_API_KEY',
      providerLabel: 'DashScope',
    },
  },
  {
    id: 'kimi-k2.7',
    label: 'Kimi K2.7',
    description: "Moonshot AI's latest 1T-param agentic-coding model (structured outputs).",
    cloudflare: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.7-code' },
  },
  {
    id: 'kimi',
    label: 'Kimi K2.6',
    description:
      "Moonshot AI's frontier-scale agentic model — cut 32K context on Cloudflare, " +
      'full 256K via a Kimi (Moonshot) subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.6',
      contextTokens: 32_000,
    },
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k2.6', contextTokens: 256_000 },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
    // Run via Claude Code against Moonshot's Anthropic-compatible endpoint on a
    // Kimi coding-plan subscription (full context, flat-rate quota).
    subscription: {
      ref: {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        harness: 'claude-code',
        contextTokens: 256_000,
      },
      vendor: 'kimi',
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek R1',
    description:
      "DeepSeek's reasoning — cut 32K R1 distill on Cloudflare, full 64K flagship chat " +
      'when direct or via a DeepSeek coding-plan subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      contextTokens: 32_000,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-chat', contextTokens: 64_000 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    // Run via Claude Code against DeepSeek's Anthropic-compatible endpoint on a
    // DeepSeek coding-plan subscription (full context, flat-rate quota).
    subscription: {
      ref: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        harness: 'claude-code',
        contextTokens: 64_000,
      },
      vendor: 'deepseek',
    },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description:
      "DeepSeek's flagship V4 Pro agentic-coding model, served on Cloudflare (131K context).",
    cloudflare: {
      provider: 'workers-ai',
      model: 'deepseek/deepseek-v4-pro',
      contextTokens: 131_000,
    },
  },
  {
    id: 'glm',
    label: 'GLM-5.2',
    description:
      "Z.ai's agentic-coding model — cut 24K context on Cloudflare, full 200K via a GLM (Z.ai) subscription.",
    cloudflare: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2', contextTokens: 24_000 },
    // Run via Claude Code against Z.ai's Anthropic-compatible endpoint on a GLM
    // coding-plan subscription (full context, flat-rate quota).
    subscription: {
      ref: { provider: 'zai', model: 'glm-5.2', harness: 'claude-code', contextTokens: 200_000 },
      vendor: 'glm',
    },
  },
  // Subscription-only models: run in the Claude Code / Codex harness with a pooled
  // subscription token (Claude Pro/Max, ChatGPT Plus/Pro), direct to the vendor.
  {
    id: 'claude-opus',
    label: 'Claude Opus 4.8',
    description: "Anthropic's most capable model, run via Claude Code on your Claude subscription.",
    subscription: {
      ref: { provider: 'anthropic', model: 'claude-opus-4-8', harness: 'claude-code' },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.6',
    description: "Anthropic's balanced speed/intelligence model, run via Claude Code.",
    subscription: {
      ref: { provider: 'anthropic', model: 'claude-sonnet-4-6', harness: 'claude-code' },
      vendor: 'claude',
    },
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: "OpenAI's flagship, run via Codex on your ChatGPT subscription.",
    subscription: {
      ref: { provider: 'openai', model: 'gpt-5.5-codex', harness: 'codex' },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: "OpenAI's cost-efficient mid-tier, run via Codex on your ChatGPT subscription.",
    subscription: {
      ref: { provider: 'openai', model: 'gpt-5.4-codex', harness: 'codex' },
      vendor: 'codex',
    },
  },
]

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Look up a catalog model by id, or `undefined` for an unknown/empty id. */
export function getSelectableModel(id: string | undefined | null): SelectableModel | undefined {
  return id ? BY_ID.get(id) : undefined
}

/**
 * What a deployment + workspace actually has configured, used to resolve a catalog
 * model to its usable flavour. Replaces the old env-only `keyEnv` predicate: direct
 * keys now live in the DB API-key pool (account/workspace/user scoped), subscription
 * vendors in the token pools, and Cloudflare Workers AI is an opt-in provider lib.
 */
export interface ProviderCapabilities {
  /** Direct providers (e.g. `qwen`, `openai`) with ≥1 key in the merged scope pool. */
  directProviders: Set<string>
  /** Subscription vendors with a usable token (pool or personal). */
  subscriptionVendors: Set<SubscriptionVendor>
  /** Whether the opt-in Cloudflare Workers AI lib is registered for this deployment. */
  cloudflareEnabled: boolean
}

/** Resolve the informational list cost for a model ref (e.g. from spend pricing). */
export type ModelCostResolver = (ref: ModelRef) => ModelCost | undefined

/** The effective variant a catalog model resolves to for a given capability set. */
interface EffectiveVariant {
  ref: ModelRef
  flavor: 'cloudflare' | 'direct' | 'subscription'
  providerLabel: string
  vendor?: SubscriptionVendor
}

/** Whether a flavour of the model is usable given the capabilities. */
function directUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  return !!model.direct && caps.directProviders.has(model.direct.ref.provider)
}
function cloudflareUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  return !!model.cloudflare && caps.cloudflareEnabled
}
function subscriptionUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  return !!model.subscription && caps.subscriptionVendors.has(model.subscription.vendor)
}

/**
 * Whether a catalog model is selectable for the given capabilities — it has at least
 * one usable flavour (a configured direct key, an enabled Cloudflare lib, or a
 * connected subscription vendor). Unknown ids are not usable.
 */
export function isModelUsable(
  id: string | undefined | null,
  caps: ProviderCapabilities,
): boolean {
  const model = getSelectableModel(id)
  if (!model) return false
  return directUsable(model, caps) || cloudflareUsable(model, caps) || subscriptionUsable(model, caps)
}

// The effective variant a model resolves to for a capability set: prefer a usable
// direct key, else the Cloudflare lib, else a connected subscription. When NOTHING is
// usable it still returns a best-effort ref (direct → cloudflare → subscription) so
// callers always get a ref; selectability is reported separately by `isModelUsable`.
// A dual-mode model's subscription flavour ("subscriptions win") is preferred
// per-workspace by the executor + frontend, not here.
function effectiveVariant(model: SelectableModel, caps: ProviderCapabilities): EffectiveVariant {
  const direct = (): EffectiveVariant => ({
    ref: model.direct!.ref,
    flavor: 'direct',
    providerLabel: model.direct!.providerLabel,
  })
  const cloudflare = (): EffectiveVariant => ({
    ref: model.cloudflare!,
    flavor: 'cloudflare',
    providerLabel: 'Cloudflare',
  })
  const subscription = (): EffectiveVariant => ({
    ref: model.subscription!.ref,
    flavor: 'subscription',
    providerLabel: SUBSCRIPTION_VENDORS[model.subscription!.vendor].label,
    vendor: model.subscription!.vendor,
  })
  // Prefer a usable flavour.
  if (directUsable(model, caps)) return direct()
  if (cloudflareUsable(model, caps)) return cloudflare()
  if (subscriptionUsable(model, caps)) return subscription()
  // Nothing usable: a best-effort ref so the caller still has something to show/run
  // (the guard / `available` flag gate actual use).
  if (model.direct) return direct()
  if (model.cloudflare) return cloudflare()
  if (model.subscription) return subscription()
  throw new Error(
    `Model '${model.id}' has no resolvable variant (no cloudflare/direct/subscription)`,
  )
}

/** Project a catalog model onto its effective, display-ready option. */
function toOption(
  model: SelectableModel,
  caps: ProviderCapabilities,
  costFor?: ModelCostResolver,
): ModelOption {
  const variant = effectiveVariant(model, caps)
  const cost = costFor?.(variant.ref)
  const option: ModelOption = {
    id: model.id,
    label: model.label,
    description: model.description,
    flavor: variant.flavor,
    available: isModelUsable(model.id, caps),
    providerLabel: variant.providerLabel,
    provider: variant.ref.provider,
    model: variant.ref.model,
    ...(variant.vendor ? { vendor: variant.vendor } : {}),
    ...(cost ? { cost } : {}),
    ...(variant.ref.contextTokens ? { contextTokens: variant.ref.contextTokens } : {}),
    // Subscription flavours are flat-rate quota, not budget-metered.
    ...(variant.flavor === 'subscription' ? { quotaBased: true } : {}),
  }
  // Dual-mode model: attach the subscription flavour the frontend prefers when the
  // workspace has a token for its vendor (the base above stays the fallback).
  if (model.subscription && variant.flavor !== 'subscription') {
    const subRef = model.subscription.ref
    const subCost = costFor?.(subRef)
    option.subscription = {
      vendor: model.subscription.vendor,
      providerLabel: SUBSCRIPTION_VENDORS[model.subscription.vendor].label,
      provider: subRef.provider,
      model: subRef.model,
      ...(subCost ? { cost: subCost } : {}),
      ...(subRef.contextTokens ? { contextTokens: subRef.contextTokens } : {}),
    }
  }
  return option
}

/**
 * The subscription option for a catalog model id (vendor + ref carrying the
 * harness), or undefined when the model has no subscription path. The executor
 * uses this to override a step to its subscription flavour when the workspace has
 * a pooled token for the vendor — "subscriptions always win".
 */
export function subscriptionOptionFor(
  id: string | undefined | null,
): { vendor: SubscriptionVendor; ref: ModelRef } | undefined {
  const model = getSelectableModel(id)
  if (!model?.subscription) return undefined
  return { vendor: model.subscription.vendor, ref: model.subscription.ref }
}

/** Whether a vendor's subscription is licensed for individual use only (e.g. `claude`). */
export function isIndividualVendor(vendor: SubscriptionVendor): boolean {
  return SUBSCRIPTION_VENDORS[vendor].individualOnly === true
}

/** Every vendor flagged individual-usage only — the single source of truth for the
 *  per-user personal-subscription flow (e.g. activation refresh) so it never drifts
 *  from {@link SUBSCRIPTION_VENDORS}. */
export const INDIVIDUAL_VENDORS: SubscriptionVendor[] = (
  Object.keys(SUBSCRIPTION_VENDORS) as SubscriptionVendor[]
).filter(isIndividualVendor)

/**
 * The individual-usage vendor a catalog model id runs on, or null. A model triggers
 * the individual-usage restricted mode (per-user credential, no recurring, etc.) only
 * when it has a subscription flavour AND that vendor is `individualOnly`. Used by the
 * engine/controllers to gate a run on the initiator's personal subscription.
 */
export function individualVendorForModelId(
  id: string | undefined | null,
): SubscriptionVendor | null {
  const sub = subscriptionOptionFor(id)
  return sub && isIndividualVendor(sub.vendor) ? sub.vendor : null
}

/**
 * The effective catalog for a deployment: each model resolved to the flavour that
 * is actually in use given which direct-provider keys are configured. Served to
 * the frontend so the picker can show whether a model runs direct, on Cloudflare,
 * or on a subscription harness — plus its informational list cost when `costFor`
 * is supplied. Subscription models are always listed; the frontend gates them on
 * whether the workspace has a token for the vendor.
 */
export function effectiveCatalog(
  caps: ProviderCapabilities,
  costFor?: ModelCostResolver,
): ModelOption[] {
  return MODEL_CATALOG.map((model) => toOption(model, caps, costFor))
}

/**
 * Resolve a block's selected model id to the {@link ModelRef} that should run it,
 * honouring the direct/Cloudflare fallback and carrying the subscription harness
 * when applicable. Returns `undefined` for an unknown or absent id so the caller
 * falls back to its default routing.
 */
export function resolveModelRef(
  id: string | undefined | null,
  caps: ProviderCapabilities,
): ModelRef | undefined {
  const model = getSelectableModel(id)
  if (!model) return undefined
  return effectiveVariant(model, caps).ref
}

/** Every subscription vendor (the full set), for building a permissive capability set. */
export const ALL_SUBSCRIPTION_VENDORS: SubscriptionVendor[] = Object.keys(
  SUBSCRIPTION_VENDORS,
) as SubscriptionVendor[]
