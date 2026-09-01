import { isLocalRunner } from '@cat-factory/contracts'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours.
// DashScope (Alibaba/Qwen), DeepSeek and Moonshot (Kimi) all expose the OpenAI
// `/chat/completions` shape, so both the Vercel-AI model provider and the container
// LLM proxy resolve them from the same base URLs and keys: one source of truth for
// "where does provider X live". Each is overridable per deployment (a self-hosted
// gateway, a regional endpoint, or a local stub in tests).
/**
 * Alibaba's LEGACY SHARED domain, labelled as such by Alibaba: "Legacy shared domain. Still
 * available; migration to a workspace-dedicated domain is recommended." No deprecation date.
 *
 * It stays the default because the replacement,
 * `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`, is a fact about the
 * DEPLOYMENT's workspace and region that no default can know. A deployment that has one sets
 * `QWEN_BASE_URL`, which is the same override every entry in the table below takes.
 */
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
/**
 * The bare host, which is what DeepSeek documents: its quick-start gives
 * `base_url = https://api.deepseek.com` and its curl example posts to
 * `https://api.deepseek.com/chat/completions`. The `/v1` this used to carry appears on no current
 * DeepSeek page: it was tolerated rather than published, and the newer Anthropic-compatible path
 * hangs off the bare host too.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const XAI_BASE_URL = 'https://api.x.ai/v1'
// OpenRouter is a single OpenAI-compatible gateway to 300+ models, hosted by OpenRouter
// itself, so it has a public endpoint to default to.
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Whether OpenRouter may route a request to an upstream that retains prompts. */
export type OpenRouterDataCollection = 'allow' | 'deny'

/**
 * Read `OPENROUTER_DATA_COLLECTION` into the routing policy OpenRouter is given.
 *
 * OpenRouter's own default is `allow`, and this platform's is not, which is why the value is
 * parsed rather than passed through: an agent prompt carries the customer's checkout, so
 * routing it to a prompt-retaining upstream is a decision an operator makes on the record.
 *
 * Only the exact string `allow` opts in. A typo, a `true`, a `yes` and an empty override all
 * stay denied, because the direction a misread must fail in is the private one. Shared by both
 * facades so a deployment cannot be permissive on one and strict on the other.
 */
export function openRouterDataCollectionFrom(
  value: string | null | undefined,
): OpenRouterDataCollection {
  return value?.trim().toLowerCase() === 'allow' ? 'allow' : 'deny'
}

/**
 * Every provider reached over the shared OpenAI-compatible `/chat/completions` path, mapped
 * to the endpoint it defaults to. `null` marks an **operator-hosted** gateway (Bifrost,
 * LiteLLM): the software is self-hosted and there is no public instance to default to, so
 * such a provider resolves only once the deployment sets its `${PROVIDER}_BASE_URL`.
 *
 * This table is the ONE place the set is stated. Every other answer about an OpenAI-compatible
 * provider is derived from it: the built-in base URLs, the UI-configurable key-pool vendors,
 * whether the container LLM proxy can serve the provider, and each facade's env plumbing
 * ({@link OpenAiCompatibleProvider} makes the Worker's override map total, and the Node proxy
 * upstream resolves through {@link resolveOpenAiCompatibleBaseUrl} rather than a second table).
 * A `null` entry is therefore load-bearing rather than filler: it is what puts an
 * endpoint-less gateway in the proxyable set and the key pool while keeping it unresolvable
 * until an operator names its URL.
 */
const OPENAI_COMPATIBLE_ENDPOINTS = {
  qwen: QWEN_BASE_URL,
  deepseek: DEEPSEEK_BASE_URL,
  moonshot: MOONSHOT_BASE_URL,
  openai: OPENAI_BASE_URL,
  openrouter: OPENROUTER_BASE_URL,
  xai: XAI_BASE_URL,
  // Bifrost (maximhq/bifrost), a self-hosted Go gateway fronting 1000+ models behind one
  // OpenAI-compatible `/v1`. Model ids are canonical `provider/model` pairs (`openai/gpt-4o`).
  bifrost: null,
  // LiteLLM, a self-hosted Python gateway. Model ids are the operator's own `model_name`
  // aliases from its `config.yaml`, so there is no canonical id to assume.
  litellm: null,
} as const satisfies Readonly<Record<string, string | null>>

