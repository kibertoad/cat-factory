import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { createNodeGateways } from '../src/gateways.js'

// The Node facade's container-LLM-proxy upstream. Pure env resolution, so no database.
//
// It is asserted over the SHARED provider table rather than a named list, because the bug this
// pins was a DIVERGENCE from that table: the upstream used to carry its own provider→env map,
// which omitted `xai`. `isProxyableProvider` (read from the table) admitted an `xai`-pinned Pi
// step at dispatch, and the run then died here as "upstream not available" — a facade-local
// omission that no assertion about either half alone could see.
const upstreamFor = (env: NodeJS.ProcessEnv) => createNodeGateways(env).llmUpstream

describe('[node] OpenAI-compatible proxy upstream', () => {
  it('resolves an upstream for every provider the dispatch guard admits', () => {
    const upstream = upstreamFor({})
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      const expected = DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider]
      // An operator-hosted gateway has no default, so with no env it correctly resolves nothing;
      // every other member must answer with its built-in endpoint.
      if (!expected) continue
      expect(upstream.resolveOpenAiCompatible(provider)).toEqual({ baseURL: expected })
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

  it('refuses the providers that are not OpenAI-shaped, override or not', () => {
    // `anthropic` DOES honour an `ANTHROPIC_BASE_URL` on the inline path (its own SDK reaches an
    // Anthropic-compatible endpoint), which is exactly why the membership test cannot be "did an
    // override resolve": forwarding an Anthropic endpoint down the OpenAI-shaped proxy path
    // would send it a request body it does not accept.
    const upstream = upstreamFor({ ANTHROPIC_BASE_URL: 'https://anthropic.stub/v1' })
    expect(upstream.resolveOpenAiCompatible('anthropic')).toBeNull()
    expect(upstream.resolveOpenAiCompatible('workers-ai')).toBeNull()
    // Per-user local runners are forwarded to the initiator's own endpoint, not from here.
    expect(upstream.resolveOpenAiCompatible('ollama')).toBeNull()
  })
})
