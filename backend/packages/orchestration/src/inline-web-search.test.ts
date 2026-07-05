import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentKindRegistry,
  DEFAULT_INLINE_WEB_SEARCH_KINDS,
  DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
  defaultAgentKindRegistry,
  inlineWebSearchOptionsFromEnv,
  providerWebSearchTools,
  webResearchGuidanceFor,
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

describe('webResearchGuidanceFor', () => {
  let registry: AgentKindRegistry
  beforeEach(() => {
    registry = defaultAgentKindRegistry()
  })

  it('mentions web_fetch only for the container variant (fetch:true)', () => {
    expect(webResearchGuidanceFor('coder', registry, { fetch: true })).toMatch(/web_fetch/)
    // Inline agents get web_search only (the provider tool has no fetch companion).
    expect(webResearchGuidanceFor('architect', registry, { fetch: false })).not.toMatch(/web_fetch/)
    expect(webResearchGuidanceFor('architect', registry, { fetch: false })).toMatch(/web_search/)
  })

  it('tailors the nudge to the built-in kind', () => {
    expect(webResearchGuidanceFor('ci-fixer', registry, { fetch: true })).toMatch(/error message/i)
    expect(webResearchGuidanceFor('mocker', registry, { fetch: true })).toMatch(/third-party API/i)
    expect(webResearchGuidanceFor('researcher', registry)).toMatch(/primary tool/i)
  })

  it('falls back to a generic nudge for an unknown kind', () => {
    expect(webResearchGuidanceFor('totally-made-up-kind', registry)).toMatch(/verify a fact/i)
  })

  it('lets a registered (proprietary) kind supply its own hint, which wins', () => {
    // The shared library never names this kind; the org package declares its own
    // web-research hint at registration and the composer picks it up.
    registry.register({
      kind: 'security-auditor',
      systemPrompt: 'You audit security.',
      webResearchHint: 'check the CVE database for the exact advisory id',
    })
    expect(webResearchGuidanceFor('security-auditor', registry, { fetch: true })).toMatch(
      /CVE database/i,
    )
  })
})
