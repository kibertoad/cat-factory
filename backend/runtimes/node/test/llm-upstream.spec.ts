import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  isProxyableProvider,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
} from '@cat-factory/agents'
import { LOCAL_RUNNERS, apiKeyProviderSchema, isLocalRunner } from '@cat-factory/contracts'
import { noopLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { createNodeGateways } from '../src/gateways.js'

// The Node facade's container-LLM-proxy upstream. Pure env resolution, so no database.
//
// The bug it pins is a DIVERGENCE between the dispatch guard and this upstream: the upstream used
// to carry its own provider→env map, which omitted `xai`. `isProxyableProvider` (read from the
// shared table) admitted an `xai`-pinned Pi step at dispatch, and the run then died here as
// "upstream not available": a facade-local omission that no assertion about either half alone could
// see. So the assertion below is over the GUARD's own set, not over a list this file names, and it
// covers `workers-ai` too, the second provider the guard admits and this facade once refused.
const upstreamFor = (env: NodeJS.ProcessEnv) => createNodeGateways(env).llmUpstream

/** The deployment env that configures each provider the guard admits, other than a local runner. */
const CONFIGURED: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    OPERATOR_HOSTED_GATEWAYS.map((provider) => [
      `${provider.toUpperCase()}_BASE_URL`,
      `https://${provider}.internal/v1`,
    ]),
  ),
  CLOUDFLARE_ACCOUNT_ID: 'acct1',
  CLOUDFLARE_API_TOKEN: 'cf-token',
}

/** The base URL a configured deployment must resolve for `provider`. */
const expectedBaseUrl = (provider: string): string =>
  provider === 'workers-ai'
    ? 'https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1'
    : (DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider] ?? `https://${provider}.internal/v1`)

describe('[node] container LLM proxy upstream', () => {
  it('resolves an upstream for every non-local provider the dispatch guard admits', () => {
    const upstream = upstreamFor(CONFIGURED)
    // Every provider the guard lets through, minus the per-user local runners (which the proxy
    // resolves from the run initiator's own endpoint, not from this gateway). Derived from the two
    // vocabularies the guard itself reads, so a provider added to either is covered here rather
    // than arriving as a run that dies mid-flight.
    const admitted = [...apiKeyProviderSchema.options, 'workers-ai'].filter(
      (provider) => isProxyableProvider(provider) && !isLocalRunner(provider),
    )
    expect(admitted).toContain('workers-ai')
    for (const provider of admitted) {
      expect({ provider, resolved: upstream.resolveOpenAiCompatible(provider) }).toEqual({
        provider,
        resolved: expect.objectContaining({ baseURL: expectedBaseUrl(provider) }),
      })
    }
  })

  it('reports no upstream for an operator-hosted gateway until its base URL is set', () => {
    for (const provider of OPERATOR_HOSTED_GATEWAYS) {
      const key = `${provider.toUpperCase()}_BASE_URL`
      expect(upstreamFor({}).resolveOpenAiCompatible(provider)).toBeNull()
      // A set-but-blank value is not a configured gateway: it must stay null rather than
      // collapse to an empty URL the upstream fetch then chokes on.
      expect(upstreamFor({ [key]: '  ' }).resolveOpenAiCompatible(provider)).toBeNull()
      expect(upstreamFor({ [key]: 'https://gw.internal/v1' }).resolveOpenAiCompatible(provider)) //
        .toEqual({ baseURL: 'https://gw.internal/v1' })
    }
  })

  it('honours a per-provider base-URL override over the built-in default', () => {
    const upstream = upstreamFor({ QWEN_BASE_URL: 'https://qwen.stub/v1' })
    expect(upstream.resolveOpenAiCompatible('qwen')).toEqual({ baseURL: 'https://qwen.stub/v1' })
  })

  it('serves workers-ai over the Cloudflare REST endpoint, carrying the account token itself', () => {
    // There is no `AI` binding on Node (`runInProcess` is null), so the guard's admission of
    // `workers-ai` is honoured by FORWARDING to Cloudflare's own OpenAI-compatible endpoint. The
    // bearer rides the endpoint because `workers-ai` is not an `ApiKeyProvider`: the proxy has no
    // pool to lease it from, and the credential is a deployment-level fact.
    expect(upstreamFor(CONFIGURED).resolveOpenAiCompatible('workers-ai')).toEqual({
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1',
      apiKey: 'cf-token',
    })
    expect(
      upstreamFor(CONFIGURED).runInProcess({
        model: '@cf/meta/llama-3.1-8b-instruct',
        payload: {},
        streaming: false,
        record: () => Promise.resolve(0),
        waitUntil: () => {},
        log: noopLogger,
      }),
    ).toBeNull()
  })

  it('routes workers-ai through an AI Gateway when the deployment names one', () => {
    const upstream = upstreamFor({ ...CONFIGURED, CLOUDFLARE_AI_GATEWAY: 'gw' })
    expect(upstream.resolveOpenAiCompatible('workers-ai')).toEqual({
      baseURL: 'https://gateway.ai.cloudflare.com/v1/acct1/gw/workers-ai/v1',
      apiKey: 'cf-token',
    })
  })

  it('reports no workers-ai upstream when only half the Cloudflare pair is set', () => {
    // Both halves are required, and blank counts as absent: this is the same reading the model
    // catalog's `cloudflareModelsEnabled` gate takes, so the picker cannot offer a Cloudflare model
    // this upstream would then refuse.
    for (const env of [
      {},
      { CLOUDFLARE_ACCOUNT_ID: 'acct1' },
      { CLOUDFLARE_API_TOKEN: 'cf-token' },
      { CLOUDFLARE_ACCOUNT_ID: '  ', CLOUDFLARE_API_TOKEN: 'cf-token' },
    ]) {
      expect(upstreamFor(env).resolveOpenAiCompatible('workers-ai')).toBeNull()
    }
  })

  it('refuses the providers that are not OpenAI-shaped, override or not', () => {
    // `anthropic` DOES honour an `ANTHROPIC_BASE_URL` on the inline path (its own SDK reaches an
    // Anthropic-compatible endpoint), which is exactly why the membership test cannot be "did an
    // override resolve": forwarding an Anthropic endpoint down the OpenAI-shaped proxy path
    // would send it a request body it does not accept.
    const upstream = upstreamFor({ ...CONFIGURED, ANTHROPIC_BASE_URL: 'https://anthropic.stub/v1' })
    expect(upstream.resolveOpenAiCompatible('anthropic')).toBeNull()
    expect(upstream.resolveOpenAiCompatible('bedrock')).toBeNull()
    // Per-user local runners are forwarded to the initiator's own endpoint, not from here.
    for (const runner of LOCAL_RUNNERS) {
      expect(upstream.resolveOpenAiCompatible(runner)).toBeNull()
    }
  })

  it('covers every OpenAI-compatible table member', () => {
    // A floor on the loop above: an empty or collapsed vocabulary would make these assertions pass
    // having checked nothing.
    expect(OPENAI_COMPATIBLE_PROVIDERS.length).toBeGreaterThan(1)
    expect(OPERATOR_HOSTED_GATEWAYS.length).toBeGreaterThan(0)
  })
})
