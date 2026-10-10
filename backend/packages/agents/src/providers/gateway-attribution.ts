import { DEFAULT_OPENROUTER_ROUTING, type OpenRouterRouting } from './endpoints.js'

// What a GATEWAY reports about a call, and how to ask for it, in ONE module, because the same
// two facts are requested and read on BOTH model paths and the paths speak different dialects.
//
//   - INLINE: the Vercel AI SDK, where `openRouterResolver` sets the options and the reply lands
//     on `providerMetadata.openrouter`.
//   - CONTAINER: the LLM proxy, which forwards a raw OpenAI Chat Completions body and reads a raw
//     completion back, so it needs the same options as plain body fields and the same answer out
//     of `usage.cost` / `provider`.
//
// Splitting the rule across the two would be silent when it drifted: a path that stopped asking
// for usage accounting keeps working and simply records nothing, which downstream is
// indistinguishable from a gateway that reports nothing.
//
// Why any of it: every other cost figure this platform holds is DERIVED (the spend price table
// times the token classes). That is the best available answer against a direct vendor. Against a
// passthrough gateway reselling hundreds of models at the upstream's own rates it is a guess, and
// OpenRouter will simply tell us, including WHICH upstream served the call, which one `provider`
// column of `openrouter` otherwise hides completely.

/** The gateway's own account of one call: its ledger cost and the upstream it routed to. */
export interface GatewayCallReport {
  /**
   * What the gateway charged, in USD, when it says. Absent means NOT REPORTED, which is a
   * different fact from a reported 0 (a genuinely free route) and must stay so: a reader takes
   * the derived estimate for the first and the exact figure for the second.
   */
  cost?: number
  /** The upstream that served the call (`anthropic`, `deepinfra`, …), when the gateway names it. */
  upstream?: string
}

/**
 * Whether `provider` is a gateway this platform asks for usage accounting.
 *
 * Only OpenRouter today. The operator-hosted gateways (`bifrost`, `litellm`) speak plain
 * OpenAI-compatible and publish no such fields, so asking them would put an unknown key in the
 * body of a strict endpoint for nothing.
 */
export function reportsGatewayAttribution(provider: string): boolean {
  return provider === 'openrouter'
}

/**
 * The extra OpenAI Chat Completions body fields that turn a gateway's reporting on and state the
 * deployment's routing policy, for the CONTAINER path. Empty for every provider that has none, so
 * the proxy can merge it unconditionally (the shape `promptCacheParams` already established).
 *
 * Both members of {@link OpenRouterRouting} narrow the upstream pool, so both are the
 * deployment's to set rather than constants here; see that type for what each buys and costs, and
 * {@link gatewayRoutingRefusal} for what a caller says when the narrowing empties the pool.
 */
export function gatewayRequestParams(
  provider: string,
  routing: OpenRouterRouting = DEFAULT_OPENROUTER_ROUTING,
): Record<string, unknown> {
  if (!reportsGatewayAttribution(provider)) return {}
  return {
    usage: { include: true },
    provider: {
      require_parameters: routing.requireParameters,
      data_collection: routing.dataCollection,
    },
  }
}

/**
 * OpenRouter's wording when provider routing leaves no upstream to serve the model. Matched on
 * the stable half of the sentence (`no allowed providers`), never the whole of it: the tail names
 * the model and the head has already been reworded once.
 */
const NO_ALLOWED_PROVIDERS = /no allowed providers?/i

/**
 * Name the routing constraint that can have caused a gateway's refusal, or undefined when this
 * failure is not one of ours to explain.
 *
 * Why it exists: the two constraints above are the only reason a model that resolves for everyone
 * else fails for one deployment, and the gateway's own 404 says only that no provider was
 * allowed. It cannot know WHICH allow-list did the excluding, because the platform's request is
 * the only place both are stated. Left unexplained, the operator sees a run fail with an opaque
 * upstream error and nothing anywhere connects it to a variable they set (or, worse, never set:
 * `deny` is stricter than the vendor's own default, so the deployment that hits this hardest is
 * the one that configured nothing).
 *
 * Only the constraints actually IN FORCE are named, so relaxing what it names is always a step
 * forward; when neither is on, the refusal is the gateway's own and this answers undefined
 * rather than sending the operator after a setting that changed nothing.
 */
export function gatewayRoutingRefusal(opts: {
  provider: string
  status: number
  body: string
  routing: OpenRouterRouting
}): string | undefined {
  if (!reportsGatewayAttribution(opts.provider)) return undefined
  if (opts.status < 400 || !NO_ALLOWED_PROVIDERS.test(opts.body)) return undefined
  const relaxable: string[] = []
  if (opts.routing.dataCollection === 'deny') {
    relaxable.push(
      'OPENROUTER_DATA_COLLECTION=allow (this deployment denies prompt-retaining upstreams)',
    )
  }
  if (opts.routing.requireParameters) {
    relaxable.push(
      'OPENROUTER_REQUIRE_PARAMETERS=false (this deployment requires an upstream to advertise every request parameter)',
    )
  }
  if (relaxable.length === 0) return undefined
  return `OpenRouter had no upstream left to route to. This deployment's provider routing is what narrows the pool; relax one of: ${relaxable.join('; ')}.`
}

/** A finite, non-negative number, else undefined. Zero passes: a free route reports one. */
function reportedCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A non-empty string, else undefined. */
function reportedUpstream(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the report off a raw OpenAI-shaped completion (or the final streamed chunk): the
 * CONTAINER path's reader.
 *
 * OpenRouter puts the ledger cost on `usage.cost` and the upstream's name at the top level as
 * `provider`. Both are read defensively and independently: a gateway that garbles one must not
 * cost us the other, and neither may be coerced, because a coerced cost is a fabricated number
 * sitting in the one column the product presents as measured.
 */
export function readCompletionGatewayReport(body: unknown): GatewayCallReport {
  const completion = body as { provider?: unknown; usage?: { cost?: unknown } | null } | undefined
  if (!completion) return {}
  const cost = reportedCost(completion.usage?.cost)
  const upstream = reportedUpstream(completion.provider)
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(upstream === undefined ? {} : { upstream }),
  }
}

/**
 * Read the report off an AI SDK generate result: the INLINE path's reader.
 *
 * Keyed on the `openrouter` metadata namespace because that is where the CLIENT puts it, not
 * because the provider id is unreliable: the id is the closed {@link OPENAI_COMPATIBLE_PROVIDERS}
 * table's own member, and {@link reportsGatewayAttribution} keys the request half on that same
 * literal. Whoever adds the second gateway adds a namespace here beside a provider id there, and
 * the pairing is what has to stay in step. Reading one off the other would not help: the two
 * vocabularies are the vendor's and ours.
 */
export function readMetadataGatewayReport(result: unknown): GatewayCallReport {
  const metadata = (result as { providerMetadata?: unknown })?.providerMetadata
  const openrouter = (metadata as { openrouter?: unknown } | undefined)?.openrouter as
    | { provider?: unknown; usage?: { cost?: unknown } }
    | undefined
  if (!openrouter) return {}
  const cost = reportedCost(openrouter.usage?.cost)
  const upstream = reportedUpstream(openrouter.provider)
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(upstream === undefined ? {} : { upstream }),
  }
}
