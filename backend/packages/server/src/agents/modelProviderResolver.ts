import {
  CompositeModelProvider,
  InstrumentedModelProvider,
  type ModelResolver,
  type OpenRouterRouting,
  type ProviderRegistry,
  type VendorConcurrencyLimiter,
  type WorkspaceBodiesGate,
  anthropicResolver,
  directOpenAiCompatibleResolver,
  limitModelProvider,
  openAiCompatibleResolver,
  openAiResolver,
} from '@cat-factory/agents'
import type { ApiKeyService, LocalModelEndpointService } from '@cat-factory/integrations'
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
   * How this deployment constrains OpenRouter's provider routing (`OPENROUTER_DATA_COLLECTION`,
   * `OPENROUTER_REQUIRE_PARAMETERS`). Absent ⇒ `DEFAULT_OPENROUTER_ROUTING`, strict on both
   * axes; see `openRouterResolver`.
   */
  openRouterRouting?: OpenRouterRouting
  /**
   * The initiating user's locally-run model endpoints (Ollama / LM Studio / …) so inline
   * LLM calls reach them like the proxied path. Keyless by design (the endpoint carries an
   * optional key), so these register into the per-scope registry directly rather than via
   * the DB API-key pool.
   *
   * Typed as the SERVICE's own methods, not as a pair of callbacks: the read and the
   * transport must come from ONE instance, because that instance is what binds the
   * deployment's loopback/LAN policy (SSRF re-validation on every redirect hop). A
   * structural `{ endpointsFor, fetch }` pair still typechecked when a facade passed the
   * global `fetch`, which is the wrong-policy wiring this option exists to prevent.
   */
  localRunners?: Pick<LocalModelEndpointService, 'listResolved' | 'fetchRunner'>
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
            registry[provider] = buildDirectResolver(provider, leased.secret, {
              baseURL: opts.baseUrlFor(provider),
              ...(opts.openRouterRouting ? { openRouterRouting: opts.openRouterRouting } : {}),
            })
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
      // Route their transport through the facade's policy-bound runner fetch so the inline
      // path re-validates the SSRF allow-list on EVERY redirect hop, the same guard the
      // proxy path applies. Without it the AI-SDK default fetch would silently follow a
      // local runner's 302 to the cloud-metadata endpoint (SEC-2/SEC-3).
      const runners = opts.localRunners
      if (scope.userId && runners) {
        for (const ep of await runners.listResolved(scope.userId)) {
          registry[ep.provider] = openAiCompatibleResolver({
            name: ep.provider,
            apiKey: ep.apiKey || 'local',
            baseURL: ep.baseUrl,
            fetch: (url, init) => runners.fetchRunner(String(url), init ?? {}),
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
 * Module-private on purpose: the ORDER it must be applied in is the whole point, so
 * {@link wrapResolverWithTelemetry} is the only way to reach it. See that function for why.
 *
 * The scope's `executionId` is threaded in as the attribution FALLBACK for a call whose
 * `catFactoryObservability` tag names no run — see `InstrumentedModelProvider`.
 *
 * Returns the resolver unchanged when nothing is wired, so a deployment that retains no
 * metrics and configures no sink pays no middleware.
 */
function wrapResolverWithInstrumentation(
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
 * to a subscription vendor behind the shared {@link VendorConcurrencyLimiter}. A pass-through
 * limiter (nothing capped) returns the resolver unchanged.
 *
 * Module-private for the same reason as the instrumentation wrap: it has to be OUTSIDE it, and
 * {@link wrapResolverWithTelemetry} is what guarantees that.
 */
function wrapResolverWithLimiter(
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

export interface ResolverTelemetryWraps {
  /**
   * How inline calls are observed. Absent (no metric store AND no trace sink) ⇒ no middleware
   * is added at all, so a deployment that retains nothing pays nothing.
   */
  instrument?: InlineInstrumentation
  /** The per-vendor inline concurrency cap, built ONCE per facade with `vendorConcurrencyLimiterFromEnv`. */
  limiter: VendorConcurrencyLimiter
}

/**
 * Apply a facade's inline-telemetry wraps to its model-provider resolver, in the ONE order that
 * is correct: `resolver` → instrumentation → concurrency limiter (outermost).
 *
 * **This exists because the order is load-bearing and nothing in the type system holds it.** Both
 * wraps are AI-SDK middlewares around a RESOLVED model, so each observes exactly what the wrap
 * beneath it returned — and one facade wrap SUBSTITUTES that model rather than delegating: local
 * mode's subscription-inline harness answers a subscription harness ref with its own
 * `CliInlineLanguageModel`. The instrumentation shipped INSIDE
 * {@link createScopedModelProviderResolver} — i.e. innermost, beneath that wrap — so on the
 * default local deployment (`LOCAL_NATIVE_INLINE`) every inline step running on a host
 * `claude`/`codex` login recorded ZERO calls while the same step on a metered API model recorded
 * fine. Reversed, the composition still type-checks and every non-substituted call still records,
 * so nothing fails until it is the deployment nobody tested on. Same argument as
 * `createInlineInstrumentation`, which owns the recorder/sink pair for the same reason: a rule
 * two facades restate in comments is a rule one of them will eventually restate wrongly.
 *
 * The limiter is outermost so a queue wait is never counted as generation time, and so it sees
 * the UN-degraded subscription ref (the facade wrap beneath it may degrade one).
 *
 * Facades pass their own wraps in FIRST (so a substituting wrap is beneath the instrumentation)
 * and hand the result here: the Worker's `buildModelProviderResolver` and Node's
 * `buildNodeModelDeps`, which local inherits via `buildLocalContainer`. Keep them in step (see
 * "Keep the runtimes symmetric").
 */
export function wrapResolverWithTelemetry(
  resolver: ModelProviderResolver,
  wraps: ResolverTelemetryWraps,
): ModelProviderResolver {
  return wrapResolverWithLimiter(
    wrapResolverWithInstrumentation(resolver, wraps.instrument),
    wraps.limiter,
  )
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

/**
 * Build the AI-SDK resolver for one direct provider given a leased key + base URL.
 *
 * The OpenAI-compatible half DELEGATES to `directOpenAiCompatibleResolver` rather than calling
 * `openAiCompatibleResolver` itself, so this path and the deployment-level `baseProviderRegistry`
 * make the same OpenRouter-vs-generic decision. Two call sites choosing separately is how one
 * of them would keep the generic client, and the symptom of that is not an error: OpenRouter
 * answers fine, it just stops reporting its own cost and upstream on whichever path missed out.
 */
function buildDirectResolver(
  provider: string,
  apiKey: string,
  opts: { baseURL: string | undefined; openRouterRouting?: OpenRouterRouting },
): ModelResolver {
  const { baseURL } = opts
  if (provider === 'openai') return openAiResolver({ apiKey, baseURL })
  if (provider === 'anthropic') return anthropicResolver({ apiKey, baseURL })
  // qwen / deepseek / moonshot / xai / openrouter / bifrost / litellm expose an OpenAI-compatible
  // API and need a base URL. The operator-hosted gateways have no public default, so this is the
  // common "key pooled, `${PROVIDER}_BASE_URL` unset" case, and openAiCompatibleBaseUrlError names
  // each of them specifically.
  if (!baseURL) {
    throw new Error(openAiCompatibleBaseUrlError(provider))
  }
  return directOpenAiCompatibleResolver(provider, apiKey, {
    baseURL,
    ...(opts.openRouterRouting ? { openRouterRouting: opts.openRouterRouting } : {}),
  })
}
