// Prompt-caching policy — the single source of truth for how a provider caches a
// growing prompt prefix. It lives in the kernel (not the agents facade) because BOTH
// the AI-call paths AND the model catalog need it: the catalog projects a per-model
// `cachesPrompts` capability the SPA's vendor pickers surface, and the proxy/inline
// paths give the provider the routing hint it needs (those request-building helpers
// stay in `@cat-factory/agents`, which re-exports `providerCachePolicy` from here).
//
// A container agent re-sends its whole growing prompt every turn, so on the providers
// that cache it the stable prefix is a cache hit rather than re-billed input — but
// only with a stable prefix and the provider-specific hint. Keeping the classification
// here means neither the catalog nor the call paths hard-code provider ids twice.

export type CachePolicy =
  // Caches automatically on an exact prefix match; some accept a routing key to pin
  // multi-turn calls to the same cached prefix (OpenAI), others need nothing but a
  // stable prefix (DeepSeek, Qwen/DashScope).
  | 'auto-prefix'
  // Requires explicit `cache_control` breakpoints in the request (Anthropic).
  | 'explicit-anthropic'
  // No caching we rely on (Workers AI third-party models, Moonshot, unknown).
  | 'none'

/**
 * A GATEWAY provider id: one `provider` value fronting many upstream vendors, where the caching
 * behaviour is the UPSTREAM's and the slug is the only thing that names it.
 *
 * Only OpenRouter today. The operator-hosted gateways (`bifrost`, `litellm`) also front many
 * vendors, but their model ids are the OPERATOR's own aliases (LiteLLM's `model_name` from a
 * `config.yaml`), so there is nothing in the id to read a vendor off; they stay `none`, which is
 * the honest answer for a mapping this platform cannot see.
 */
const GATEWAY_PROVIDERS = new Set(['openrouter'])

/**
 * Which direct provider a gateway slug's vendor prefix corresponds to.
 *
 * OpenRouter addresses a model as `vendor/model`, and the vendor half is the same set of vendors
 * this platform already reaches directly under its own provider ids. The names differ in a few
 * places (`x-ai` against our `xai`, `moonshotai` against our `moonshot`, `google` and `z-ai`
 * having no direct id here at all), so the mapping is stated rather than assumed: a prefix left
 * out simply answers `none`, which is what an unrecognised vendor should say.
 */
const GATEWAY_VENDOR_PREFIX: Readonly<Record<string, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  qwen: 'qwen',
  'x-ai': 'xai',
  moonshotai: 'moonshot',
}

/**
 * How `provider` caches prompt prefixes. The single source of truth for every path.
 *
 * `model` is optional and only consulted for a GATEWAY, where the provider id names the reseller
 * and the slug names who actually serves the call. Without it every OpenRouter model answered
 * `none`, which is wrong in the direction that costs money silently: a container agent re-sends
 * its whole history every turn, and `openrouter:deepseek/deepseek-v4` rides exactly the same
 * automatic prefix cache as `deepseek:deepseek-v4` while the picker told the user it cached
 * nothing. Callers with no model in hand (the two request-building helpers, which only ever act
 * on a DIRECT provider) may omit it.
 *
 * A gateway slug resolves to its UPSTREAM's policy, with one deliberate asymmetry:
 * `explicit-anthropic` is downgraded to `none`, because that policy is a claim about a request
 * this platform builds, and nothing on the gateway path emits `cache_control` breakpoints.
 * Reporting `explicit-anthropic` there would tell the picker a prefix is cached that nobody asked
 * to cache. Adding the breakpoints is what would let that answer change.
 */
export function providerCachePolicy(provider: string, model?: string): CachePolicy {
  if (GATEWAY_PROVIDERS.has(provider)) return gatewayCachePolicy(model)
  switch (provider) {
    case 'openai':
    case 'deepseek':
    case 'qwen':
    // xAI caches prompt prefixes automatically and bills the hits at its own published
    // cached-input rate, with no per-request opt-in, so it belongs with the auto-prefix
    // group rather than Anthropic's explicit `cache_control` breakpoints.
    case 'xai':
      return 'auto-prefix'
    case 'anthropic':
      return 'explicit-anthropic'
    default:
      return 'none'
  }
}

/** The upstream's policy for a `vendor/model` gateway slug; see {@link providerCachePolicy}. */
function gatewayCachePolicy(model: string | undefined): CachePolicy {
  const slash = model?.indexOf('/') ?? -1
  if (slash <= 0) return 'none'
  const direct = GATEWAY_VENDOR_PREFIX[model!.slice(0, slash).toLowerCase()]
  if (!direct) return 'none'
  const upstream = providerCachePolicy(direct)
  return upstream === 'explicit-anthropic' ? 'none' : upstream
}

/** Whether `provider` caches prompt prefixes at all (any policy other than `none`). */
export function providerCachesPrompts(provider: string, model?: string): boolean {
  return providerCachePolicy(provider, model) !== 'none'
}