/** A provider served over the OpenAI-compatible path (see {@link OPENAI_COMPATIBLE_ENDPOINTS}). */
export type OpenAiCompatibleProvider = keyof typeof OPENAI_COMPATIBLE_ENDPOINTS

/** Those provider ids, sorted for a deterministic, stable rendering. */
export const OPENAI_COMPATIBLE_PROVIDERS: readonly OpenAiCompatibleProvider[] = (
  Object.keys(OPENAI_COMPATIBLE_ENDPOINTS) as OpenAiCompatibleProvider[]
).sort()

/**
 * The OPERATOR-HOSTED members: exactly the {@link OPENAI_COMPATIBLE_ENDPOINTS} entries with no
 * public endpoint. DERIVED from that table rather than restated, so a reader (and an exhaustive
 * `Record` over this union, e.g. the base-URL remedy's display labels) cannot fall behind it.
 */
export type OperatorHostedGateway = {
  [K in OpenAiCompatibleProvider]: (typeof OPENAI_COMPATIBLE_ENDPOINTS)[K] extends null ? K : never
}[OpenAiCompatibleProvider]

/** Those gateway ids, sorted. */
export const OPERATOR_HOSTED_GATEWAYS: readonly OperatorHostedGateway[] =
  OPENAI_COMPATIBLE_PROVIDERS.filter(
    (provider): provider is OperatorHostedGateway => OPENAI_COMPATIBLE_ENDPOINTS[provider] === null,
  )

/**
 * Whether `provider` is served over the OpenAI-compatible path. `Object.hasOwn` rather than a
 * truthy lookup, so an operator-hosted gateway (whose entry is `null`) still answers true, and
 * so an inherited `Object.prototype` key never reads as a provider.
 */
export function isOpenAiCompatibleProvider(provider: string): provider is OpenAiCompatibleProvider {
  return Object.hasOwn(OPENAI_COMPATIBLE_ENDPOINTS, provider)
}

const OPERATOR_HOSTED = new Set<string>(OPERATOR_HOSTED_GATEWAYS)

/** Whether `provider` is a self-hosted gateway with no public endpoint to default to. */
export function isOperatorHostedGateway(provider: string): provider is OperatorHostedGateway {
  return OPERATOR_HOSTED.has(provider)
}

/**
 * Built-in base URLs for the OpenAI-compatible providers that HAVE a public endpoint, keyed by
 * provider id. Derived from {@link OPENAI_COMPATIBLE_ENDPOINTS} by dropping the operator-hosted
 * gateways, so the two can never disagree about which providers default to what.
 */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS: Readonly<Record<string, string>> =
  Object.fromEntries(
    OPENAI_COMPATIBLE_PROVIDERS.flatMap((provider) => {
      const baseUrl: string | null = OPENAI_COMPATIBLE_ENDPOINTS[provider]
      return baseUrl ? [[provider, baseUrl] as [string, string]] : []
    }),
  )

/**
 * A DIRECT model provider: one reached with a key from the workspace "AI providers" pool, as
 * opposed to a pooled subscription harness, a binding, or a per-user local runner. Every
 * {@link OPENAI_COMPATIBLE_PROVIDERS} member plus `anthropic`, which speaks its own SDK dialect.
 *
 * This is also exactly the set whose base URL a deployment may override through
 * `${PROVIDER}_BASE_URL`: `anthropic` has no default here (its SDK carries one) but DOES honour
 * an override, which is why a facade's env map is total over this union rather than over the
 * OpenAI-compatible one. Skipping `anthropic` there is silent both ways: an operator pointing a
 * deployment at an Anthropic-compatible endpoint gets no error and no effect.
 */
export type DirectProvider = OpenAiCompatibleProvider | 'anthropic'

/**
 * The direct providers, sorted for a deterministic, stable rendering. The single source of truth
 * for that list: a provisioning remedy names it from here rather than re-listing the vendors
 * inline, so adding a provider to {@link OPENAI_COMPATIBLE_ENDPOINTS} keeps the error text in
 * step.
 */
export const UI_CONFIGURABLE_DIRECT_PROVIDERS: readonly DirectProvider[] = (
  [...OPENAI_COMPATIBLE_PROVIDERS, 'anthropic'] as DirectProvider[]
).sort()

/** Whether `provider` is a {@link DirectProvider} (key-pooled, `${PROVIDER}_BASE_URL`-overridable). */
export function isDirectProvider(provider: string): provider is DirectProvider {
  return provider === 'anthropic' || isOpenAiCompatibleProvider(provider)
}

