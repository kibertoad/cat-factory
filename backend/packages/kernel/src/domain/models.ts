import type { ModelOption } from '@cat-factory/contracts'
import type { ModelRef } from '../ports/model-provider.js'

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

export interface SelectableModel {
  /** Stable id stored on a block, e.g. `qwen`. */
  id: string
  /** Model-family label shown in the picker, e.g. `Qwen3`. */
  label: string
  /** One-line description shown alongside the label. */
  description: string
  /** Always-available Cloudflare Workers AI variant. */
  cloudflare: ModelRef
  /** Optional direct-provider variant, used when its key is configured. */
  direct?: ModelVariant
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
    id: 'kimi',
    label: 'Kimi K2.6',
    description: "Moonshot AI's frontier-scale agentic model.",
    cloudflare: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' },
    direct: {
      ref: { provider: 'moonshot', model: 'kimi-k2.6' },
      keyEnv: 'MOONSHOT_API_KEY',
      providerLabel: 'Moonshot',
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: "DeepSeek's reasoning — R1 distill on Cloudflare, flagship chat when direct.",
    cloudflare: { provider: 'workers-ai', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' },
    direct: {
      ref: { provider: 'deepseek', model: 'deepseek-chat' },
      keyEnv: 'DEEPSEEK_API_KEY',
      providerLabel: 'DeepSeek',
    },
  },
]

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Look up a catalog model by id, or `undefined` for an unknown/empty id. */
export function getSelectableModel(id: string | undefined | null): SelectableModel | undefined {
  return id ? BY_ID.get(id) : undefined
}

/** Predicate: is the API key for a model's direct variant configured? */
export type DirectKeyAvailable = (keyEnv: string) => boolean

/** Project a catalog model onto its effective, display-ready option. */
function toOption(model: SelectableModel, isAvailable: DirectKeyAvailable): ModelOption {
  const useDirect = !!model.direct && isAvailable(model.direct.keyEnv)
  const variant = useDirect ? model.direct!.ref : model.cloudflare
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    flavor: useDirect ? 'direct' : 'cloudflare',
    providerLabel: useDirect ? model.direct!.providerLabel : 'Cloudflare',
    provider: variant.provider,
    model: variant.model,
  }
}

/**
 * The effective catalog for a deployment: each model resolved to the flavour that
 * is actually in use given which direct-provider keys are configured. Served to
 * the frontend so the picker can show whether a model runs direct or on Cloudflare.
 */
export function effectiveCatalog(isAvailable: DirectKeyAvailable): ModelOption[] {
  return MODEL_CATALOG.map((model) => toOption(model, isAvailable))
}

/**
 * Resolve a block's selected model id to the {@link ModelRef} that should run it,
 * honouring the direct/Cloudflare fallback. Returns `undefined` for an unknown or
 * absent id so the caller falls back to its default routing.
 */
export function resolveModelRef(
  id: string | undefined | null,
  isAvailable: DirectKeyAvailable,
): ModelRef | undefined {
  const model = getSelectableModel(id)
  if (!model) return undefined
  const option = toOption(model, isAvailable)
  return { provider: option.provider, model: option.model }
}
