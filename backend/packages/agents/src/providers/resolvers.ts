import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import {
  cloudflareRestBaseUrl,
  DEFAULT_OPENROUTER_ROUTING,
  isOperatorHostedGateway,
  OPENROUTER_BASE_URL,
  type OpenRouterRouting,
} from './endpoints.js'
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
 *
 * `fetch` overrides the transport the SDK uses. Cloud vendors leave it unset (the AI-SDK
 * default fetch, which follows 3xx redirects automatically). A LOCAL runner endpoint
 * (Ollama / LM Studio / …) MUST pass the endpoint service's policy-bound
 * `LocalModelEndpointService.fetchRunner`, so the inline path re-runs the SSRF allow-list on
 * every hop under the DEPLOYMENT's loopback/LAN policy: otherwise a permitted local host
 * could `302` the call to the cloud-metadata endpoint and the default fetch would follow it
 * silently (SEC-2). Never the bare `fetchLocalRunner`, which defaults to the strict policy
 * and would therefore refuse a LAN endpoint an operator deliberately allowed. This mirrors
 * the proxy path, which routes local-runner calls through the same transport.
 */
export function openAiCompatibleResolver(opts: {
  name: string
  apiKey: string
  baseURL: string
  fetch?: typeof fetch
  /**
   * Whether this upstream honours `response_format: { type: 'json_schema' }`.
   *
   * Load-bearing, and silent when wrong in the permissive direction: with it unset the
   * `@ai-sdk/openai-compatible` client DOWNGRADES a schema-carrying request to
   * `{ type: 'json_object' }` and DROPS the schema, emitting only an SDK warning nothing here
   * reads (`dist/index.js`, the `response_format` ternary). The caller then gets free-form JSON
   * that happens to parse, against a shape nobody enforced. Defaults to false because it is the
   * SDK's own default and because the upstreams that genuinely may not serve `json_schema` are
   * the ones nobody here can vouch for: a per-user local runner (Ollama, LM Studio) and an
   * operator-hosted gateway fronting one. {@link directOpenAiCompatibleResolver} decides which
   * of its providers may claim it; no caller passes a bare true.
   */
  supportsStructuredOutputs?: boolean
}): ModelResolver {
  const provider = createOpenAICompatible({
    name: opts.name,
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    supportsStructuredOutputs: opts.supportsStructuredOutputs ?? false,
  })
  return (ref) => provider(ref.model)
}

/**
 * Resolver for OpenRouter, which is a GATEWAY rather than one more OpenAI-compatible vendor
 * and is therefore not served by {@link openAiCompatibleResolver}.
 *
 * Three things the generic client structurally cannot do, each of which OpenRouter answers:
 *
 *  - **It reports what the call actually cost.** `usage: { include: true }` turns on usage
 *    accounting, and the reply carries `providerMetadata.openrouter.usage.cost` (real USD, the
 *    gateway's own ledger) plus `provider` (which upstream served it). Everywhere else this
 *    platform DERIVES cost from a price table; against a passthrough gateway reselling 300+
 *    models that derivation is a guess, and this is the one provider that hands over the answer.
 *  - **It routes per request.** {@link OpenRouterRouting} states the two constraints a
 *    deployment puts on that routing: keeping the request off an upstream that would silently
 *    ignore a tool definition, and off one that retains prompts. Both are the deployment's
 *    rather than constants here, because both can narrow the pool to nothing.
 *
 * NOT set here: `structuredOutputs.strict`, which this client already defaults to true ("When
 * `strict` is left unset, the SDK defaults to `true` for backward compatibility", its own option
 * doc). The trap runs the OPPOSITE way round from {@link openAiCompatibleResolver}'s, where the
 * default is false and a schema is silently dropped: here the option exists to opt OUT for a
 * model whose upstream does not advertise strict mode, so writing `strict: true` would pin the
 * default while reading like an opt-in nobody may remove.
 */
