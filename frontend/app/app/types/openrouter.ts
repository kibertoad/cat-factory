// ---------------------------------------------------------------------------
// Per-workspace OpenRouter dynamic catalog. OpenRouter is a single OpenAI-
// compatible gateway to 300+ models reached via the workspace's API-key pool. A
// workspace browses the live catalog and enables a subset; the enabled models
// surface automatically in the per-workspace model picker (with their context +
// price) and feed the spend budget.
//
// Mirrors the `@cat-factory/contracts` `openrouter` schemas exactly, so a payload
// returned by the backend drops straight into the Pinia store without translation.
// ---------------------------------------------------------------------------

/** Metadata for one OpenRouter model (prices per 1M tokens, in the spend currency). */
export interface OpenRouterModelMeta {
  /** OpenRouter `vendor/model` slug, e.g. `anthropic/claude-opus-4.8`. */
  id: string
  /** Human-readable model name from OpenRouter's catalog. */
  name: string
  /** Total context window (input + output tokens), when reported. */
  contextLength?: number
  /** Input price per 1M tokens, in the spend currency. */
  inputPerMillion: number
  /** Output price per 1M tokens, in the spend currency. */
  outputPerMillion: number
}

/** A workspace's enabled OpenRouter models (the persisted subset). */
export interface OpenRouterCatalog {
  models: OpenRouterModelMeta[]
  createdAt: number
  updatedAt: number
}

/** Replace a workspace's enabled OpenRouter models with this subset (+ metadata). */
export interface UpsertOpenRouterCatalogInput {
  models: OpenRouterModelMeta[]
}

/** The result of probing OpenRouter's live `/models` for the browse list. */
export interface OpenRouterRefreshResult {
  reachable: boolean
  /** Every model OpenRouter currently serves (empty when unreachable). */
  models: OpenRouterModelMeta[]
  /** Human-readable failure reason when `reachable` is false. */
  error?: string
}
