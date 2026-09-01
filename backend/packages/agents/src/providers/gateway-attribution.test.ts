import { describe, expect, it } from 'vitest'
import {
  gatewayRequestParams,
  readCompletionGatewayReport,
  readMetadataGatewayReport,
  reportsGatewayAttribution,
} from './gateway-attribution.js'

// The one module both model paths ask and read through. Splitting the rule across the inline SDK
// path and the container proxy would be silent when it drifted: a path that stopped asking keeps
// working and simply records nothing, which downstream is indistinguishable from a gateway that
// reports nothing. These pin the two halves against each other.

describe('gatewayRequestParams', () => {
  it('turns usage accounting on and constrains routing for a gateway', () => {
    expect(gatewayRequestParams('openrouter')).toEqual({
      usage: { include: true },
      provider: { require_parameters: true, data_collection: 'deny' },
    })
  })

  it('denies prompt-retaining upstreams unless the deployment opts in', () => {
    // OpenRouter's own default is permissive and this platform's is not: an agent prompt is the
    // customer's checkout, so the opt-in is an operator decision on the record.
    const allowed = gatewayRequestParams('openrouter', { dataCollection: 'allow' })
    expect((allowed.provider as { data_collection: string }).data_collection).toBe('allow')
    const denied = gatewayRequestParams('openrouter', { dataCollection: 'deny' })
    expect((denied.provider as { data_collection: string }).data_collection).toBe('deny')
  })

  it('sends nothing to a provider that reports nothing', () => {
    // Empty rather than a partial body, so the proxy can merge it unconditionally: an unknown key
    // in the body of a strict endpoint buys nothing and can be refused outright.
    for (const provider of ['qwen', 'openai', 'anthropic', 'workers-ai', 'litellm', 'bifrost']) {
      expect(gatewayRequestParams(provider)).toEqual({})
      expect(reportsGatewayAttribution(provider)).toBe(false)
    }
    expect(reportsGatewayAttribution('openrouter')).toBe(true)
  })
})

describe('readCompletionGatewayReport', () => {
  it('reads the ledger cost and the upstream off a buffered completion', () => {
    expect(
      readCompletionGatewayReport({
        provider: 'anthropic',
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0421 },
      }),
    ).toEqual({ cost: 0.0421, upstream: 'anthropic' })
  })

  // Absent and zero are DIFFERENT facts. A reader takes the derived price-table estimate for the
  // first and the exact figure for the second; collapsing them re-prices the one call whose price
  // is certain, as free.
  it('keeps a reported zero and omits an unreported one', () => {
    expect(readCompletionGatewayReport({ usage: { cost: 0 } })).toEqual({ cost: 0 })
    expect(readCompletionGatewayReport({ usage: { prompt_tokens: 10 } })).toEqual({})
    expect(readCompletionGatewayReport({})).toEqual({})
    expect(readCompletionGatewayReport(null)).toEqual({})
  })

  it('refuses a malformed cost rather than coercing one into the measured column', () => {
    for (const cost of ['0.04', Number.NaN, Number.POSITIVE_INFINITY, -1, null, {}]) {
      expect(readCompletionGatewayReport({ provider: 'anthropic', usage: { cost } })).toEqual({
        // The upstream survives independently: a garbled cost must not cost us the other half.
        upstream: 'anthropic',
      })
    }
  })

  it('reads the two halves independently, as a streamed reply delivers them', () => {
    // OpenRouter names the upstream on the FIRST chunk and carries the cost on the LAST, which is
    // why the proxy MERGES successive reads rather than replacing.
    const first = readCompletionGatewayReport({ provider: 'deepinfra', choices: [{}] })
    const last = readCompletionGatewayReport({ usage: { cost: 0.002 } })
    expect(first).toEqual({ upstream: 'deepinfra' })
    expect(last).toEqual({ cost: 0.002 })
    expect({ ...first, ...last }).toEqual({ upstream: 'deepinfra', cost: 0.002 })
  })

  it('ignores an empty upstream name', () => {
    expect(readCompletionGatewayReport({ provider: '', usage: { cost: 1 } })).toEqual({ cost: 1 })
  })
})

describe('readMetadataGatewayReport', () => {
  it('reads the same two facts off an AI SDK result', () => {
    expect(
      readMetadataGatewayReport({
        providerMetadata: {
          openrouter: { provider: 'anthropic', usage: { cost: 0.0421, promptTokens: 150 } },
        },
      }),
    ).toEqual({ cost: 0.0421, upstream: 'anthropic' })
  })

  // Keyed on the metadata namespace the client stamps rather than on the caller's provider id: a
  // deployment may register the gateway under its own label, and the metadata is what stays true.
  it('reports nothing for a result with no gateway metadata', () => {
    expect(readMetadataGatewayReport({ providerMetadata: { anthropic: { usage: {} } } })).toEqual(
      {},
    )
    expect(readMetadataGatewayReport({ providerMetadata: {} })).toEqual({})
    expect(readMetadataGatewayReport({})).toEqual({})
    expect(readMetadataGatewayReport(undefined)).toEqual({})
  })

  it('applies the same validity rules as the wire reader', () => {
    const metadata = (usage: unknown) => ({ providerMetadata: { openrouter: { usage } } })
    expect(readMetadataGatewayReport(metadata({ cost: 0 }))).toEqual({ cost: 0 })
    expect(readMetadataGatewayReport(metadata({ cost: '0.04' }))).toEqual({})
    expect(readMetadataGatewayReport(metadata({ cost: -1 }))).toEqual({})
  })
})
