import type { ModelRef } from '../ports/model-provider'

// The curated catalog of LLM models a user can pick for a single block. Selection
// persists as a stable `id` on the block (see `Block.modelId`); at run time the
// executor resolves that id to a concrete {@link ModelRef} and uses it instead of
// the agent routing's default. A block without a selection falls back to the
// operator-configured routing, so this is purely an opt-in per-block override.
//
// The current set (latest generation as of mid-2026): Llama and Kimi run on
// Cloudflare Workers AI (the `workers-ai` provider), while Qwen and DeepSeek
// integrate directly with their own provider APIs (`qwen` via Alibaba DashScope,
// `deepseek` via the DeepSeek API). The worker's CloudflareModelProvider maps each
// provider id to a concrete SDK client and the matching credentials.

export interface SelectableModel {
  /** Stable id stored on a block, e.g. `qwen`. */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** One-line description shown alongside the label. */
  description: string
  /** Provider id passed to the {@link ModelProvider}. */
  provider: string
  /** Model id within the provider. */
  model: string
}

export const MODEL_CATALOG: SelectableModel[] = [
  {
    id: 'cloudflare-llama',
    label: 'Llama 3.1 (Cloudflare default)',
    description: "Meta's fast 8B instruct model — Cloudflare Workers AI's default text model.",
    provider: 'workers-ai',
    model: '@cf/meta/llama-3.1-8b-instruct',
  },
  {
    id: 'qwen',
    label: 'Qwen3 Max',
    description: "Alibaba's flagship Qwen3-Max, direct via the DashScope API.",
    provider: 'qwen',
    model: 'qwen3-max',
  },
  {
    id: 'kimi',
    label: 'Kimi K2.6',
    description: "Moonshot AI's frontier-scale agentic model, via Cloudflare Workers AI.",
    provider: 'workers-ai',
    model: '@cf/moonshotai/kimi-k2.6',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek V3.2',
    description: "DeepSeek's flagship chat model, direct via the DeepSeek API.",
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
]

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Look up a catalog model by id, or `undefined` for an unknown/empty id. */
export function getSelectableModel(id: string | undefined | null): SelectableModel | undefined {
  return id ? BY_ID.get(id) : undefined
}

/**
 * Resolve a block's selected model id to a {@link ModelRef}, or `undefined` when
 * nothing is selected or the id is stale (so the caller falls back to its
 * default). Mirrors how unknown prompt-fragment ids are skipped, not fatal.
 */
export function modelRefForId(id: string | undefined | null): ModelRef | undefined {
  const model = getSelectableModel(id)
  return model ? { provider: model.provider, model: model.model } : undefined
}
