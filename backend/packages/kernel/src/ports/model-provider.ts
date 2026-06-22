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

/**
 * Degrade a model ref that demands a container-only subscription harness
 * (`claude-code` / `codex`) to an inline-servable `fallback`. Such a ref names a
 * vendor with NO provider key (the credential is a pooled subscription token used
 * only inside the per-run container), so resolving it through a {@link ModelProvider}
 * for an INLINE LLM call would fail. A block's model is shared by every step of its
 * pipeline (container AND inline), so this is the single seam every inline path (the
 * inline agent executor, the requirements reviewer/rework) routes a pinned
 * subscription model through: the container steps keep the harness, the inline steps
 * fall back to a provider model. A `pi` (or absent) harness is already inline-servable
 * and passes through unchanged.
 */
export function inlineModelRef(ref: ModelRef, fallback: ModelRef): ModelRef {
  return ref.harness && ref.harness !== 'pi' ? fallback : ref
}

export interface ModelProvider {
  /** Resolve a model handle the AI SDK can call, or throw if unconfigured. */
  resolve(ref: ModelRef): LanguageModel
}

/**
 * The credential scope a run draws model-provider keys from: the workspace, its
 * owning account, and the run initiator's own user keys are merged into one pool.
 */
export interface ModelScope {
  workspaceId: string
  /** The workspace's owning account id (resolved automatically when omitted). */
  accountId?: string | null
  /** The run initiator's `usr_*` id, to also draw from their personal keys. */
  userId?: string | null
}

/**
 * Resolves a {@link ModelProvider} bound to a run's credential scope. Direct-provider
 * API keys live in the DB (account/workspace/user scoped), so the provider can no
 * longer be a single process-wide instance built from env: each inline LLM call asks
 * for the provider for its scope, which leases the configured keys for that
 * workspace+account+user. `resolve` itself stays synchronous (keys are leased up
 * front when the scoped provider is built).
 */
export interface ModelProviderResolver {
  forScope(scope: ModelScope): Promise<ModelProvider>
}
