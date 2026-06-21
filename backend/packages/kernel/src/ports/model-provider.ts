import type { LanguageModel } from 'ai'

// Port for resolving a concrete LLM. The domain references models only by a
// provider-agnostic {@link ModelRef}; the worker's infrastructure layer maps that
// to a real Vercel AI SDK model (OpenAI, Anthropic, Cloudflare Workers AI, …).
// This is the seam that keeps provider SDKs and API keys out of the core.

/** Which container harness runs an agent for a model. */
export type HarnessKind = 'pi' | 'claude-code' | 'codex'

export interface ModelRef {
  /** Provider id, e.g. `openai`, `anthropic`, `workers-ai`, `mock`. */
  provider: string
  /** Model id within the provider, e.g. `gpt-4o-mini`. */
  model: string
  /**
   * The container harness that runs this model. Absent ⇒ the default Pi harness
   * (reached through the LLM proxy). `claude-code` / `codex` are subscription
   * harnesses authenticated with a stored OAuth token, talking direct to the
   * vendor — the executor leases a pool token instead of minting a proxy session.
   */
  harness?: HarnessKind
  /**
   * The model's context window at this provider, for the picker. Cloudflare-hosted
   * variants typically run a cut context vs the vendor-direct/subscription full
   * window; surfacing it lets the picker differentiate them. Absent ⇒ unknown.
   */
  contextTokens?: number
}

export interface ModelProvider {
  /** Resolve a model handle the AI SDK can call, or throw if unconfigured. */
  resolve(ref: ModelRef): LanguageModel
}
