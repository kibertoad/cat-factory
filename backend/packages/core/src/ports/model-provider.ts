import type { LanguageModel } from 'ai'

// Port for resolving a concrete LLM. The domain references models only by a
// provider-agnostic {@link ModelRef}; the worker's infrastructure layer maps that
// to a real Vercel AI SDK model (OpenAI, Anthropic, Cloudflare Workers AI, …).
// This is the seam that keeps provider SDKs and API keys out of the core.

export interface ModelRef {
  /** Provider id, e.g. `openai`, `anthropic`, `workers-ai`, `mock`. */
  provider: string
  /** Model id within the provider, e.g. `gpt-4o-mini`. */
  model: string
}

export interface ModelProvider {
  /** Resolve a model handle the AI SDK can call, or throw if unconfigured. */
  resolve(ref: ModelRef): LanguageModel
}
