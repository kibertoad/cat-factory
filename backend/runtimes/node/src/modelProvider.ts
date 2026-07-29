import {
  type ProviderRegistry,
  type WorkspaceBodiesGate,
  resolveOpenAiCompatibleBaseUrl,
} from '@cat-factory/agents'
import type { ApiKeyService, LocalModelEndpointService } from '@cat-factory/integrations'
import {
  type InlineLlmCallRecorder,
  type LlmTraceSink,
  type ModelProviderResolver,
  type WorkspaceSettingsRepository,
  composeTraceSinks,
  createStoreAgentContextGate,
} from '@cat-factory/kernel'
import { bedrockRegistry } from '@cat-factory/provider-bedrock'
import { cloudflareRestRegistry } from '@cat-factory/provider-cloudflare'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import { parseOtlpHeaders } from '@cat-factory/observability-otel'
import { createNodeOtelSink } from '@cat-factory/observability-otel/node'
import { createScopedModelProviderResolver } from '@cat-factory/server'

// The Node deployment's ModelProvider RESOLVER: builds a per-scope provider from the
// DB-backed API-key pool (account/workspace/user), plus opt-in registries that need no
// per-scope key — AWS Bedrock (when AWS creds/region are set) and Cloudflare Workers AI
// over REST (when CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set). There is no
// Workers AI binding on Node, so `workers-ai` is served via the Cloudflare REST flavour.
// Inline calls are wrapped for Langfuse exactly like the proxied path when configured.

/**
 * The instrumentation the scoped resolver wraps inline calls with. At least one exit must be
 * present: the metric recorder (so inline calls reach `llm_call_metrics` and every in-app
 * observability surface) and/or one shared external trace sink.
 */
export interface InlineInstrument {
  /**
   * The composed external sink. When {@link recordCall} is also set this MUST be the same
   * instance the recorder's `LlmObservabilityService` carries — that service performs the
   * fan-out for a recorded call, so wiring a different sink here would split the trace.
   */
  traceSink?: LlmTraceSink
  /** Persist each workspace-scoped inline call to `llm_call_metrics` (`makeInlineCallRecorder`). */
  recordCall?: InlineLlmCallRecorder
  recordPrompts: boolean
  /**
   * The per-workspace `storeAgentContext` opt-out applied to prompt/response bodies before
   * they leave for the sink — the same gate the proxied path runs. Required, so a wiring
   * site cannot instrument inline calls while honouring only `LLM_RECORD_PROMPTS`. A call
   * the recorder takes is gated by the same rule inside the service instead.
   */
  workspaceBodiesEnabled: WorkspaceBodiesGate
}

/**
 * Build the inline instrumentation from the process env — Langfuse (fetch) and/or the
 * OpenTelemetry SDK sink, composed via a fan-out. This is the FALLBACK path used only when
 * the caller does not supply a pre-built instrument (direct callers / tests). In the real
 * container build the sink is built ONCE (memoised, and its shutdown wired) and passed in,
 * so the SDK exporter's batch processors/timers aren't duplicated across wiring sites.
 *
 * `workspaceBodiesEnabled` is threaded in rather than built here because this function sees
 * only `env` — it has no persistence to read the per-workspace opt-out from.
 */
function buildInstrumentFromEnv(
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
  // The already-composed inline instrument (one trace sink shared with the proxied path +
  // the core, so the SDK exporter isn't built twice). Omitted by direct callers/tests, which
  // fall back to building it from `env`.
  instrument?: InlineInstrument,
  /**
   * The workspace-settings store the per-workspace `storeAgentContext` body gate reads.
   * Only consulted when `instrument` is omitted (the env-fallback path builds its own
   * instrument); a supplied instrument already carries its gate. Absent ⇒ no settings
   * source, so the deployment's `LLM_RECORD_PROMPTS` switch alone governs bodies.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository,
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

  // Opt-in Bedrock: registered only when a region is configured.
  if (env.BEDROCK_REGION) {
    const supportedModels = env.BEDROCK_MODELS?.split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    extraRegistries.push(
      bedrockRegistry({
        region: env.BEDROCK_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        supportedModels: supportedModels?.length ? supportedModels : undefined,
      }),
    )
  }

  // Instrument inline (non-proxied) calls with the SAME external trace sink(s) the proxied
  // path uses — Langfuse (fetch) and/or OpenTelemetry (official SDK). The container build
  // passes a pre-built, shared instrument (so the SDK exporter is created once); a direct
  // caller / test that omits it falls back to building one from `env`.
  const resolvedInstrument =
    instrument ??
    buildInstrumentFromEnv(
      env,
      createStoreAgentContextGate({ repository: workspaceSettingsRepository }),
    )

  return createScopedModelProviderResolver({
    apiKeys,
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    extraRegistries,
    localEndpointsFor: localModelEndpoints
      ? (userId) => localModelEndpoints.listResolved(userId)
      : undefined,
    instrument: resolvedInstrument,
  })
}