export function openRouterResolver(opts: {
  apiKey: string
  /** Defaults to {@link OPENROUTER_BASE_URL}; a deployment override wins. */
  baseURL?: string
  /** The deployment's routing constraints; defaults to {@link DEFAULT_OPENROUTER_ROUTING}. */
  routing?: OpenRouterRouting
  /** Injected transport (tests); defaults to the SDK's own fetch. */
  fetch?: typeof fetch
}): ModelResolver {
  const routing = opts.routing ?? DEFAULT_OPENROUTER_ROUTING
  const provider = createOpenRouter({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? OPENROUTER_BASE_URL,
    // `strict` is what OpenRouter's own API expects and what this gateway is reached at, as
    // opposed to a third-party endpoint merely speaking its dialect.
    compatibility: 'strict',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  return (ref) =>
    provider(ref.model, {
      usage: { include: true },
      provider: {
        require_parameters: routing.requireParameters,
        data_collection: routing.dataCollection,
      },
    })
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
  const baseURL = opts.baseURL ?? cloudflareRestBaseUrl(opts)
  return openAiCompatibleResolver({ name: 'cloudflare', apiKey: opts.apiToken, baseURL })
}

/**
 * Turn ONE key-pooled OpenAI-compatible provider into its resolver, dispatching OpenRouter to
 * {@link openRouterResolver} and everything else to {@link openAiCompatibleResolver}.
 *
 * The single place that dispatch is made. Every entry point that builds a direct provider from a
 * leased key routes through here: the server's `buildDirectResolver`, which is the one this
 * repo's facades run on, and {@link baseProviderRegistry}, the exported deployment-level seam a
 * host assembling its own registry uses. Neither may make the OpenRouter-vs-generic decision
 * itself, because that split is invisible at runtime: the generic client answers correctly, it
 * just answers with no reported cost and no upstream name, which reads downstream as a gateway
 * that reports nothing rather than as a mis-wired resolver.
 *
 * `supportsStructuredOutputs` is claimed for the CLOUD VENDORS only, and withheld from the
 * operator-hosted gateways for the same reason a per-user local runner is left on the SDK's own
 * default: what `bifrost` and `litellm` serve is whatever the operator's `config.yaml` points
 * them at, routinely an Ollama or vLLM model that answers a `json_schema` request with a 400.
 * Claiming it there would turn today's silent downgrade to `json_object` into a hard failure on
 * the first `generateObject` call, and the flag is per PROVIDER, so no caller could exempt them.
 * The set is DERIVED from the endpoint table's own `null` entries ({@link isOperatorHostedGateway})
 * rather than re-listed, so a gateway added there cannot be forgotten here.
 */
export function directOpenAiCompatibleResolver(
  provider: string,
  apiKey: string,
  opts: { baseURL: string; openRouterRouting?: OpenRouterRouting },
): ModelResolver {
  if (provider === 'openrouter') {
    return openRouterResolver({
      apiKey,
      baseURL: opts.baseURL,
      ...(opts.openRouterRouting ? { routing: opts.openRouterRouting } : {}),
    })
  }
  return openAiCompatibleResolver({
    name: provider,
    apiKey,
    baseURL: opts.baseURL,
    supportsStructuredOutputs: !isOperatorHostedGateway(provider),
  })
}

/**
 * Build the base provider registry from a deployment's credentials. Each provider is
 * registered only when its credential is present, so an unconfigured provider resolves
 * to a clear "Unsupported model provider" error rather than a deep SDK failure. Mix
 * extra registries (e.g. Bedrock, the Workers AI binding) in afterwards.
 *
 * The EXPORTED seam, with no caller inside this repo: both facades build their per-scope
 * providers through the server's `buildDirectResolver` instead. It stays because a host
 * assembling a registry from raw credentials is the shape this package publishes, and it takes
 * the same routing option that path does, so the two cannot answer differently.
 */
export function baseProviderRegistry(opts: {
  openaiApiKey?: string
  openaiBaseURL?: string
  anthropicApiKey?: string
  /** Per-provider OpenAI-compatible upstreams (base URL + key), keyed by provider id. */
  openAiCompatible?: Record<string, { apiKey?: string; baseURL: string } | undefined>
  cloudflareRest?: { accountId: string; apiToken: string; gateway?: string; baseURL?: string }
  /** The deployment's OpenRouter routing constraints; see {@link OpenRouterRouting}. */
  openRouterRouting?: OpenRouterRouting
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
    if (!upstream?.apiKey) continue
    registry[provider] = directOpenAiCompatibleResolver(provider, upstream.apiKey, {
      baseURL: upstream.baseURL,
      ...(opts.openRouterRouting ? { openRouterRouting: opts.openRouterRouting } : {}),
    })
  }
  if (opts.cloudflareRest) registry['workers-ai'] = cloudflareRestResolver(opts.cloudflareRest)
  return registry
}
