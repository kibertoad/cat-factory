import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INLINE_WEB_SEARCH_KINDS,
  DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
  inlineWebSearchOptionsFromEnv,
  providerWebSearchTools,
} from '@cat-factory/agents'

// Provider-hosted web search for the INLINE design/research agents (architect /
// researcher). These are the pure pieces — env parsing + provider→tool selection —
// the AiAgentExecutor uses to attach a `web_search` tool to its one-shot call.

describe('inlineWebSearchOptionsFromEnv', () => {
  it('is off unless explicitly enabled', () => {
    expect(inlineWebSearchOptionsFromEnv({})).toBeUndefined()
    expect(inlineWebSearchOptionsFromEnv({ INLINE_WEB_SEARCH_ENABLED: 'false' })).toBeUndefined()
    // A configured provider key alone does NOT turn the inline path on — unlike the
    // container/Pi tools, this is gated by its own explicit switch.
    expect(inlineWebSearchOptionsFromEnv({ INLINE_WEB_SEARCH_ENABLED: '' })).toBeUndefined()
  })

  it('enables with the default architect/researcher allow-list', () => {
    const opts = inlineWebSearchOptionsFromEnv({ INLINE_WEB_SEARCH_ENABLED: 'true' })
    expect(opts).toBeDefined()
    expect(opts?.kinds).toBe(DEFAULT_INLINE_WEB_SEARCH_KINDS)
    expect(opts?.kinds.has('architect')).toBe(true)
    expect(opts?.kinds.has('researcher')).toBe(true)
    expect(opts?.kinds.has('coder')).toBe(false)
    expect(opts?.maxUses).toBe(DEFAULT_INLINE_WEB_SEARCH_MAX_USES)
  })

  it('accepts 1/yes as truthy', () => {
    expect(inlineWebSearchOptionsFromEnv({ INLINE_WEB_SEARCH_ENABLED: '1' })).toBeDefined()
    expect(inlineWebSearchOptionsFromEnv({ INLINE_WEB_SEARCH_ENABLED: 'YES' })).toBeDefined()
  })

  it('honours a custom kinds list and max-uses cap', () => {
    const opts = inlineWebSearchOptionsFromEnv({
      INLINE_WEB_SEARCH_ENABLED: 'true',
      INLINE_WEB_SEARCH_KINDS: 'researcher, Reviewer',
      INLINE_WEB_SEARCH_MAX_USES: '3',
    })
    expect([...(opts?.kinds ?? [])].sort()).toEqual(['researcher', 'reviewer'])
    expect(opts?.maxUses).toBe(3)
  })

  it('falls back to the default cap on a garbage max-uses', () => {
    const opts = inlineWebSearchOptionsFromEnv({
      INLINE_WEB_SEARCH_ENABLED: 'true',
      INLINE_WEB_SEARCH_MAX_USES: '-2',
    })
    expect(opts?.maxUses).toBe(DEFAULT_INLINE_WEB_SEARCH_MAX_USES)
  })
})

describe('providerWebSearchTools', () => {
  it('exposes a web_search tool for the hosted-search providers', () => {
    expect(providerWebSearchTools('anthropic')).toHaveProperty('web_search')
    expect(providerWebSearchTools('openai')).toHaveProperty('web_search')
  })

  it('returns undefined for providers without a hosted search', () => {
    // Workers AI / the OpenAI-compatible trio / mock have no server-executed search,
    // so inline agents on those providers simply run without web access.
    expect(providerWebSearchTools('workers-ai')).toBeUndefined()
    expect(providerWebSearchTools('qwen')).toBeUndefined()
    expect(providerWebSearchTools('mock')).toBeUndefined()
  })
})
