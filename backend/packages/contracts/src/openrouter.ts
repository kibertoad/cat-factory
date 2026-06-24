import * as v from 'valibot'

// ---------------------------------------------------------------------------
// OpenRouter dynamic-catalog wire contracts. OpenRouter is a single OpenAI-
// compatible gateway to 300+ models, configured per WORKSPACE (its key lives in
// the shared API-key pool). Rather than a hardcoded handful of curated models, a
// workspace can BROWSE the live OpenRouter catalog (`/refresh`) and ENABLE a
// subset; the enabled models — with their cached context window + price — are
// surfaced in the per-workspace model picker and feed the spend budget.
//
// This mirrors the per-user local-runner catalog: a "refresh" probes the live
// list (not persisted in full), and an "upsert" persists only the enabled subset
// with the metadata the client read from the browse list.
// ---------------------------------------------------------------------------

const slugSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const nameSchema = v.pipe(v.string(), v.maxLength(200))

/**
 * Metadata for one OpenRouter model, in the spend pricing's terms (per-1M-token
 * prices, already converted to the deployment currency). `id` is the OpenRouter
 * `vendor/model` slug (e.g. `google/gemini-3-pro`).
 */
export const openRouterModelMetaSchema = v.object({
  /** OpenRouter `vendor/model` slug, e.g. `anthropic/claude-opus-4.8`. */
  id: slugSchema,
  /** Human-readable model name from OpenRouter's catalog. */
  name: nameSchema,
  /** Total context window (input + output tokens), when reported. */
  contextLength: v.optional(v.number()),
  /** Input price per 1M tokens, in the spend currency. */
  inputPerMillion: v.number(),
  /** Output price per 1M tokens, in the spend currency. */
  outputPerMillion: v.number(),
})
export type OpenRouterModelMeta = v.InferOutput<typeof openRouterModelMetaSchema>

/**
 * A workspace's enabled OpenRouter models, as returned to the SPA. The persisted
 * `models` array IS the enabled subset (each with its cached metadata).
 */
export const openRouterCatalogSchema = v.object({
  models: v.array(openRouterModelMetaSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type OpenRouterCatalog = v.InferOutput<typeof openRouterCatalogSchema>

/**
 * Replace a workspace's enabled OpenRouter models. The client sends the enabled
 * subset WITH the metadata it read from the live browse list, so the server (and
 * the spend table) get accurate per-model context + pricing without a re-fetch.
 */
export const upsertOpenRouterCatalogSchema = v.object({
  models: v.array(openRouterModelMetaSchema),
})
export type UpsertOpenRouterCatalogInput = v.InferOutput<typeof upsertOpenRouterCatalogSchema>

/** The result of probing OpenRouter's live `/models` for the browse list. */
export const openRouterRefreshResultSchema = v.object({
  reachable: v.boolean(),
  /** Every model OpenRouter currently serves (empty when unreachable). */
  models: v.array(openRouterModelMetaSchema),
  /** Human-readable failure reason when `reachable` is false. */
  error: v.optional(v.string()),
})
export type OpenRouterRefreshResult = v.InferOutput<typeof openRouterRefreshResultSchema>
