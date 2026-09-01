// Prompt-caching policy — the single source of truth for how a provider caches a
// growing prompt prefix. It lives in contracts (not the kernel) because THREE readers have to
// agree about it: the model catalog projects a per-model `cachesPrompts` capability, the
// proxy/inline call paths give the provider the routing hint it needs, and the SPA's API-key
// page tells a user whether connecting a key upgrades its models to the caching flavour. The
// SPA cannot see the kernel, so a rule kept there becomes a hand-written copy in a Vue constant
// the moment the third reader appears, and the two then drift.
//
// A container agent re-sends its whole growing prompt every turn, so on the providers
// that cache it the stable prefix is a cache hit rather than re-billed input — but
// only with a stable prefix and the provider-specific hint. Keeping the classification
// here means no reader hard-codes provider ids twice.

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
 * What a gateway slug's VENDOR PREFIX caches, stated per prefix rather than borrowed from the
 * direct provider of the same name.
 *
 * The two are genuinely different facts and they disagree in both directions, which is why an
 * indirection through the direct provider ids was wrong twice over:
 *
 *  - **`moonshotai`**: Moonshot's own API is `none` here, but OpenRouter documents its Moonshot
 *    route as automatic ("does not require any additional configuration"), and the spend table
 *    pins a cache-read rate for `openrouter:moonshotai/kimi-k2.7-code` precisely because that
 *    route bills the class. Reading the direct id answered `none` for a route we already meter.
 *  - **`qwen`**: DashScope is `auto-prefix` direct, but OpenRouter's Alibaba route "requires
 *    explicit cache breakpoints" with the same `cache_control` syntax Anthropic uses, and
 *    nothing on the gateway path emits them. Reading the direct id claimed a cache the picker
 *    would never get.
 *
 * `z-ai` and `google` have no direct provider id here at all, so an indirection could not state
 * them however it was written; both are automatic on the gateway (Gemini 2.5 and newer cache
 * implicitly) and both publish a cache-read rate.
 *
 * A prefix left out answers `none`, which is what an unrecognised vendor should say: several
 * vendors publish a cache-read rate without OpenRouter documenting how the cache is entered, and
 * a rate alone does not tell a caller a hit will happen.
 *
 * Read 2026-09-01: https://openrouter.ai/docs/features/prompt-caching
 */
const GATEWAY_PREFIX_POLICY: Readonly<Record<string, CachePolicy>> = {
  // Automatic on the gateway, no per-request opt-in.
  openai: 'auto-prefix',
  deepseek: 'auto-prefix',
  moonshotai: 'auto-prefix',
  'x-ai': 'auto-prefix',
  'z-ai': 'auto-prefix',
  google: 'auto-prefix',
  // Explicit `cache_control` breakpoints, which nothing on this path emits; see
  // {@link providerCachePolicy} for why that becomes `none` rather than `explicit-anthropic`.
  anthropic: 'explicit-anthropic',
  qwen: 'explicit-anthropic',
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
 * A gateway slug resolves through {@link GATEWAY_PREFIX_POLICY}, with one deliberate asymmetry:
 * `explicit-anthropic` is downgraded to `none`, because that policy is a claim about a request
 * this platform builds, and nothing on the gateway path emits `cache_control` breakpoints.
 * Reporting it there would tell the picker a prefix is cached that nobody asked to cache.
 * Adding the breakpoints is what would let that answer change.
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

/** The policy for a `vendor/model` gateway slug; see {@link providerCachePolicy}. */
function gatewayCachePolicy(model: string | undefined): CachePolicy {
  const slash = model?.indexOf('/') ?? -1
  if (slash <= 0) return 'none'
  const policy = GATEWAY_PREFIX_POLICY[model!.slice(0, slash).toLowerCase()]
  if (!policy) return 'none'
  return policy === 'explicit-anthropic' ? 'none' : policy
}

/** Whether `provider` caches prompt prefixes at all (any policy other than `none`). */
export function providerCachesPrompts(provider: string, model?: string): boolean {
  return providerCachePolicy(provider, model) !== 'none'
}
