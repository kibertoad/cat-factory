import { describe, expect, it } from 'vitest'
import { openAiCompatibleBaseUrlError } from '../src/agents/providerErrors.js'

describe('openAiCompatibleBaseUrlError', () => {
  it('gives litellm a dedicated remedy naming LITELLM_BASE_URL', () => {
    const msg = openAiCompatibleBaseUrlError('litellm')
    expect(msg).toContain('LiteLLM')
    expect(msg).toContain('LITELLM_BASE_URL')
    expect(msg).toContain('operator-hosted gateway')
    expect(msg).toContain('docs/environment-variables.md')
  })

  it('names the ${PROVIDER}_BASE_URL var + key pool for a generic OpenAI-compatible provider', () => {
    const msg = openAiCompatibleBaseUrlError('qwen')
    expect(msg).toContain("Provider 'qwen'")
    expect(msg).toContain('QWEN_BASE_URL')
    expect(msg).toContain('AI provider key pool')
    expect(msg).toContain('backend/docs/model-support.md')
  })
})
