import { describe, expect, it } from 'vitest'
import { isProxyableProvider } from './endpoints.js'

describe('isProxyableProvider', () => {
  it('accepts workers-ai and every built-in OpenAI-compatible direct provider', () => {
    for (const provider of ['workers-ai', 'qwen', 'deepseek', 'moonshot', 'openai', 'openrouter']) {
      expect(isProxyableProvider(provider)).toBe(true)
    }
  })

  it('accepts the operator-hosted litellm gateway', () => {
    expect(isProxyableProvider('litellm')).toBe(true)
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