/**
 * The single source of truth for "where does OpenAI-compatible provider X live": a
 * per-deployment env override always wins, but a *blank* override falls back to the
 * built-in default (so `QWEN_BASE_URL=` does not silently disable the provider). Returns
 * undefined when the provider has neither an override nor a built-in default, which covers
 * both providers that are not OpenAI-compatible (`anthropic`, `workers-ai`) and the
 * operator-hosted gateways with no public endpoint (`bifrost`, `litellm`), which resolve only
 * once their override is set. Every facade (Worker, Node) routes its base-URL resolution
 * through here so adding a provider is a one-line {@link OPENAI_COMPATIBLE_ENDPOINTS} entry
 * both runtimes pick up automatically.
 *
 * The defaults lookup is `Object.hasOwn`-guarded for the reason
 * {@link isOpenAiCompatibleProvider} is: the map is a plain object, so a bare index would answer
 * `Object.prototype.toString` (a Function) for `provider === 'toString'` under a signature that
 * promises a string, and this function takes a raw `string` from callers that have not narrowed.
 */
export function resolveOpenAiCompatibleBaseUrl(
  provider: string,
  override: string | null | undefined,
): string | undefined {
  const configured = override?.trim()
  if (configured) return configured
  return Object.hasOwn(DEFAULT_OPENAI_COMPATIBLE_BASE_URLS, provider)
    ? DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider]
    : undefined
}

/**
 * Cloudflare's OpenAI-compatible base URL for an account: the direct Workers AI REST endpoint,
 * or an AI Gateway when the deployment names one. The ONE place that URL shape is stated, so the
 * inline resolver (`cloudflareRestResolver`), the Node container-proxy upstream and the
 * benchmark harness cannot dial three different hosts for the same `workers-ai` model.
 *
 * NOT a member of {@link OPENAI_COMPATIBLE_ENDPOINTS}: that table maps a provider to a CONSTANT,
 * and this one is a function of the account. `workers-ai` therefore stays outside the
 * OpenAI-compatible provider union (it is reached through the `AI` binding where a runtime has
 * one), and a facade that serves it over REST resolves the URL here.
 */
export function cloudflareRestBaseUrl(opts: { accountId: string; gateway?: string }): string {
  return opts.gateway
    ? `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gateway}/workers-ai/v1`
    : `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/v1`
}
// The GATEWAY branch above is on borrowed time, and what replaces it is not a URL swap. Nothing
// Cloudflare currently publishes shows a `workers-ai/v1` segment: the Workers AI provider page
// documents only the direct `api.cloudflare.com/client/v4/...` form (the branch below it, which is
// verified), and the gateway's OpenAI-compatible route is now documented as
// `gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` with `workers-ai/<model>` in the MODEL
// FIELD rather than as a path segment. So migrating means rewriting the model string as well as
// the base URL, in the inline resolver AND on the proxy's forward path (which passes the
// container's body through untouched), and neither can be verified from here without a live
// gateway. Left as-is deliberately, with the evidence recorded, rather than swapped half-way.
// Read 2026-08-18: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/

/**
 * Providers the container LLM proxy can serve, so a container agent's locked model
 * must resolve to one of them (see `LlmProxyController`):
 *  - `workers-ai`: through the in-process Cloudflare `AI` binding on a runtime that has one
 *    (the Worker), else forwarded to Cloudflare's OpenAI-compatible REST endpoint
 *    ({@link cloudflareRestBaseUrl}) under the deployment's own account credentials. Both routes
 *    are wired, because this predicate is runtime-NEUTRAL: it admits `workers-ai` at dispatch on
 *    every facade, so a facade serving neither route would refuse a model its own picker offered;
 *  - every OpenAI-compatible upstream the proxy forwards to
 *    ({@link OPENAI_COMPATIBLE_PROVIDERS}), including the operator-hosted **bifrost** and
 *    **litellm** gateways, which have no public default and resolve only once their
 *    `${PROVIDER}_BASE_URL` is set;
 *  - the per-user local runners (Ollama / LM Studio / …), forwarded to the run
 *    initiator's own endpoint with no key lease.
 *
 * NOT the pooled-subscription harnesses (Claude Code / Codex), which talk to the
 * vendor directly with a leased token and so never go through the proxy.
 */
export function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'workers-ai' || isOpenAiCompatibleProvider(provider) || isLocalRunner(provider)
  )
}
