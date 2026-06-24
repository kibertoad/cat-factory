import type { OpenRouterModelMeta } from '@cat-factory/contracts'

// Persistence port for a workspace's enabled GATEWAY models (the dynamic-catalog subset).
// A gateway provider (OpenRouter today; LiteLLM and others later) is a single OpenAI-
// compatible endpoint to many models reached via the workspace's API-key pool. Rather than
// a hardcoded list, a workspace browses the gateway's live catalog and enables a subset;
// the persisted `models` array IS that subset, each carrying its cached context window +
// per-1M-token price (in the spend currency) so the picker and budget have them without a
// live fetch. Generic across gateways — keyed by `(workspaceId, provider)` so a new gateway
// reuses this table rather than adding its own. Both runtimes (Cloudflare D1 + Node/local
// Postgres) implement this so behaviour is identical everywhere.
//
// (The metadata shape is shared with OpenRouter's wire contract — `OpenRouterModelMeta` —
// since id/name/context/price is gateway-neutral; it is reused here verbatim.)

/** A workspace's enabled models for ONE gateway provider, at rest. */
export interface ProviderModelCatalogRecord {
  /** Workspace (`ws_*`) the enabled set belongs to. */
  workspaceId: string
  /** Gateway provider id (e.g. `openrouter`, `litellm`) — also the `ModelRef.provider`. */
  provider: string
  /** The enabled models, each with cached metadata (context + price). */
  models: OpenRouterModelMeta[]
  createdAt: number
  updatedAt: number
}

export interface ProviderModelCatalogRepository {
  /** The workspace's enabled catalog for a gateway provider, or null when none. */
  getByWorkspace(workspaceId: string, provider: string): Promise<ProviderModelCatalogRecord | null>
  /** Every gateway provider's enabled catalog for a workspace. */
  listByWorkspace(workspaceId: string): Promise<ProviderModelCatalogRecord[]>
  /** Insert or replace the workspace's enabled catalog for a gateway (one per ws+provider). */
  upsert(record: ProviderModelCatalogRecord): Promise<void>
  /** Remove the workspace's enabled catalog for a gateway provider. */
  remove(workspaceId: string, provider: string): Promise<void>
}
