import { isLocalRunner } from '@cat-factory/contracts'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours.
// DashScope (Alibaba/Qwen), DeepSeek and Moonshot (Kimi) all expose the OpenAI
// `/chat/completions` shape, so both the Vercel-AI model provider and the container
// LLM proxy resolve them from the same base URLs and keys — one source of truth for
// "where does provider X live". Each is overridable per deployment (a self-hosted
// gateway, a regional endpoint, or a local stub in tests).
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const XAI_BASE_URL = 'https://api.x.ai/v1'
// OpenRouter is a single OpenAI-compatible gateway to 300+ models, hosted by OpenRouter
// itself, so it has a public endpoint to default to.
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

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
  // Bifrost (maximhq/bifrost) — a self-hosted Go gateway fronting 1000+ models behind one
  // OpenAI-compatible `/v1`. Model ids are canonical `provider/model` pairs (`openai/gpt-4o`).
  bifrost: null,
  // LiteLLM — a self-hosted Python gateway. Model ids are the operator's own `model_name`
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
 * The direct model providers whose API key is UI-configurable through the workspace
 * "AI providers" key pool: every {@link OPENAI_COMPATIBLE_PROVIDERS} member plus `anthropic`
 * (its own SDK, not OpenAI-shaped). This is the single source of truth for that list — a
 * provisioning remedy names it from here rather than re-listing the vendors inline, so adding a
 * provider to {@link OPENAI_COMPATIBLE_ENDPOINTS} keeps the error text in step. Sorted for a
 * deterministic, stable rendering.
 */
export const UI_CONFIGURABLE_DIRECT_PROVIDERS: readonly string[] = [
  ...OPENAI_COMPATIBLE_PROVIDERS,
  'anthropic',
].sort()

/**
 * The single source of truth for "where does OpenAI-compatible provider X live": a
 * per-deployment env override always wins, but a *blank* override falls back to the
 * built-in default (so `QWEN_BASE_URL=` does not silently disable the provider). Returns
 * undefined when the provider has neither an override nor a built-in default — that covers
 * both providers that are not OpenAI-compatible (`anthropic`, `workers-ai`) and the
 * operator-hosted gateways with no public endpoint (`bifrost`, `litellm`), which resolve only
 * once their override is set. Every facade (Worker, Node) routes its base-URL resolution
 * through here so adding a provider is a one-line {@link OPENAI_COMPATIBLE_ENDPOINTS} entry
 * both runtimes pick up automatically.
 */
export function resolveOpenAiCompatibleBaseUrl(
  provider: string,
  override: string | null | undefined,
): string | undefined {
  return override?.trim() || DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider]
}

/**
 * Providers the container LLM proxy can serve, so a container agent's locked model
 * must resolve to one of them (see `LlmProxyController`):
 *  - `workers-ai` — run in-Worker through the AI binding (no upstream, no key);
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
