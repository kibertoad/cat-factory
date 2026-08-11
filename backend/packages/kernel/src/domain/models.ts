import {
  type ModelCost,
  type ModelFamily,
  type ModelFamilyPolicy,
  type ModelFlavor,
  type ModelOption,
  type OpenRouterModelMeta,
  type SubscriptionVendor,
  isLocalRunner,
  orderedModelFlavorPreference,
} from '@cat-factory/contracts'
import type { HarnessKind, ModelRef } from '../ports/model-provider.js'
import { providerCachesPrompts } from './cache-policy.js'

/**
 * Every route a catalog model can resolve to, as an ordered tuple. `satisfies` pins the
 * tuple to the wire vocabulary in one direction (a member here that contracts doesn't
 * know fails to compile); `model-flavors.test.ts` pins the other (a member contracts
 * gained that is missing here would never be TRIED, which no typecheck can see, since a
 * resolver walks this tuple rather than the union).
 */
export const MODEL_FLAVORS = [
  'direct',
  'bedrock',
  'openrouter',
  'cloudflare',
  'subscription',
] as const satisfies readonly ModelFlavor[]

/**
 * The order routes are preferred in when a model has several usable ones. A model's own
 * provider API wins, then AWS Bedrock (a first-party, residency-guaranteed route), then
 * the OpenRouter gateway that resells them, then the always-available Cloudflare floor,
 * and finally the subscription harness.
 *
 * NOTE: the subscription position here is NOT where the design lands. "A subscription is
 * flat-rate quota already paid for, so spending metered tokens beside it is waste" makes
 * `subscription` the FIRST preference, but today that rule is applied on top, separately,
 * by `ModelRouter.resolveEffectiveRef` (which alone knows whether THIS workspace/user
 * holds a token) and by each inline call site's `inlineModelRef` degradation (which alone
 * knows whether the caller can drive a harness at all). Moving it here means re-plumbing
 * both, so the flip is its own slice; see
 * `docs/initiatives/model-provider-preference.md`. Until then this tuple keeps the
 * historical order so a Bedrock route changes nothing else about how a model resolves.
 */
export const DEFAULT_PROVIDER_PREFERENCE: readonly ModelFlavor[] = MODEL_FLAVORS

/**
 * The full order a resolution walks, given a preset's own preference. Re-exported from
 * `@cat-factory/contracts` rather than reimplemented, because the PRESET EDITOR renders the same
 * fold: a second copy here would let the picker display an order the run does not take.
 *
 * A preference REORDERS, it never filters — see {@link orderedModelFlavorPreference} for why that
 * is a total order over every route rather than the caller's list. A stored entry the current build
 * no longer knows is filtered out at the persistence boundary (`isModelFlavor`).
 */
export const orderedProviderPreference = orderedModelFlavorPreference

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
// Each model declares one flavour per route it can be reached on (see
// {@link MODEL_FLAVORS}): an always-available Cloudflare Workers AI variant (via the `AI`
// binding); a `direct` variant for models that offer their own API; a `bedrock` variant
// for models an AWS account can call on Bedrock; an `openrouter` variant reaching the same
// model through the OpenRouter gateway; and a `subscription` variant. `effectiveVariant`
// resolves the flavour actually in use per workspace by walking
// {@link DEFAULT_PROVIDER_PREFERENCE}, so connecting an OpenRouter key (with no native
// direct key) transparently routes the model through OpenRouter while a native direct key
// still wins. This makes "go direct / go gateway" a zero-config upgrade with an automatic
// Cloudflare fallback.

export interface ModelVariant {
  ref: ModelRef
  /** Env var whose presence switches this model to its direct provider. */
  keyEnv: string
  /** Short provider label shown in the picker, e.g. `DashScope`. */
  providerLabel: string
}

/**
 * An AWS Bedrock variant. `baseModelId` is the UNPREFIXED Bedrock id
 * (`anthropic.claude-opus-4-8`); the id an account actually calls carries a geo/global
 * inference prefix (`us.` / `eu.` / `global.` / …) that differs per Region, so any prefix
 * baked in here would be wrong for every deployment but one. {@link resolveBedrockModelId}
 * matches this base against the deployment's `BEDROCK_MODELS` allow-list and runs the
 * matching entry verbatim, which is what lets ONE catalog be correct in every Region and
 * why enablement is naturally per model: an id absent from that list is a model this
 * account cannot call.
 */
