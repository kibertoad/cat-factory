import {
  CompositeModelProvider,
  InstrumentedModelProvider,
  type ModelResolver,
  type ProviderRegistry,
  type VendorConcurrencyLimiter,
  type WorkspaceBodiesGate,
  anthropicResolver,
  limitModelProvider,
  openAiCompatibleResolver,
  openAiResolver,
} from '@cat-factory/agents'
import { type ApiKeyService, fetchLocalRunner } from '@cat-factory/integrations'
import type {
  InlineLlmCallRecorder,
  LlmTraceSink,
  ModelProvider,
  ModelProviderResolver,
  ModelScope,
} from '@cat-factory/kernel'
import { logger } from '../observability/logger.js'
import { openAiCompatibleBaseUrlError } from './providerErrors.js'

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
}

/**
 * How inline calls are observed: persisted to `llm_call_metrics` via {@link recordCall}, and/or
 * emitted to the external trace sink (Langfuse / OTel). At least one exit must be present —
 * `InstrumentedModelProvider` refuses a wrap that would instrument nothing. Build it with
 * `createInlineInstrumentation`, which composes both exits from one sink instance.
 */
export interface InlineInstrumentation {
  /**
   * The external trace sink. Optional now that a facade may retain metrics without one;
   * when {@link recordCall} is also wired this MUST be the very sink that recorder's
   * `LlmObservabilityService` was built with, because the service — not this provider —
   * performs the fan-out for a recorded call.
   */
  traceSink?: LlmTraceSink
  /**
   * Persist each workspace-scoped inline call to the metric store, built with
   * `makeInlineCallRecorder`. Without it the inline half of the platform's model activity
   * never reaches `ObservabilityPanel`, the per-step token rollups or `/api/v1/debug/*`.
   */
  recordCall?: InlineLlmCallRecorder
  recordPrompts?: boolean
  /**
   * The per-workspace `storeAgentContext` opt-out applied to prompt/response bodies
   * before they leave for the sink — build it with `createStoreAgentContextGate`.
   * Required so a facade cannot instrument inline calls while silently honouring only
   * the deployment switch, which is how an opted-out workspace's bodies reached
   * Langfuse/OTel for months (observability-logging-gaps.md, C2). A call taken by
   * {@link recordCall} is gated by the same rule inside the service instead.
   */
  workspaceBodiesEnabled: WorkspaceBodiesGate
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
      // Route their transport through `fetchLocalRunner` so the inline path re-validates the
      // SSRF allow-list on EVERY redirect hop — the same guard the proxy path applies. Without
      // it the AI-SDK default fetch would silently follow a local runner's 302 to the
      // cloud-metadata endpoint (SEC-2).
      if (scope.userId && opts.localEndpointsFor) {
        for (const ep of await opts.localEndpointsFor(scope.userId)) {
          registry[ep.provider] = openAiCompatibleResolver({
            name: ep.provider,
            apiKey: ep.apiKey || 'local',
            baseURL: ep.baseUrl,
            fetch: (url, init) => fetchLocalRunner(String(url), init ?? {}),
          })
        }
      }
      return new CompositeModelProvider(registry, ...(opts.extraRegistries ?? []))
    },
  }
}

/**
 * Wrap a {@link ModelProviderResolver} so every model it resolves feeds the inline telemetry
 * exits — `llm_call_metrics` and/or the external trace sink.
 *
 * **Apply this AFTER every wrap that can SUBSTITUTE the resolved model, and only the
 * concurrency limiter outside it.** The instrumentation is an AI-SDK middleware around the
 * model instance, so it observes exactly the model handed back by the wrap beneath it and
 * nothing else. It used to live inside {@link createScopedModelProviderResolver} — i.e.
 * innermost — which made it invisible to the local facade's subscription-inline wrap: that
 * wrap answers a subscription harness ref with its own `CliInlineLanguageModel` instead of
 * delegating to the provider below, so on the default local deployment
 * (`LOCAL_NATIVE_INLINE`) every inline step running on Claude Code / Codex recorded ZERO
 * calls while the same step on a metered API model recorded fine. The ordering IS the fix;
 * a facade that composes these the other way round re-opens it silently, because the wrap
 * still type-checks and every non-substituted call still records.
 *
 * The scope's `executionId` is threaded in as the attribution FALLBACK for a call whose
 * `catFactoryObservability` tag names no run — see `InstrumentedModelProvider`.
 *
 * Returns the resolver unchanged when nothing is wired, so a deployment that retains no
 * metrics and configures no sink pays no middleware.
 */
export function wrapResolverWithInstrumentation(
  resolver: ModelProviderResolver,
  instrument: InlineInstrumentation | undefined,
): ModelProviderResolver {
  if (!instrument) return resolver
  return {
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      return new InstrumentedModelProvider({
        inner: await resolver.forScope(scope),
        ...(instrument.traceSink ? { traceSink: instrument.traceSink } : {}),
        ...(instrument.recordCall ? { recordCall: instrument.recordCall } : {}),
        recordPrompts: instrument.recordPrompts,
        workspaceBodiesEnabled: instrument.workspaceBodiesEnabled,
        ...(scope.executionId ? { scopeExecutionId: scope.executionId } : {}),
        logger,
      })
    },
  }
}

/**
 * Wrap a {@link ModelProviderResolver} so every resolved provider caps concurrent inline calls
 * to a subscription vendor behind the shared {@link VendorConcurrencyLimiter}. Apply this as the
 * OUTERMOST wrap in a facade — after {@link wrapResolverWithInstrumentation} AND after any
 * facade-specific wrap (local's subscription-inline harness) — so the limiter sees the
 * un-degraded subscription ref and its queue wait is excluded from generation timing. A
 * pass-through limiter (nothing capped) returns the resolver unchanged. There are two call sites
 * — the Worker's `buildModelProviderResolver` and Node's `buildNodeContainer` (local inherits
 * Node's via `buildLocalContainer`); keep them in step (see "Keep the runtimes symmetric").
 */
export function wrapResolverWithLimiter(
  resolver: ModelProviderResolver,
  limiter: VendorConcurrencyLimiter,
): ModelProviderResolver {
  if (limiter.isEmpty) return resolver
  return {
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      return limitModelProvider(await resolver.forScope(scope), limiter)
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
  // qwen / deepseek / moonshot / openrouter / litellm expose an OpenAI-compatible API and need a
  // base URL. litellm has no public default, so this is the common "key pooled, LITELLM_BASE_URL
  // unset" case — openAiCompatibleBaseUrlError names it specifically.
  if (!baseURL) {
    throw new Error(openAiCompatibleBaseUrlError(provider))
  }
  return openAiCompatibleResolver({ name: provider, apiKey, baseURL })
}
