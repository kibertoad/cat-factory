import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelResolver, ProviderRegistry } from './registry.js'

// The base, runtime-neutral resolvers. They depend only on `ai` + the `@ai-sdk/*`
// vendor packages (no Cloudflare bindings, no Node built-ins), so they run on both
// the Worker and the Node service. Heavier/optional backends (e.g. AWS Bedrock) ship
// as their own packages and are mixed in as extra registries.

/** Resolver for OpenAI (or any drop-in compatible base URL using the OpenAI SDK). */
export function openAiResolver(opts: { apiKey?: string; baseURL?: string }): ModelResolver {
  const provider = createOpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  })
  return (ref) => provider(ref.model)
}

/** Resolver for Anthropic. */
export function anthropicResolver(opts: { apiKey?: string; baseURL?: string }): ModelResolver {
  const provider = createAnthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  })
  return (ref) => provider(ref.model)
}

/**
 * Resolver for an OpenAI-compatible vendor (DashScope/Qwen, DeepSeek, Moonshot, or a
 * self-hosted gateway). `name` is only used by the SDK for telemetry/labels.
 */
export function openAiCompatibleResolver(opts: {
  name: string
  apiKey: string
  baseURL: string
}): ModelResolver {
  const provider = createOpenAICompatible({
    name: opts.name,
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  })
  return (ref) => provider(ref.model)
}

/**
 * Resolver for Cloudflare-hosted models reached over HTTP (no Workers `AI` binding):
 * either the Workers AI OpenAI-compatible REST endpoint (account id + API token) or an
 * AI Gateway. This is how the Node service uses Cloudflare models; the Worker uses the
 * in-process binding instead. Registered under the `workers-ai` provider id by default so
 * a model pinned `workers-ai` resolves on both deployments (binding vs REST).
 */
export function cloudflareRestResolver(opts: {
  accountId: string
  apiToken: string
  /** AI Gateway slug; when set, routes through the gateway instead of the direct REST API. */
  gateway?: string
  /** Full override of the base URL (wins over accountId/gateway). */
  baseURL?: string
}): ModelResolver {
  const baseURL =
    opts.baseURL ??
    (opts.gateway
      ? `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gateway}/workers-ai/v1`
      : `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/v1`)
  return openAiCompatibleResolver({ name: 'cloudflare', apiKey: opts.apiToken, baseURL })
}

/**
 * Build the base provider registry from a deployment's credentials. Each provider is
 * registered only when its credential is present, so an unconfigured provider resolves
 * to a clear "Unsupported model provider" error rather than a deep SDK failure. Mix
 * extra registries (e.g. Bedrock, the Workers AI binding) in afterwards.
 */
export function baseProviderRegistry(opts: {
  openaiApiKey?: string
  openaiBaseURL?: string
  anthropicApiKey?: string
  /** Per-provider OpenAI-compatible upstreams (base URL + key), keyed by provider id. */
  openAiCompatible?: Record<string, { apiKey?: string; baseURL: string } | undefined>
  cloudflareRest?: { accountId: string; apiToken: string; gateway?: string; baseURL?: string }
}): ProviderRegistry {
  const registry: ProviderRegistry = {
    openai: opts.openaiApiKey
      ? openAiResolver({ apiKey: opts.openaiApiKey, baseURL: opts.openaiBaseURL })
      : undefined,
    anthropic: opts.anthropicApiKey
      ? anthropicResolver({ apiKey: opts.anthropicApiKey })
      : undefined,
  }
  for (const [provider, upstream] of Object.entries(opts.openAiCompatible ?? {})) {
    if (upstream?.apiKey) {
      registry[provider] = openAiCompatibleResolver({
        name: provider,
        apiKey: upstream.apiKey,
        baseURL: upstream.baseURL,
      })
    }
  }
  if (opts.cloudflareRest) registry['workers-ai'] = cloudflareRestResolver(opts.cloudflareRest)
  return registry
}