export interface BedrockVariant {
  /** The unprefixed Bedrock model id, matched against the allow-list. */
  baseModelId: string
  /** Context window at Bedrock, when known (often differs from the vendor's own API). */
  contextTokens?: number
  /** Whether Bedrock serves this model with image input. See {@link ModelRef.acceptsImages}. */
  acceptsImages?: boolean
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
  /**
   * The coarse model FAMILY this entry belongs to, used by the account-wide allow/block
   * policy (`familyForModelId` / `isAllowedByFamilyPolicy`). Absent for gateway entries
   * with no single family (an operator's LiteLLM route) — those are UNCLASSIFIED.
   */
  family?: ModelFamily
  /** Model-family label shown in the picker, e.g. `Qwen3`. */
  label: string
  /** One-line description shown alongside the label. */
  description: string
  /** Always-available Cloudflare Workers AI variant (absent for subscription-only models). */
  cloudflare?: ModelRef
  /** Optional direct-provider variant, used when its key is configured. */
  direct?: ModelVariant
  /**
   * Optional AWS Bedrock variant, used when the deployment's `BEDROCK_MODELS` allow-list
   * carries this model (see {@link BedrockVariant}). Bedrock LAGS the vendors' own APIs, so
   * a bedrock flavour is only ever declared on an entry whose model Bedrock actually
   * serves, never assumed equal to the direct/subscription flavour's model, which is
   * routinely a generation ahead.
   */
  bedrock?: BedrockVariant
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
    family: 'llama',
    label: 'Llama 4 Scout',
    description:
      "Meta's 17B-active MoE with a 131K window and tool calling — Cloudflare Workers AI's " +
      'open-weights default.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      contextTokens: 131_072,
      acceptsImages: true,
    },
  },
  {
    id: 'qwen',
    family: 'qwen',
    label: 'Qwen3.7',
    description:
      "Alibaba's Qwen — Qwen3-30B on Cloudflare, flagship Qwen3.7-Max (1M context) when " +
      'direct or through OpenRouter.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      contextTokens: 32_768,
    },
    direct: {
      ref: { provider: 'qwen', model: 'qwen3.7-max', contextTokens: 1_000_000 },
      keyEnv: 'QWEN_API_KEY',
      providerLabel: 'DashScope',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'qwen/qwen3.7-max', contextTokens: 1_000_000 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'gpt-oss-120b',
    family: 'openai',
    label: 'GPT-OSS 120B',
    description:
      "OpenAI's open-weights 120B reasoning model with tool calling and a 128K window — the " +
      'strongest general-purpose model on Cloudflare that carries no vendor subscription.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/openai/gpt-oss-120b',
      contextTokens: 128_000,
    },
    bedrock: { baseModelId: 'openai.gpt-oss-120b', contextTokens: 131_072 },
    openrouter: {
      ref: { provider: 'openrouter', model: 'openai/gpt-oss-120b', contextTokens: 131_072 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'kimi-k2.7',
    family: 'kimi',
    label: 'Kimi K2.7',
    description:
      "Moonshot AI's latest 1T-param agentic-coding model (structured outputs), 256K context — " +
      'on Cloudflare or pay-as-you-go through OpenRouter (billed at Moonshot rates).',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/moonshotai/kimi-k2.7-code',
      contextTokens: 262_144,
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', contextTokens: 262_144 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'kimi',
    family: 'kimi',
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
    id: 'kimi-k3',
    family: 'kimi',
    label: 'Kimi K3',
    description:
      "Moonshot AI's 2.8T-param flagship — 1M-token context, always-on reasoning — direct via " +
      'a Moonshot key or pay-as-you-go through OpenRouter. Not served on Workers AI.',
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k3', contextTokens: 1_048_576 },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'moonshotai/kimi-k3', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'deepseek',
    family: 'deepseek',
    label: 'DeepSeek V4 Flash',
    description:
      "DeepSeek's cost-efficient 1M-context V4 model when direct, through OpenRouter or on a " +
      'DeepSeek coding-plan subscription; falls back to the 80K R1 Qwen-32B distill on Cloudflare.',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      contextTokens: 80_000,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-v4-flash', contextTokens: 1_048_576 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        contextTokens: 1_048_576,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    // Run via Claude Code against DeepSeek's Anthropic-compatible endpoint on a
    // DeepSeek coding-plan subscription (full context, flat-rate quota).
    subscription: {
      ref: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        harness: 'claude-code',
        contextTokens: 1_048_576,
      },
      vendor: 'deepseek',
    },
  },
  {
    id: 'deepseek-v4-pro',
    family: 'deepseek',
    label: 'DeepSeek V4 Pro',
    description:
      "DeepSeek's flagship V4 Pro agentic-coding model: 131K context on Cloudflare, or the " +
      'full 1M window direct via a DeepSeek key or through OpenRouter.',
    // A Cloudflare AI-catalog model: a `<provider>/<model>` slug (not a native `@cf/...`
    // id) Cloudflare serves on its unified-billing run catalog via a partner (Fireworks),
    // reached with the account's own Workers AI binding/token — no AI Gateway, no BYOK.
    // The Worker runs it through `binding.run` directly (see WorkersAiLlmUpstream).
    cloudflare: {
      provider: 'workers-ai',
      model: 'deepseek/deepseek-v4-pro',
      contextTokens: 131_072,
    },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-v4-pro', contextTokens: 1_048_576 },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'glm',
    family: 'glm',
    label: 'GLM-5.2',
    description:
      "Z.ai's agentic-coding model: 256K context on Cloudflare, or the full 1M-token " +
      'window via a GLM (Z.ai) subscription.',
    cloudflare: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2', contextTokens: 262_144 },
    openrouter: {
      ref: { provider: 'openrouter', model: 'z-ai/glm-5.2', contextTokens: 1_048_576 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    // Run via Claude Code against Z.ai's Anthropic-compatible endpoint on a GLM
    // coding-plan subscription (full 1M context, flat-rate quota).
    subscription: {
      ref: { provider: 'zai', model: 'glm-5.2', harness: 'claude-code', contextTokens: 1_000_000 },
      vendor: 'glm',
    },
  },
  {
    id: 'glm-flash',
    family: 'glm',
    label: 'GLM-4.7 Flash',
    description:
      "Z.ai's cheap, fast tool-calling model with a 131K window — the low-cost tier for light " +
      'inline steps (estimation, triage, fragment selection).',
    cloudflare: {
      provider: 'workers-ai',
      model: '@cf/zai-org/glm-4.7-flash',
      contextTokens: 131_072,
    },
    openrouter: {
      ref: { provider: 'openrouter', model: 'z-ai/glm-4.7-flash', contextTokens: 202_752 },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  // Subscription-only models: run in the Claude Code / Codex harness with a pooled
  // subscription token (Claude Pro/Max, ChatGPT Plus/Pro), direct to the vendor.
  {
    id: 'claude-fable',
    family: 'claude',
    label: 'Claude Fable 5',
    description:
      "Anthropic's most capable model — run via Claude Code on your Claude subscription, " +
      'or pay-as-you-go through OpenRouter (billed at Anthropic rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'anthropic/claude-fable-5',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-fable-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-opus',
    family: 'claude',
    label: 'Claude Opus 5',
    description:
      "Anthropic's flagship agentic-coding model — a step change over Opus 4.8 at the " +
      'same price, run via Claude Code on your Claude subscription, or pay-as-you-go ' +
      'through OpenRouter (billed at Anthropic rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-sonnet',
    family: 'claude',
    label: 'Claude Sonnet 5',
    description:
      "Anthropic's balanced speed/intelligence model with a 1M-token context, run via Claude " +
      'Code. Subscription-only here; the pay-as-you-go route is the dynamic OpenRouter catalog.',
    subscription: {
      ref: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        harness: 'claude-code',
        contextTokens: 1_000_000,
        acceptsImages: true,
      },
      vendor: 'claude',
    },
  },
  {
    id: 'claude-opus-4-8',
    family: 'claude',
    label: 'Claude Opus 4.8 (Bedrock)',
    description:
      "Anthropic's previous-generation flagship, on AWS Bedrock in your own account and " +
      'Region: the residency-guaranteed route for Claude work. Bedrock lags Anthropic; ' +
      'Opus 5 is subscription/OpenRouter only.',
    // Bedrock-ONLY on purpose. This is a different MODEL from `claude-opus`, not another
    // route to it, so it is its own entry: folding a `bedrock` flavour onto `claude-opus`
    // would silently run 4.8 for a block pinned to 5. No `contextTokens`: Bedrock's window
    // for this model is per-account and we have none verified, and an invented number would
    // cap the proxy's output budget against a limit nobody measured.
    bedrock: { baseModelId: 'anthropic.claude-opus-4-8', acceptsImages: true },
  },
  // The GPT-5.6 tiers are what Codex actually serves today: `sol` (flagship), `terra`
  // (balanced everyday) and `luna` (cheapest). The model id IS the Codex `--model` slug —
  // the `-codex` suffixed family ended at GPT-5.3, so a `gpt-5.5-codex`-shaped id makes the
  // CLI fail with `Unknown model`. GPT-5.5 stays as the previous-generation frontier tier.
  {
    id: 'gpt-5.6-sol',
    family: 'openai',
    label: 'GPT-5.6 Sol',
    description:
      "OpenAI's flagship for complex coding and research — run via Codex on your ChatGPT " +
      'subscription, or pay-as-you-go through OpenRouter (billed at OpenAI rates).',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.6-terra',
    family: 'openai',
    label: 'GPT-5.6 Terra',
    description:
      "OpenAI's balanced everyday model — GPT-5.5-class capability at a fraction of the cost. " +
      'The migration target for GPT-5.4, which Codex retires on 31 Aug 2026.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-terra',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.6-luna',
    family: 'openai',
    label: 'GPT-5.6 Luna',
    description:
      "OpenAI's fastest, cheapest GPT-5.6 tier — for clear, repeatable tasks. The migration " +
      'target for GPT-5.4 mini.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.6-luna',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  {
    id: 'gpt-5.5',
    family: 'openai',
    label: 'GPT-5.5',
    description:
      "OpenAI's previous-generation frontier model, still served by Codex — run on your " +
      'ChatGPT subscription, pay-as-you-go through OpenRouter (billed at OpenAI rates), or ' +
      'on AWS Bedrock. The newest OpenAI generation Bedrock serves: the GPT-5.6 tiers are ' +
      'Codex/OpenRouter only.',
    bedrock: { baseModelId: 'openai.gpt-5.5', contextTokens: 1_050_000, acceptsImages: true },
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'openai/gpt-5.5',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
    subscription: {
      ref: {
        provider: 'openai',
        model: 'gpt-5.5',
        harness: 'codex',
        contextTokens: 1_050_000,
        acceptsImages: true,
      },
      vendor: 'codex',
    },
  },
  // Gemini has no Cloudflare/native-direct flavour in this deployment, so it is reached
  // through the OpenRouter gateway (billed at Google's rates, no markup). It becomes
  // selectable once an OpenRouter API key is connected for the workspace/user.
  // Other vendors' OpenRouter routes are folded into their native catalog entries (see
  // `openrouter` flavour on deepseek/gpt-5.5/claude-opus); any model not curated here is
  // reachable via the dynamic per-workspace OpenRouter catalog (`openRouterSelectableModels`).
  {
    id: 'gemini',
    family: 'gemini',
    label: 'Gemini 3.1 Pro',
    description:
      "Google's flagship Gemini Pro via OpenRouter — 1M-token context, billed at Google rates. " +
      'Still the newest Pro: 3.5 Pro has slipped repeatedly and the 3.x Pro line stops here.',
    openrouter: {
      ref: {
        // The `-preview` suffix is NOT staleness: 3.1 Pro is GA and Google kept the suffix
        // in the API id, so this IS the generally-available flagship. Do not "fix" it to
        // `google/gemini-3.1-pro` — that slug does not exist, and pinning it would recreate
        // the dead-id failure this catalog was just swept for. (2.5 Pro is the misleading
        // precedent: it has both a GA and a `-preview` slug, 3.1 Pro only the latter.)
        // `google/gemini-pro-latest` is likewise deliberately unused — a floating alias
        // would swap the model under a pinned block with no version change to review.
        provider: 'openrouter',
        model: 'google/gemini-3.1-pro-preview',
        contextTokens: 1_048_576,
        acceptsImages: true,
      },
      keyEnv: 'OPENROUTER_API_KEY',
      providerLabel: 'OpenRouter',
    },
  },
  {
    id: 'gemini-flash',
    family: 'gemini',
    label: 'Gemini 3.6 Flash',
    description:
      "Google's newest model and its positioned workhorse — 1M-token context at a fraction of " +
      'Pro pricing. Via OpenRouter, billed at Google rates.',
    openrouter: {
      ref: {
        provider: 'openrouter',
        model: 'google/gemini-3.6-flash',
        contextTokens: 1_048_576,
        acceptsImages: true,
      },
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

// The OpenRouter slug vendor-prefix → family map. A dynamic `openrouter:<vendor>/<model>`
// id carries no catalog `family`, but its slug prefix names the vendor, so blocking a
// family (e.g. `deepseek`) also blocks its OpenRouter passthrough (`openrouter:deepseek/…`).
// A prefix not listed here is UNCLASSIFIED (returns null).
const OPENROUTER_SLUG_FAMILY: Record<string, ModelFamily> = {
  deepseek: 'deepseek',
  qwen: 'qwen',
  moonshotai: 'kimi',
  anthropic: 'claude',
  openai: 'openai',
  google: 'gemini',
  'z-ai': 'glm',
  zai: 'glm',
  'meta-llama': 'llama',
}

/**
 * The coarse model family a model id belongs to for the account-wide allow/block policy,
 * or `null` when it can't be classified (an operator's LiteLLM gateway route, an
 * OpenRouter slug whose vendor prefix isn't recognised, or a per-user local runner). A
 * catalog id resolves via its declared `family`; a dynamic `openrouter:<slug>` id via the
 * slug's vendor prefix.
 */
export function familyForModelId(id: string | undefined | null): ModelFamily | null {
  const model = getSelectableModel(id)
  if (model) return model.family ?? null
  const or = parseOpenRouterModelId(id)
  if (or) {
    // The vendor prefix is everything before the FIRST slash; a slug carrying no slash at
    // all is its own prefix, and is unclassified unless the map happens to name it. Sliced
    // rather than split so there is no absent-element case to guard: `parseOpenRouterModelId`
    // has already refused an empty slug, so a prefix always exists.
    const slash = or.model.indexOf('/')
    const vendor = (slash === -1 ? or.model : or.model.slice(0, slash)).toLowerCase()
    return OPENROUTER_SLUG_FAMILY[vendor] ?? null
  }
  return null
}

/**
 * Whether a model is permitted by the account-wide family policy, evaluated against its
 * `(family, effective-provider)`. `off` ⇒ always allowed. `trustedProviders` (residency-
 * guaranteed routes, e.g. `bedrock`) exempt an otherwise-blocked family. An UNCLASSIFIED
 * family (null) is allowed under a blocklist (nothing to match) but blocked under an
 * allowlist (can't prove membership), unless its provider is trusted.
 */
export function isAllowedByFamilyPolicy(
  id: string | undefined | null,
  effectiveProvider: string | undefined | null,
  policy: ModelFamilyPolicy | undefined,
): boolean {
  if (!policy || policy.mode === 'off') return true
  const trusted = !!effectiveProvider && policy.trustedProviders.includes(effectiveProvider)
  if (trusted) return true
  const family = familyForModelId(id)
  // UNCLASSIFIED: there is no membership to test either way, so the MODE decides on its own.
  // A blocklist has nothing to match, an allowlist has nothing to prove.
  if (family === null) return policy.mode === 'blocklist'
  const listed = policy.families.includes(family)
  return policy.mode === 'blocklist' ? !listed : listed
}

/**
 * Whether a concrete Bedrock model id addresses a catalog BASE id: it either IS the base or
 * carries a geo/global inference prefix in front of it (`eu.anthropic.claude-opus-4-8`
 * addresses `anthropic.claude-opus-4-8`). The ONE place that relation is defined, shared by
 * allow-list resolution and the context-window lookup, so neither enumerates AWS's prefixes
 * and a prefix AWS adds tomorrow needs no change here.
 */
function matchesBedrockBase(candidate: string, baseModelId: string): boolean {
  return candidate === baseModelId || candidate.endsWith(`.${baseModelId}`)
}

/**
 * The Bedrock model id THIS deployment should call for a catalog base id, or undefined when
 * the account's allow-list (`BEDROCK_MODELS` → {@link ProviderCapabilities.bedrockModels})
 * doesn't carry the model, which is exactly the statement "this account cannot call it", so
 * the flavour is unusable rather than the id being guessed at.
 *
 * The matching entry is returned VERBATIM, so the operator's own Region-correct id is what
 * gets called. The FIRST match in declaration order wins, which is how an operator who lists
 * both a regional and a global inference profile for one model chooses between them.
 */
export function resolveBedrockModelId(
  baseModelId: string,
  caps: ProviderCapabilities,
): string | undefined {
  for (const allowed of caps.bedrockModels ?? []) {
    if (matchesBedrockBase(allowed, baseModelId)) return allowed
  }
  return undefined
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

// Bedrock windows are keyed by the catalog BASE id, not by a concrete ref: the ref a run
// carries is the operator's PREFIXED allow-list entry, which differs per Region, so no exact
// key could cover it. Looked up through `matchesBedrockBase` below.
const BEDROCK_CONTEXT_BY_BASE: Map<string, number> = new Map(
  MODEL_CATALOG.flatMap((model) =>
    model.bedrock?.contextTokens ? [[model.bedrock.baseModelId, model.bedrock.contextTokens]] : [],
  ),
)

/**
 * The total context window (input + output tokens) the catalog declares for a concrete
 * model ref, matched by provider + model. Returns undefined for a ref the catalog does
 * not carry or one with no declared window. Used by the LLM proxy to cap a call's
 * requested output so input + output can't exceed a small-window model's limit — a model
 * like `@cf/qwen/qwen3-30b-a3b-fp8` (32K total) otherwise rejects the whole request
 * (Workers AI error 8007 → HTTP 502) when the output floor alone fills the window.
 */
export function contextWindowFor(ref: { provider: string; model: string }): number | undefined {
  const exact = CONTEXT_WINDOW_BY_REF.get(`${ref.provider}:${ref.model}`)
  if (exact !== undefined) return exact
  if (ref.provider !== 'bedrock') return undefined
  for (const [base, tokens] of BEDROCK_CONTEXT_BY_BASE) {
    if (matchesBedrockBase(ref.model, base)) return tokens
  }
  return undefined
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
  /**
   * Subscription vendors this deployment can actually dispatch to: one with a usable token
   * (pool or personal), OR one NATIVE LOCAL EXECUTION serves from the host's own ambient CLI
   * login, which has no token at all ({@link isAmbientNativeVendor}). The third case is why
   * this is not named after the credential: a member here means "a run can use this vendor",
   * never "a credential for it was found".
   */
  subscriptionVendors: Set<SubscriptionVendor>
  /** Whether the opt-in Cloudflare Workers AI lib is registered for this deployment. */
  cloudflareEnabled: boolean
  /**
   * The Bedrock model ids this deployment may call, VERBATIM as the operator listed them in
   * `BEDROCK_MODELS` (so each carries whatever geo/global inference prefix their Region
   * needs). Absent/empty ⇒ no bedrock flavour is usable, which covers both "Bedrock isn't
   * configured" and "configured but this model isn't granted": the allow-list IS the
   * per-model enablement. ITERATION ORDER MATTERS: it is the operator's declared order,
   * which {@link resolveBedrockModelId} uses to pick between two profiles for one model.
   */
  bedrockModels?: Set<string>
  /**
   * The order this resolution prefers a model's routes in, from the MODEL PRESET in force (its
   * `providerPreference`). Absent/empty ⇒ {@link DEFAULT_PROVIDER_PREFERENCE}.
   *
   * It rides the capability set rather than a resolution parameter because every site that
   * resolves a model already threads one, so a new call site cannot silently resolve under a
   * different order than the one the picker displayed. It REORDERS and never filters: see
   * {@link orderedProviderPreference}.
   */
  providerPreference?: readonly ModelFlavor[]
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
   * catalog (e.g. `google/gemini-3.1-pro-preview`). A dynamic OpenRouter model (`openrouter:<slug>`)
   * is usable only when the workspace has an OpenRouter key (`openrouter ∈ directProviders`)
   * AND the slug is enabled here — so a stale pin to a since-disabled model fails the
   * start guard. Curated catalog entries with an `openrouter` flavour need only the key,
   * not this set.
   */
  openRouterModels?: Set<string>
  /**
   * The account-wide model-family allow/block policy in force for this workspace's owning
   * account, when the deployment supports it and the account has set one (mode !== `off`).
   * Absent ⇒ no policy restriction. Applied by `toOption` (the catalog `available` /
   * `policyBlocked` flags) and the pipeline start guard, on top of the configuration-based
   * usability above.
   */
  modelPolicy?: ModelFamilyPolicy
}

/** Resolve the informational list cost for a model ref (e.g. from spend pricing). */
export type ModelCostResolver = (ref: ModelRef) => ModelCost | undefined

/** The effective variant a catalog model resolves to for a given capability set. */
interface EffectiveVariant {
  ref: ModelRef
  flavor: ModelFlavor
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
function bedrockUsable(model: SelectableModel, caps: ProviderCapabilities): boolean {
  return !!model.bedrock && !!resolveBedrockModelId(model.bedrock.baseModelId, caps)
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
 * One route's arms: whether the model declares it, whether the capabilities make it usable,
 * and how to build its variant. An exhaustive `Record<ModelFlavor, …>`, so a route added to
 * the wire vocabulary fails to compile until every arm is handled.
 */
interface FlavorHandler {
  declared: (model: SelectableModel) => boolean
  usable: (model: SelectableModel, caps: ProviderCapabilities) => boolean
  build: (model: SelectableModel, caps: ProviderCapabilities) => EffectiveVariant
}

const FLAVOR_HANDLERS: Record<ModelFlavor, FlavorHandler> = {
  direct: {
    declared: (m) => !!m.direct,
    usable: directUsable,
    build: (m) => ({
      ref: m.direct!.ref,
      flavor: 'direct',
      providerLabel: m.direct!.providerLabel,
    }),
  },
  bedrock: {
    declared: (m) => !!m.bedrock,
    usable: bedrockUsable,
    build: (m, caps) => ({
      ref: {
        provider: 'bedrock',
        // An unresolvable base falls back to the base id itself: this arm is reached on the
        // best-effort walk (nothing is configured), where the caller needs SOMETHING to
        // display and `available: false` is what says it can't be run. Returning no ref
        // instead would make the resolver throw for a Bedrock-only entry on every
        // deployment that hasn't configured Bedrock, which is most of them.
        model: resolveBedrockModelId(m.bedrock!.baseModelId, caps) ?? m.bedrock!.baseModelId,
        ...(m.bedrock!.contextTokens ? { contextTokens: m.bedrock!.contextTokens } : {}),
        ...(m.bedrock!.acceptsImages === undefined
          ? {}
          : { acceptsImages: m.bedrock!.acceptsImages }),
      },
      flavor: 'bedrock',
      providerLabel: 'AWS Bedrock',
    }),
  },
  openrouter: {
    declared: (m) => !!m.openrouter,
    usable: openRouterUsable,
    build: (m) => ({
      ref: m.openrouter!.ref,
      flavor: 'openrouter',
      providerLabel: m.openrouter!.providerLabel,
    }),
  },
  cloudflare: {
    declared: (m) => !!m.cloudflare,
    usable: cloudflareUsable,
    build: (m) => ({ ref: m.cloudflare!, flavor: 'cloudflare', providerLabel: 'Cloudflare' }),
  },
  subscription: {
    declared: (m) => !!m.subscription,
    usable: subscriptionUsable,
    build: (m) => ({
      ref: m.subscription!.ref,
      flavor: 'subscription',
      providerLabel: SUBSCRIPTION_VENDORS[m.subscription!.vendor].label,
      vendor: m.subscription!.vendor,
    }),
  },
}

/**
 * Whether a catalog model is selectable for the given capabilities — it has at least
 * one usable flavour (a configured direct key, the model in the Bedrock allow-list, an
 * OpenRouter key, an enabled Cloudflare lib, or a connected subscription vendor).
 * Unknown ids are not usable.
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
      return (
        caps.directProviders.has('openrouter') && (caps.openRouterModels?.has(or.model) ?? false)
      )
    }
    return false
  }
  return MODEL_FLAVORS.some((flavor) => FLAVOR_HANDLERS[flavor].usable(model, caps))
}

/**
 * The effective variant a model resolves to for a capability set: the most preferred flavour
 * the capabilities make USABLE, else the most preferred one the model merely DECLARES, so
 * callers always get a ref to show/run (selectability is reported separately by
 * {@link isModelUsable}, and the start guard gates actual use).
 *
 * Both walks follow the SAME order, or an unconfigured deployment would show one route in
 * the picker and run another. That order is the preset's own {@link ProviderCapabilities.providerPreference}
 * when one is in force, else {@link DEFAULT_PROVIDER_PREFERENCE}. A dual-mode model's subscription
 * flavour ("subscriptions win") is still preferred per-workspace by the executor + frontend rather
 * than here; see {@link DEFAULT_PROVIDER_PREFERENCE}.
 */
function effectiveVariant(model: SelectableModel, caps: ProviderCapabilities): EffectiveVariant {
  const order = orderedProviderPreference(caps.providerPreference)
  for (const eligible of [
    (h: FlavorHandler) => h.usable(model, caps),
    (h: FlavorHandler) => h.declared(model),
  ]) {
    for (const flavor of order) {
      const handler = FLAVOR_HANDLERS[flavor]
      if (eligible(handler)) return handler.build(model, caps)
    }
  }
  throw new Error(
    `Model '${model.id}' has no resolvable variant (declares none of ${MODEL_FLAVORS.join(', ')})`,
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
  // The account-wide family policy gates on the EFFECTIVE route's provider, so a
  // residency-guaranteed route (e.g. Bedrock) can exempt an otherwise-blocked family.
  const policyBlocked = !isAllowedByFamilyPolicy(model.id, variant.ref.provider, caps.modelPolicy)
  const option: ModelOption = {
    id: model.id,
    label: model.label,
    description: model.description,
    flavor: variant.flavor,
    available: isModelUsable(model.id, caps) && !policyBlocked,
    ...(policyBlocked ? { policyBlocked: true } : {}),
    providerLabel: variant.providerLabel,
    provider: variant.ref.provider,
    model: variant.ref.model,
    // Whether the effective flavour's provider caches the (re-sent) prompt prefix —
    // false on a Cloudflare/Workers-AI flavour, true once a direct key upgrades the
    // same model to its caching `direct` flavour. The UI surfaces this so a user can
    // see (and act on) the hot path running cache-less.
    cachesPrompts: providerCachesPrompts(variant.ref.provider),
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
      cachesPrompts: providerCachesPrompts(subRef.provider),
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

// Reverse map from a concrete subscription ref (`${provider}:${model}`) to its vendor,
// built once from the catalog's subscription flavours. Unlike {@link nativeVendorForRef}
// (which resolves ONLY the two native-ambient vendors `claude`/`codex` from a bare ref),
// this covers EVERY subscription vendor — including the non-native claude-code vendors that
// carry their own base URL (GLM/Kimi/DeepSeek) — so a facade that can inject a leased token
// (the prewarmed-container inline backend) can serve any of them inline, not just the two
// the host CLI's ambient login covers.
const VENDOR_BY_SUBSCRIPTION_REF: Map<string, SubscriptionVendor> = (() => {
  const map = new Map<string, SubscriptionVendor>()
  for (const model of MODEL_CATALOG) {
    if (model.subscription) {
      const ref = model.subscription.ref
      map.set(`${ref.provider}:${ref.model}`, model.subscription.vendor)
    }
  }
  return map
})()

/**
 * Whether a ref runs on a SUBSCRIPTION harness: a vendor CLI the executor drives with a
 * leased or ambient credential (`claude-code` / `codex`), as opposed to Pi (the platform's
 * own agent harness, reached through the ordinary metered LLM route) or no harness at all,
 * which Pi is also the default for.
 *
 * Stated once because three decisions turn on it and two of them spell it as the negation
 * of the third. A ref carrying `harness: 'pi'` is the case the two spellings must agree
 * about: it names a harness, so a bare truthiness test would route it down the
 * subscription path and ask for a token no Pi run has.
 */
export function runsOnSubscriptionHarness(ref: ModelRef): boolean {
  return ref.harness !== undefined && ref.harness !== 'pi'
}

/**
 * The subscription vendor a harness ref belongs to (ANY vendor — `claude` / `codex` / `glm` /
 * `kimi` / `deepseek`), or undefined for a non-subscription (Pi / absent-harness) ref. Matched
 * by the catalog's subscription refs, so it stays in step with {@link MODEL_CATALOG} rather than
 * re-deriving the provider→vendor mapping. This is the broad counterpart to
 * {@link nativeVendorForRef}: use `nativeVendorForRef` to decide host-CLI (ambient-login)
 * eligibility, and this to decide leased-credential eligibility (the container inline backend,
 * which injects the token + base URL exactly like the container coding path).
 */
export function subscriptionVendorForRef(ref: ModelRef): SubscriptionVendor | undefined {
  if (!runsOnSubscriptionHarness(ref)) return undefined
  return VENDOR_BY_SUBSCRIPTION_REF.get(`${ref.provider}:${ref.model}`)
}

/**
 * Whether NATIVE local execution serves `vendor` with the developer's own ambient CLI login
 * (no leased credential, no personal-credential gate) given the configured allow-list of
 * harnesses (`AppConfig.nativeAmbientAuth`). True ONLY for a native vendor — one whose CLI
 * harness is in the allow-list AND that has no Anthropic-compatible `baseUrl` of its own
 * (`claude` / `codex`). A non-native vendor that merely REUSES the `claude-code` harness
 * (GLM/Kimi/DeepSeek carries its own `baseUrl`) is leased normally, so it is NOT ambient —
 * otherwise ambient auth would silently drop that base URL and run the step on the
 * developer's own Anthropic login instead of the pinned vendor. Single source of truth
 * shared by the personal-credential gate and the container executor so the two halves of
 * the ambient decision can't drift.
 */
export function isAmbientNativeVendor(
  allow: readonly HarnessKind[] | undefined,
  vendor: SubscriptionVendor,
): boolean {
  if (!allow || allow.length === 0) return false
  const cfg = SUBSCRIPTION_VENDORS[vendor]
  return allow.includes(cfg.harness) && !cfg.baseUrl
}

/**
 * The NATIVE ambient subscription vendor a harness ref belongs to, or undefined. A native
 * vendor authenticates with the developer's own installed CLI login (`~/.claude` /
 * `~/.codex`) and carries NO Anthropic-compatible base URL — so only `claude` (the
 * `anthropic` + `claude-code` ref) and `codex` (any `codex` ref) qualify. A `claude-code`
 * ref for any other provider is a non-native vendor (GLM/Kimi/DeepSeek) that reuses the
 * harness with its own base URL, so it is deliberately excluded. Mirrors the
 * no-`baseUrl` predicate {@link isAmbientNativeVendor} enforces, resolved from a bare ref
 * (which carries no vendor). Used by a facade to decide whether it can run a harness ref
 * as an inline CLI call (local ambient inline execution).
 */
export function nativeVendorForRef(ref: ModelRef): SubscriptionVendor | undefined {
  if (!runsOnSubscriptionHarness(ref)) return undefined
  if (ref.harness === 'codex') return 'codex'
  if (ref.harness === 'claude-code' && ref.provider === 'anthropic') return 'claude'
  return undefined
}

/**
 * Whether a catalog model id is usable for an INLINE LLM step (requirements reviewer,
 * brainstorm, task-estimator, inline document kinds), given the workspace capabilities.
 * Stricter than {@link isModelUsable}: an inline call cannot use a container-only
 * subscription token, so a subscription-only model is inline-usable ONLY when the
 * deployment can run its harness inline (`runsInline`, e.g. local ambient CLI). A model
 * with a usable non-subscription flavour (direct / OpenRouter / Cloudflare) is inline-usable
 * as normal; a model with no usable flavour at all is not. This is the check that closes
 * the silent-degrade path — a subscription-only inline step with no inline-harness support
 * used to fall back to an ungated env default and fail mid-run.
 */
export function isModelUsableInline(
  id: string | undefined | null,
  caps: ProviderCapabilities,
  runsInline?: (ref: ModelRef) => boolean,
): boolean {
  const ref = resolveModelRef(id, caps)
  if (!ref) return false
  if (runsOnSubscriptionHarness(ref)) return runsInline?.(ref) ?? false
  return isModelUsable(id, caps)
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
 *  - SUBSCRIPTION-ONLY individual model (no Cloudflare/direct/OpenRouter base):
 *    there is no fallback, so the personal credential is always required.
 *  - DUAL-MODE individual model (e.g. GLM with a Cloudflare base, or Claude Opus /
 *    GPT-5.5 with an OpenRouter pay-as-you-go base): per-user. A user WITH their own
 *    personal subscription for the vendor runs on it (gated on their password); a user
 *    WITHOUT one falls back to the non-subscription base (Cloudflare / OpenRouter) and is
 *    NOT gated. (Individual vendors are never pooled, so the only alternatives are the
 *    user's own subscription or the base.) NOTE: `openrouter` MUST count as a base here —
 *    omitting it would gate Claude Opus / GPT-5.5 on a personal credential the OpenRouter
 *    route never uses, making the pay-as-you-go path unstartable for non-subscribers.
 *  - Poolable / non-subscription models: never need a personal credential.
 */
export function personalCredentialVendorForModelId(
  id: string | undefined | null,
  hasPersonalSubscription: (vendor: SubscriptionVendor) => boolean,
): SubscriptionVendor | null {
  const model = getSelectableModel(id)
  const sub = model?.subscription
  if (!sub || !isIndividualVendor(sub.vendor)) return null
  const hasBase = MODEL_FLAVORS.some(
    (flavor) => flavor !== 'subscription' && FLAVOR_HANDLERS[flavor].declared(model),
  )
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
