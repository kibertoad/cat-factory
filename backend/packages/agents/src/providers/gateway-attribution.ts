import type { OpenRouterDataCollection } from './endpoints.js'

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
 * The extra OpenAI Chat Completions body fields that turn a gateway's reporting on, for the
 * CONTAINER path. Empty for every provider that has none, so the proxy can merge it
 * unconditionally (the shape `promptCacheParams` already established).
 *
 * `require_parameters` keeps the request off an upstream that would silently ignore a tool
 * definition, which is the failure mode a gateway adds over talking to a vendor directly.
 * `data_collection` is a deployment decision rather than a default to inherit: an agent's prompt
 * is the customer's checkout, and OpenRouter's own default is permissive.
 */
export function gatewayRequestParams(
  provider: string,
  opts?: { dataCollection?: OpenRouterDataCollection },
): Record<string, unknown> {
  if (!reportsGatewayAttribution(provider)) return {}
  return {
    usage: { include: true },
    provider: {
      require_parameters: true,
      data_collection: opts?.dataCollection ?? 'deny',
    },
  }
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
 * Keyed on the `openrouter` metadata namespace the client itself stamps rather than on the
 * caller's `ref.provider`: the provider id is a deployment's own label and a deployment may
 * register the gateway under another one, so reading the metadata is what keeps the two in step.
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
