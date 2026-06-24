import {
  type ModelCost,
  type ModelOption,
  type OpenRouterModelMeta,
  type SubscriptionVendor,
  isLocalRunner,
} from '@cat-factory/contracts'
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
// Each model has up to four flavours: a Cloudflare Workers AI variant that is
// always available (via the `AI` binding); a `direct` variant for models that
// offer their own API; an `openrouter` variant reaching the same model through
// the OpenRouter gateway; and a `subscription` variant. The effective flavour is
// resolved per workspace by `effectiveVariant` in the precedence
// direct → openrouter → cloudflare, so connecting an OpenRouter key (with no
// native direct key) transparently routes the model through OpenRouter while a
// native direct key still wins. This makes "go direct / go gateway" a zero-config
// upgrade with an automatic Cloudflare fallback.

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
   * Optional OpenRouter gateway variant: the same logical model reached through
   * OpenRouter (`provider: 'openrouter'`, model = the OpenRouter `vendor/model`
   * slug). Used when an OpenRouter key is configured and no native direct key is.
   */
  openrouter?: ModelVariant
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
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.1-8b-instruct',
      contextTokens: 7_968,
    },
  },
  {
    id: 'qwen',
    label: 'Qwen3',
    description: "Alibaba's Qwen3 — Qwen3-30B on Cloudflare, flagship Qwen3-Max when direct.",
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      contextTokens: 32_768,
    },
    direct: {
      ref: { provider: 'qwen', model: 'qwen3-max' },
      keyEnv: 'QWEN_API_KEY',
      providerLabel: 'DashScope',
    },
  },
  {
    id: 'kimi-k2.7',
    label: 'Kimi K2.7',
    description:
      "Moonshot AI's latest 1T-param agentic-coding model (structured outputs), 256K context.",
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.7-code',
      contextTokens: 262_144,
    },
  },
  {
    id: 'kimi',
    label: 'Kimi K2.6',
    description:
      "Moonshot AI's frontier-scale agentic model with a 256K context, on Cloudflare or " +
      'direct via a Moonshot key / Kimi (Moonshot) subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.6',
      contextTokens: 262_144,
    },
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k2.6', contextTokens: 262_144 },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
    // Run via Claude Code against Moonshot's Anthropic-compatible endpoint on a
    // Kimi coding-plan subscription (same 256K window, flat-rate quota).
    subscription: {
      ref: {
        provider: 'moonshot',
        model: 'kimi-k2.6',
        harness: 'claude-code',
        contextTokens: 262_144,
      },
      vendor: 'kimi',
    },
  },
  {
    id: 'kimi-k2.5',
    label: 'Kimi K2.5',
    description:
      "Moonshot AI's prior-generation 1T-param agentic model, 256K context (Cloudflare Workers AI).",
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.5',
      contextTokens: 262_144,
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek R1',
    description:
      "DeepSeek's reasoning: the 80K R1 Qwen-32B distill on Cloudflare, or the flagship " +
      'chat model (64K) when direct or via a DeepSeek coding-plan subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      contextTokens: 80_000,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-chat', contextTokens: 64_000 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'deepseek/deepseek-chat', contextTokens: 64_000 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
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
    // A Cloudflare AI-catalog model: a `<provider>/<model>` slug (not a native `@cf/...`
    // id) Cloudflare serves on its unified-billing run catalog via a partner (Fireworks),
    // reached with the account's own Workers AI binding/token — no AI Gateway, no BYOK.
    // The Worker runs it through `binding.run` directly (see WorkersAiLlmUpstream).
    cloudflare: {
      provider: 'workers-ai',
      model: 'deepseek/deepseek-v4-pro',
      contextTokens: 131_072,
    },
  },
  {
    id: 'glm',
    label: 'GLM-5.2',
    description:
      "Z.ai's agentic-coding model: 256K context on Cloudflare, or the full 1M-token " +
      'window via a GLM (Z.ai) subscription.',
    cloudflare: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2', contextTokens: 262_144 },
    // Run via Claude Code against Z.ai's Anthropic-compatible endpoint on a GLM
    // coding-plan subscription (full 1M context, flat-rate quota).
    subscription: {
      ref: { provider: 'zai', model: 'glm-5.2', harness: 'claude-code', contextTokens: 1_000_000 },
      vendor: 'glm',
    },
  },
  // Subscription-only models: run in the Claude Code / Codex harness with a pooled
  // subscription token (Claude Pro/Max, ChatGPT Plus/Pro), direct to the vendor.
  {
    id: 'claude-opus',
    label: 'Claude Opus 4.8',
    description:
      "Anthropic's most capable model — run via Claude Code on your Claude subscription, " +
      'or pay-as-you-go through OpenRouter (billed at Anthropic rates).',
    openrouter: {
      ref: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', contextTokens: 1_000_000 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
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
    description:
      "OpenAI's flagship — run via Codex on your ChatGPT subscription, or pay-as-you-go " +
      'through OpenRouter (billed at OpenAI rates).',
    openrouter: {
      ref: { provider: 'openrouter', model: 'openai/gpt-5.5', contextTokens: 400_000 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
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
  // Gemini 3 Pro has no Cloudflare/native-direct flavour in this deployment, so it is
  // reached through the OpenRouter gateway (billed at Google's rates, no markup). It
  // becomes selectable once an OpenRouter API key is connected for the workspace/user.
  // Other vendors' OpenRouter routes are folded into their native catalog entries (see
  // `openrouter` flavour on deepseek/gpt-5.5/claude-opus); any model not curated here is
  // reachable via the dynamic per-workspace OpenRouter catalog (`openRouterSelectableModels`).
  {
    id: 'gemini',
    label: 'Gemini 3 Pro',
    description: "Google's Gemini 3 Pro via OpenRouter — 1M-token context, billed at Google rates.",
    openrouter: {
      ref: { provider: 'openrouter', model: 'google/gemini-3-pro', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  // LiteLLM — an operator-hosted OpenAI-compatible gateway. Model names are defined by the
  // operator's LiteLLM `config.yaml` (`model_name`), so this generic entry assumes a
  // `gpt-4o` route; rename the model (or pin via AGENT_DEFAULT_MODEL) to match your
  // gateway. Selectable once a LiteLLM API key is connected AND LITELLM_BASE_URL is set.
  {
    id: 'litellm-default',
    label: 'LiteLLM (gateway default)',
    description: "Your LiteLLM gateway's `gpt-4o` route — rename to match your config.yaml.",
    direct: {
      ref: { provider: 'litellm', model: 'gpt-4o', contextTokens: 128_000 },
      keyEnv: 'LITELLM_API_KEY',
      providerLabel: 'LiteLLM',
    },
  },
]

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Look up a catalog model by id, or `undefined` for an unknown/empty id. */
export function getSelectableModel(id: string | undefined | null): SelectableModel | undefined {
  return id ? BY_ID.get(id) : undefined
}

// Context window (total input + output tokens) for every concrete ref the catalog
// declares one for, keyed by `${provider}:${model}` across all flavours. A model can
// appear under several flavours with DIFFERENT windows (e.g. DeepSeek 80K on Cloudflare
// vs 64K direct), so each ref is mapped on its own.
const CONTEXT_WINDOW_BY_REF: Map<string, number> = (() => {
  const map = new Map<string, number>()
  for (const model of MODEL_CATALOG) {
    for (const ref of [
      model.cloudflare,
      model.direct?.ref,
      model.openrouter?.ref,
      model.subscription?.ref,
    ]) {
      if (ref?.contextTokens) map.set(`${ref.provider}:${ref.model}`, ref.contextTokens)
    }
  }
  return map
})()

/**
 * The total context window (input + output tokens) the catalog declares for a concrete
 * model ref, matched by provider + model. Returns undefined for a ref the catalog does
 * not carry or one with no declared window. Used by the LLM proxy to cap a call's
 * requested output so input + output can't exceed a small-window model's limit — a model
 * like `@cf/qwen/qwen3-30b-a3b-fp8` (32K total) otherwise rejects the whole request
 * (Workers AI error 8007 → HTTP 502) when the output floor alone fills the window.
 */
export function contextWindowFor(ref: { provider: string; model: string }): number | undefined {
  return CONTEXT_WINDOW_BY_REF.get(`${ref.provider}:${ref.model}`)
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
  /**
   * The dynamic local-runner model ids (`"<provider>:<model>"`, e.g. `ollama:gemma3`) the
   * resolving USER has enabled. A local model needs no pooled key — the user's configured
   * endpoint carries the (optional) key — so usability is gated on the SPECIFIC model
   * being enabled, not merely the runner being configured (a stale pin to a model the user
   * later un-enabled must NOT pass the start guard).
   */
  localModels?: Set<string>
  /**
   * The OpenRouter `vendor/model` slugs the workspace has ENABLED in its dynamic
   * catalog (e.g. `google/gemini-3-pro`). A dynamic OpenRouter model (`openrouter:<slug>`)
   * is usable only when the workspace has an OpenRouter key (`openrouter ∈ directProviders`)
   * AND the slug is enabled here — so a stale pin to a since-disabled model fails the
   * start guard. Curated catalog entries with an `openrouter` flavour need only the key,
   * not this set.
   */
  openRouterModels?: Set<string>
}

/** Resolve the informational list cost for a model ref (e.g. from spend pricing). */
export type ModelCostResolver = (ref: ModelRef) => ModelCost | undefined

/** The effective variant a catalog model resolves to for a given capability set. */
interface EffectiveVariant {
  ref: ModelRef
  flavor: 'cloudflare' | 'direct' | 'openrouter' | 'subscription'
  providerLabel: string
  vendor?: SubscriptionVendor
}

/** Whether a flavour of the model is usable given the capabilities. */
function directUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  if (!model.direct) return false
  const provider = model.direct.ref.provider
  if (caps.directProviders.has(provider)) return true
  // A local-runner model needs no pooled key (the user's endpoint carries the optional
  // key), but it's only usable when THIS specific model is enabled — keyed by its id.
  return isLocalRunner(provider) && (caps.localModels?.has(model.id) ?? false)
}
function openRouterUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  return !!model.openrouter && caps.directProviders.has('openrouter')
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
export function isModelUsable(id: string | undefined | null, caps: ProviderCapabilities): boolean {
  const model = getSelectableModel(id)
  if (!model) {
    // Dynamic local-runner model: usable when the resolving user has enabled this exact
    // model (`"<provider>:<model>"` is in `localModels`), not merely the runner configured.
    const local = parseLocalModelId(id)
    if (local) return caps.localModels?.has(`${local.provider}:${local.model}`) ?? false
    // Dynamic OpenRouter model: usable when the workspace has an OpenRouter key AND has
    // enabled this exact slug in its catalog.
    const or = parseOpenRouterModelId(id)
    if (or) {
      return caps.directProviders.has('openrouter') && (caps.openRouterModels?.has(or.model) ?? false)
    }
    return false
  }
  return (
    directUsable(model, caps) ||
    openRouterUsable(model, caps) ||
    cloudflareUsable(model, caps) ||
    subscriptionUsable(model, caps)
  )
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
  const openrouter = (): EffectiveVariant => ({
    ref: model.openrouter!.ref,
    flavor: 'openrouter',
    providerLabel: model.openrouter!.providerLabel,
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
  // Prefer a usable flavour: native direct > OpenRouter gateway > Cloudflare > subscription.
  if (directUsable(model, caps)) return direct()
  if (openRouterUsable(model, caps)) return openrouter()
  if (cloudflareUsable(model, caps)) return cloudflare()
  if (subscriptionUsable(model, caps)) return subscription()
  // Nothing usable: a best-effort ref so the caller still has something to show/run
  // (the guard / `available` flag gate actual use).
  if (model.direct) return direct()
  if (model.openrouter) return openrouter()
  if (model.cloudflare) return cloudflare()
  if (model.subscription) return subscription()
  throw new Error(
    `Model '${model.id}' has no resolvable variant (no cloudflare/direct/openrouter/subscription)`,
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
 * The individual-usage vendor whose PERSONAL credential a run on this catalog model id
 * will ACTUALLY lease, given whether the run's user already has a personal subscription
 * for the candidate vendor (`hasPersonalSubscription`). Returns null when no personal
 * credential is needed. This is the gating-accurate refinement of
 * {@link individualVendorForModelId}, and mirrors
 * `ContainerAgentExecutor.resolveEffectiveRef`, so the credential gate prompts for a
 * password exactly when dispatch will use one:
 *
 *  - SUBSCRIPTION-ONLY individual model (Claude / Codex — no Cloudflare/direct base):
 *    there is no fallback, so the personal credential is always required.
 *  - DUAL-MODE individual model (e.g. GLM, which also has a Cloudflare base): per-user.
 *    A user WITH their own personal subscription for the vendor runs on it (gated on
 *    their password); a user WITHOUT one falls back to the Cloudflare base and is not
 *    gated. (Individual vendors are never pooled, so there is no shared fallback — only
 *    the user's own subscription or the base.)
 *  - Poolable / non-subscription models: never need a personal credential.
 */
export function personalCredentialVendorForModelId(
  id: string | undefined | null,
  hasPersonalSubscription: (vendor: SubscriptionVendor) => boolean,
): SubscriptionVendor | null {
  const model = getSelectableModel(id)
  const sub = model?.subscription
  if (!sub || !isIndividualVendor(sub.vendor)) return null
  const hasBase = !!model.cloudflare || !!model.direct
  if (!hasBase) return sub.vendor
  return hasPersonalSubscription(sub.vendor) ? sub.vendor : null
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
  return effectiveCatalogWith([], caps, costFor)
}

/**
 * Like {@link effectiveCatalog}, but with deployment/user-specific extra models
 * appended to the static catalog — used to surface a user's locally-run models
 * (see {@link localSelectableModels}) alongside the built-in catalog.
 */
export function effectiveCatalogWith(
  extra: SelectableModel[],
  caps: ProviderCapabilities,
  costFor?: ModelCostResolver,
): ModelOption[] {
  return [...MODEL_CATALOG, ...extra].map((model) => toOption(model, caps, costFor))
}

/** A user's enabled models for one local runner endpoint. */
export interface LocalEndpointModels {
  /** The runner provider id (e.g. `ollama`), also the `ModelRef.provider`. */
  provider: string
  /** The provider label shown in the picker (e.g. `Ollama`). */
  label: string
  /** Enabled model ids on this endpoint. */
  models: string[]
}

/**
 * Build the dynamic, per-user catalog entries for a set of configured local endpoints.
 * Each enabled model becomes a `direct`-flavour {@link SelectableModel} with a stable id
 * `"<provider>:<model>"` and no key requirement (gated by `localModels`).
 */
export function localSelectableModels(endpoints: LocalEndpointModels[]): SelectableModel[] {
  const out: SelectableModel[] = []
  for (const ep of endpoints) {
    for (const model of ep.models) {
      out.push({
        id: `${ep.provider}:${model}`,
        label: model,
        description: `Local model served by ${ep.label}.`,
        direct: {
          ref: { provider: ep.provider, model },
          keyEnv: '',
          providerLabel: ep.label,
        },
      })
    }
  }
  return out
}

/** Stable-id prefix for a dynamic OpenRouter catalog model (`openrouter:<vendor/model>`). */
const OPENROUTER_ID_PREFIX = 'openrouter:'

/**
 * Build the dynamic per-workspace catalog entries for a set of enabled OpenRouter models.
 * Each becomes an `openrouter`-flavour {@link SelectableModel} with a stable id
 * `"openrouter:<vendor/model>"`; usability is gated by the workspace's OpenRouter key plus
 * the enabled set (see {@link isModelUsable}). The cached metadata carries the context
 * window; pricing is surfaced separately via the spend overlay keyed on the ref slug.
 */
export function openRouterSelectableModels(models: OpenRouterModelMeta[]): SelectableModel[] {
  return models.map((m) => ({
    id: `${OPENROUTER_ID_PREFIX}${m.id}`,
    label: m.name || m.id,
    description: `${m.name || m.id} via OpenRouter.`,
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: m.id,
        ...(m.contextLength ? { contextTokens: m.contextLength } : {}),
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  }))
}

/**
 * Parse a dynamic OpenRouter model id (`"openrouter:<vendor/model>"`) into a {@link ModelRef}.
 * The slug itself contains slashes (and never the `openrouter:` prefix), so this strips the
 * prefix rather than splitting on a colon. Returns undefined for non-OpenRouter ids.
 */
export function parseOpenRouterModelId(
  id: string | undefined | null,
): { provider: string; model: string } | undefined {
  if (!id || !id.startsWith(OPENROUTER_ID_PREFIX)) return undefined
  const model = id.slice(OPENROUTER_ID_PREFIX.length)
  return model ? { provider: 'openrouter', model } : undefined
}

/**
 * Parse a dynamic local-model id of the form `"<provider>:<model>"` into a {@link ModelRef}.
 * Splits on the FIRST colon so model ids that themselves contain colons (e.g.
 * `ollama:qwen2.5-coder:32b`) round-trip correctly. Returns undefined for non-local ids.
 */
export function parseLocalModelId(
  id: string | undefined | null,
): { provider: string; model: string } | undefined {
  if (!id) return undefined
  const idx = id.indexOf(':')
  if (idx <= 0 || idx >= id.length - 1) return undefined
  const provider = id.slice(0, idx)
  if (!isLocalRunner(provider)) return undefined
  return { provider, model: id.slice(idx + 1) }
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
  if (model) return effectiveVariant(model, caps).ref
  // Dynamic local-runner model ids (`<provider>:<model>`) aren't in the static catalog;
  // parse them straight into a ref so a block pinned to a local model resolves even at
  // deployment-config time (when per-user local capabilities aren't known).
  const local = parseLocalModelId(id)
  if (local) return { provider: local.provider, model: local.model }
  // Dynamic OpenRouter catalog model ids (`openrouter:<vendor/model>`) likewise aren't in
  // the static catalog; resolve them straight to the gateway ref.
  const or = parseOpenRouterModelId(id)
  return or ? { provider: or.provider, model: or.model } : undefined
}

/** Every subscription vendor (the full set), for building a permissive capability set. */
export const ALL_SUBSCRIPTION_VENDORS: SubscriptionVendor[] = Object.keys(
  SUBSCRIPTION_VENDORS,
) as SubscriptionVendor[]
