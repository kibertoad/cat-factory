import type { ModelRef } from '../ports/model-provider'

// The curated catalog of LLM models a user can pick for a single block. Selection
// persists as a stable `id` on the block (see `Block.modelId`); at run time the
// executor resolves that id to a concrete {@link ModelRef} and uses it instead of
// the agent routing's default. A block without a selection falls back to the
// operator-configured routing, so this is purely an opt-in per-block override.
//
// The current set are all Cloudflare Workers AI text models (latest generation as
// of mid-2026): the platform-default Llama, plus Qwen, Kimi and DeepSeek. Because
// they share the `workers-ai` provider they resolve through the existing
// CloudflareModelProvider with no extra wiring.

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
    label: 'Qwen3 30B',
    description: "Alibaba's Qwen3 30B-A3B mixture-of-experts model (3B active params).",
    provider: 'workers-ai',
    model: '@cf/qwen/qwen3-30b-a3b-fp8',
  },
  {
    id: 'kimi',
    label: 'Kimi K2.6',
    description: "Moonshot AI's frontier-scale agentic model with a long context window.",
    provider: 'workers-ai',
    model: '@cf/moonshotai/kimi-k2.6',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek R1',
    description: "DeepSeek's R1 reasoning, distilled into Qwen 32B.",
    provider: 'workers-ai',
    model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
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
