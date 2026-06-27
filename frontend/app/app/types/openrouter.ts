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
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  OpenRouterModelMeta,
  OpenRouterCatalog,
  UpsertOpenRouterCatalogInput,
  OpenRouterRefreshResult,
} from '@cat-factory/contracts'
