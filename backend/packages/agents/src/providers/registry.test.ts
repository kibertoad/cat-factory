import type { ModelRef } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { UI_CONFIGURABLE_DIRECT_PROVIDERS } from './endpoints.js'
import { CompositeModelProvider, unsupportedModelProviderMessage } from './registry.js'

const ref = (provider: string): ModelRef => ({ provider, model: 'x' }) as ModelRef

describe('unsupportedModelProviderMessage', () => {
  it('names the provider, the UI key pool, the deployment-level alternative, and the docs', () => {
    const msg = unsupportedModelProviderMessage('qwen', ['workers-ai', 'anthropic'])
    expect(msg).toContain("Unsupported model provider 'qwen'")
    expect(msg).toContain('AI provider key pool')
    expect(msg).toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(msg).toContain('BEDROCK_REGION')
    expect(msg).toContain('backend/docs/model-support.md')
  })

  it('lists the currently registered providers as a sorted diagnostic', () => {
    expect(unsupportedModelProviderMessage('x', ['workers-ai', 'anthropic'])).toContain(
      'Currently registered providers: anthropic, workers-ai',
    )
  })

  it('reports "none" when nothing is registered', () => {
    expect(unsupportedModelProviderMessage('x', [])).toContain(
      'Currently registered providers: none',
    )
  })

  it('names the UI-configurable providers from the shared source of truth (no drift)', () => {
    const msg = unsupportedModelProviderMessage('x', [])
    // Derived from UI_CONFIGURABLE_DIRECT_PROVIDERS so adding a vendor keeps the remedy in step.
    expect(msg).toContain(
      `UI-configurable provider (${UI_CONFIGURABLE_DIRECT_PROVIDERS.join(', ')})`,
    )
    for (const p of ['openai', 'anthropic', 'litellm', 'openrouter']) {
      expect(UI_CONFIGURABLE_DIRECT_PROVIDERS).toContain(p)
    }
  })
})

describe('CompositeModelProvider.resolve', () => {
  it('throws the elaborated remedy for an unregistered provider', () => {
    const provider = new CompositeModelProvider({ workersai: () => ({}) as never })
    expect(() => provider.resolve(ref('litellm'))).toThrow(/Unsupported model provider 'litellm'/)
    expect(() => provider.resolve(ref('litellm'))).toThrow(/AI provider key pool/)
  })

  it('resolves a registered provider without throwing', () => {
    const model = {} as never
    const provider = new CompositeModelProvider({ openai: () => model })
    expect(provider.resolve(ref('openai'))).toBe(model)
  })
})
