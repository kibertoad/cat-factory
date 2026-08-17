import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  isOpenAiCompatibleProvider,
  isProxyableProvider,
  OPENAI_COMPATIBLE_PROVIDERS,
  resolveOpenAiCompatibleBaseUrl,
  UI_CONFIGURABLE_DIRECT_PROVIDERS,
} from './endpoints.js'

// The operator-hosted gateways: self-hosted software with no public instance, so each is a
// member of the OpenAI-compatible set (proxyable, key-poolable) while resolving to no base URL
// until its deployment names one. Asserted as a RELATION over the shared table rather than a
// re-pinned list, so adding a gateway extends the coverage instead of failing a count.
const OPERATOR_HOSTED = OPENAI_COMPATIBLE_PROVIDERS.filter(
  (provider) => !DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider],
)

describe('the OpenAI-compatible provider table', () => {
  it('carries both operator-hosted gateways, and they are exactly the endpoint-less ones', () => {
    expect(OPERATOR_HOSTED).toEqual(['bifrost', 'litellm'])
  })

  it('gives every other member a built-in base URL', () => {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      if (OPERATOR_HOSTED.includes(provider)) continue
      expect(resolveOpenAiCompatibleBaseUrl(provider, undefined)).toMatch(/^https:\/\//)
    }
  })

  it('resolves an operator-hosted gateway only from its deployment override', () => {
    for (const provider of OPERATOR_HOSTED) {
      expect(resolveOpenAiCompatibleBaseUrl(provider, undefined)).toBeUndefined()
      // A set-but-blank override must not read as "configured": it falls back to the
      // (absent) default rather than collapsing to an empty URL the SDK then chokes on.
      expect(resolveOpenAiCompatibleBaseUrl(provider, '  ')).toBeUndefined()
      expect(resolveOpenAiCompatibleBaseUrl(provider, 'https://gw.internal/v1')).toBe(
        'https://gw.internal/v1',
      )
    }
  })

  it('offers every member in the UI-configurable key pool, plus anthropic', () => {
    expect(UI_CONFIGURABLE_DIRECT_PROVIDERS).toEqual(
      [...OPENAI_COMPATIBLE_PROVIDERS, 'anthropic'].sort(),
    )
  })
})

describe('isOpenAiCompatibleProvider', () => {
  it('accepts every table member, endpoint-less gateways included', () => {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(isOpenAiCompatibleProvider(provider)).toBe(true)
    }
  })

  it('rejects the providers reached by their own SDK or binding', () => {
    expect(isOpenAiCompatibleProvider('anthropic')).toBe(false)
    expect(isOpenAiCompatibleProvider('workers-ai')).toBe(false)
    expect(isOpenAiCompatibleProvider('bedrock')).toBe(false)
  })

  it('does not treat Object.prototype keys as providers', () => {
    expect(isOpenAiCompatibleProvider('constructor')).toBe(false)
    expect(isOpenAiCompatibleProvider('toString')).toBe(false)
  })
})

describe('isProxyableProvider', () => {
  it('accepts workers-ai and every OpenAI-compatible provider, gateways included', () => {
    expect(isProxyableProvider('workers-ai')).toBe(true)
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(isProxyableProvider(provider)).toBe(true)
    }
  })

  it('accepts per-user local runners', () => {
    expect(isProxyableProvider('ollama')).toBe(true)
    expect(isProxyableProvider('lmstudio')).toBe(true)
  })

  it('rejects direct vendors the proxy never forwards (subscription harnesses)', () => {
    expect(isProxyableProvider('anthropic')).toBe(false)
    expect(isProxyableProvider('claude')).toBe(false)
    expect(isProxyableProvider('codex')).toBe(false)
  })

  it('does not treat Object.prototype keys as providers', () => {
    expect(isProxyableProvider('constructor')).toBe(false)
    expect(isProxyableProvider('toString')).toBe(false)
  })
})
