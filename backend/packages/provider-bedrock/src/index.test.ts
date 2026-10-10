import { describe, expect, it } from 'vitest'
import { bedrockResolver, unsupportedBedrockModelMessage } from './index.js'

describe('unsupportedBedrockModelMessage', () => {
  it('names BEDROCK_MODELS, echoes the allowed models, and links the docs', () => {
    const msg = unsupportedBedrockModelMessage('anthropic.claude-x', [
      'anthropic.claude-3-5-sonnet',
      'meta.llama3',
    ])
    expect(msg).toContain("Unsupported Bedrock model 'anthropic.claude-x'")
    expect(msg).toContain('BEDROCK_MODELS')
    expect(msg).toContain('anthropic.claude-3-5-sonnet, meta.llama3')
    expect(msg).toContain('backend/docs/model-support.md')
  })

  it('renders "(none)" when the allow-list is empty', () => {
    expect(unsupportedBedrockModelMessage('x', [])).toContain('(none)')
  })
})

describe('bedrockResolver', () => {
  it('throws the elaborated remedy for a model outside the allow-list', () => {
    const resolve = bedrockResolver({ supportedModels: ['allowed.model'] })
    expect(() => resolve({ provider: 'bedrock', model: 'blocked.model' } as never)).toThrow(
      /Unsupported Bedrock model 'blocked\.model'/,
    )
    expect(() => resolve({ provider: 'bedrock', model: 'blocked.model' } as never)).toThrow(
      /BEDROCK_MODELS/,
    )
  })
})
