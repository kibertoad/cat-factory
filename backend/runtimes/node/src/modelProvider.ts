import {
  type ProviderRegistry,
  type WorkspaceBodiesGate,
  resolveOpenAiCompatibleBaseUrl,
} from '@cat-factory/agents'
import type { ApiKeyService, LocalModelEndpointService } from '@cat-factory/integrations'
import { type ModelProviderResolver, composeTraceSinks } from '@cat-factory/kernel'
import { bedrockRegistry } from '@cat-factory/provider-bedrock'
import { cloudflareRestRegistry } from '@cat-factory/provider-cloudflare'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import { parseOtlpHeaders } from '@cat-factory/observability-otel'
import { createNodeOtelSink } from '@cat-factory/observability-otel/node'
import {
  type InlineInstrumentation,
  bedrockAllowListFromEnv,
  bedrockRegionFromEnv,
  createScopedModelProviderResolver,
} from '@cat-factory/server'

// The Node deployment's BASE ModelProvider RESOLVER: builds a per-scope provider from the
// DB-backed API-key pool (account/workspace/user), plus opt-in registries that need no
// per-scope key — AWS Bedrock (when AWS creds/region are set) and Cloudflare Workers AI
// over REST (when CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set). There is no
// Workers AI binding on Node, so `workers-ai` is served via the Cloudflare REST flavour.
//
// Telemetry is NOT applied here. The inline instrumentation is a separate wrap
// (`wrapResolverWithInstrumentation`) the CALLER composes on top, because it must sit
// outside any facade wrap that can substitute the resolved model — local mode's
// subscription-inline harness does exactly that, and while the instrumentation lived
// innermost every inline step running on a host `claude`/`codex` CLI recorded nothing. The
// composition order lives in `container-model-deps.ts`; the rule is documented on the wrap.

/**
 * The instrumentation an inline-call wrap takes: the metric recorder (so inline calls reach
 * `llm_call_metrics` and every in-app observability surface) and/or one shared external trace
 * sink, at least one of the two.
 *
 * An ALIAS of the server layer's composed shape rather than a second declaration of it — the
 * pairing rule between the two exits (the recorder's service owns the trace fan-out, so both
 * must hold the same sink instance) is enforced by `createInlineInstrumentation` building
 * them together, and a facade-local restatement of the fields would be a place to drift from
 * it. Kept as a named export because it is what this module's public signature takes.
 */
export type InlineInstrument = InlineInstrumentation

/**
 * Build the inline instrumentation from the process env — Langfuse (fetch) and/or the
 * OpenTelemetry SDK sink, composed via a fan-out. This is the trace-sink-only shape, for a
 * caller assembling its own container (and for the wiring tests). The real container build
 * composes `createInlineInstrumentation` instead: it adds the `llm_call_metrics` recorder and
 * builds the sink ONCE (memoised, shutdown wired) so the SDK exporter's batch
 * processors/timers aren't duplicated across wiring sites.
 *
 * `workspaceBodiesEnabled` is threaded in rather than built here because this function sees
 * only `env` — it has no persistence to read the per-workspace opt-out from.
 */
export function inlineInstrumentFromEnv(
  env: NodeJS.ProcessEnv,
  workspaceBodiesEnabled: WorkspaceBodiesGate,
): InlineInstrument | undefined {
  const langfuseSink =
    env.LANGFUSE_ENABLED?.trim() === 'true' &&
    env.LANGFUSE_PUBLIC_KEY?.trim() &&
    env.LANGFUSE_SECRET_KEY?.trim()
      ? createLangfuseSink({
          publicKey: env.LANGFUSE_PUBLIC_KEY.trim(),
          secretKey: env.LANGFUSE_SECRET_KEY.trim(),
          baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
        })
      : undefined
  const otelSink =
    env.OTEL_ENABLED?.trim() === 'true' && env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
      ? createNodeOtelSink({
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT.trim(),
          headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
          serviceName: env.OTEL_SERVICE_NAME?.trim() || undefined,
        })
      : undefined
  const traceSink = composeTraceSinks([langfuseSink, otelSink])
  return traceSink
    ? {
        traceSink,
        recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false',
        workspaceBodiesEnabled,
      }
    : undefined
}

/**
 * The base URL for a direct provider: the `${PROVIDER}_BASE_URL` env override (e.g.
 * QWEN_BASE_URL), else the built-in default. The override-vs-default precedence and the
 * defaults table itself live in @cat-factory/agents so the Worker resolves identically;
 * `litellm` has no default and so resolves only once LITELLM_BASE_URL is set.
 */
export function baseUrlForNode(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  return resolveOpenAiCompatibleBaseUrl(provider, env[`${provider.toUpperCase()}_BASE_URL`])
}

export function createNodeModelProviderResolver(
  env: NodeJS.ProcessEnv,
  apiKeys: ApiKeyService | undefined,
  localModelEndpoints?: LocalModelEndpointService,
): ModelProviderResolver {
  const extraRegistries: ProviderRegistry[] = []

  // Opt-in Cloudflare Workers AI over REST.
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    extraRegistries.push(
      cloudflareRestRegistry({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        gateway: env.CLOUDFLARE_AI_GATEWAY,
      }),
    )
  }

  // Opt-in Bedrock: registered only when a region is configured, through the SAME two readers
  // the model catalog's `bedrock` capability uses, so a model the picker offers is never one
  // this resolver throws on (and a whitespace-only region registers nothing rather than a
  // resolver the capability side treats as absent).
  const bedrockRegion = bedrockRegionFromEnv(env)
  if (bedrockRegion) {
    const supportedModels = bedrockAllowListFromEnv(env)
    extraRegistries.push(
      bedrockRegistry({
        region: bedrockRegion,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        ...(supportedModels ? { supportedModels: [...supportedModels] } : {}),
      }),
    )
  }

  return createScopedModelProviderResolver({
    apiKeys,
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    extraRegistries,
    // The service itself, so the endpoint read and the transport carrying the deployment's
    // loopback/LAN policy (re-validated on every redirect hop, SEC-2/SEC-3) cannot come from
    // two different places.
    localRunners: localModelEndpoints,
  })
}
