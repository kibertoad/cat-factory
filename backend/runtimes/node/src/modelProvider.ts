import { type ProviderRegistry, resolveOpenAiCompatibleBaseUrl } from '@cat-factory/agents'
import type { ApiKeyService, LocalModelEndpointService } from '@cat-factory/integrations'
import { type ModelProviderResolver, composeTraceSinks } from '@cat-factory/kernel'
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
  // path uses — Langfuse (fetch) and/or OpenTelemetry (official SDK), composed via a
  // fan-out when both are enabled.
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
  const instrument = traceSink
    ? { traceSink, recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false' }
    : undefined

  return createScopedModelProviderResolver({
    apiKeys,
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    extraRegistries,
    localEndpointsFor: localModelEndpoints
      ? (userId) => localModelEndpoints.listResolved(userId)
      : undefined,
    instrument,
  })
}
