import {
  CompositeModelProvider,
  InstrumentedModelProvider,
  type ModelResolver,
  type ProviderRegistry,
  anthropicResolver,
  openAiCompatibleResolver,
  openAiResolver,
} from '@cat-factory/agents'
import type { ApiKeyService } from '@cat-factory/integrations'
import type {
  LlmTraceSink,
  ModelProvider,
  ModelProviderResolver,
  ModelScope,
} from '@cat-factory/kernel'

// Builds a {@link ModelProviderResolver} that resolves INLINE LLM calls against the
// DB-backed, per-scope API-key pool instead of env-baked keys. For a given run scope
// (workspace + owning account + initiator) it leases the configured direct-provider
// keys up front and assembles a CompositeModelProvider over them, mixing in the
// deployment's opt-in registries (the Cloudflare lib, Bedrock) that need no DB key.
//
// `ModelProvider.resolve` stays synchronous: the (small) set of configured providers
// is leased once when the scoped provider is built, so a single inline call does no
// extra I/O. The shared opt-in registries are static (e.g. the Worker `AI` binding),
// so they are passed through unchanged on every scope.

export interface ScopedModelProviderOptions {
  /**
   * The direct-provider API-key pool (account/workspace/user scoped). Absent (no
   * ENCRYPTION_KEY) → no direct providers are configured; only the opt-in registries
   * (Cloudflare/Bedrock) can resolve, and a direct-provider ref fails clearly.
   */
  apiKeys?: ApiKeyService
  /** Base URL for a direct provider's API (the OpenAI-compatible vendors need one). */
  baseUrlFor: (provider: string) => string | undefined
  /** Opt-in registries that need no DB key — the Cloudflare lib + Bedrock. */
  extraRegistries?: ProviderRegistry[]
  /**
   * Resolve a user's locally-run model endpoints (Ollama / LM Studio / …) so inline LLM
   * calls reach them like the proxied path. Keyless by design (the endpoint carries an
   * optional key), so these register into the per-scope registry directly rather than via
   * the DB API-key pool. Keyed by the scope's user (the run initiator).
   */
  localEndpointsFor?: (
    userId: string,
  ) => Promise<{ provider: string; baseUrl: string; apiKey: string | null }[]>
  /** Wrap the scoped provider so inline calls feed the trace sink (Langfuse). */
  instrument?: { traceSink: LlmTraceSink; recordPrompts?: boolean }
}

export function createScopedModelProviderResolver(
  opts: ScopedModelProviderOptions,
): ModelProviderResolver {
  return {
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const poolOpts = { accountId: scope.accountId, userId: scope.userId }
      const registry: ProviderRegistry = {}
      if (opts.apiKeys) {
        const providers = await opts.apiKeys.configuredProviders(scope.workspaceId, poolOpts)
        for (const provider of providers) {
          try {
            const leased = await opts.apiKeys.lease(scope.workspaceId, provider, poolOpts)
            registry[provider] = buildDirectResolver(
              provider,
              leased.secret,
              opts.baseUrlFor(provider),
            )
          } catch (e) {
            // One provider's key failing to lease/decrypt (e.g. sealed under a rotated
            // ENCRYPTION_KEY, or missing a base URL) must NOT sink the whole scoped provider:
            // an inline call targeting a DIFFERENT, healthy provider should still resolve.
            // Defer the failure to resolve time so it only surfaces — with the real cause —
            // if this exact provider is the one actually requested.
            registry[provider] = unusableProviderResolver(e)
          }
        }
      }
      // The initiating user's locally-run runners (keyless OpenAI-compatible endpoints).
      if (scope.userId && opts.localEndpointsFor) {
        for (const ep of await opts.localEndpointsFor(scope.userId)) {
          registry[ep.provider] = openAiCompatibleResolver({
            name: ep.provider,
            apiKey: ep.apiKey || 'local',
            baseURL: ep.baseUrl,
          })
        }
      }
      const composite = new CompositeModelProvider(registry, ...(opts.extraRegistries ?? []))
      if (opts.instrument) {
        return new InstrumentedModelProvider({
          inner: composite,
          traceSink: opts.instrument.traceSink,
          recordPrompts: opts.instrument.recordPrompts,
        })
      }
      return composite
    },
  }
}

/**
 * A resolver that defers a provider's build failure (a key that couldn't be leased/decrypted,
 * or a missing base URL) to resolve time. Registered in place of a real resolver so an unrelated
 * broken provider key doesn't sink the whole scoped provider — only a call that actually targets
 * this provider throws, and with the original cause preserved.
 */
function unusableProviderResolver(error: unknown): ModelResolver {
  return () => {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Build the AI-SDK resolver for one direct provider given a leased key + base URL. */
function buildDirectResolver(
  provider: string,
  apiKey: string,
  baseURL: string | undefined,
): ModelResolver {
  if (provider === 'openai') return openAiResolver({ apiKey, baseURL })
  if (provider === 'anthropic') return anthropicResolver({ apiKey, baseURL })
  // qwen / deepseek / moonshot expose an OpenAI-compatible API and need a base URL.
  if (!baseURL) {
    throw new Error(`No base URL configured for OpenAI-compatible provider '${provider}'`)
  }
  return openAiCompatibleResolver({ name: provider, apiKey, baseURL })
}
