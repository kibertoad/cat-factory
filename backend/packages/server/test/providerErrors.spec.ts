import { OPERATOR_HOSTED_GATEWAYS } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { openAiCompatibleBaseUrlError } from '../src/agents/providerErrors.js'

describe('openAiCompatibleBaseUrlError', () => {
  it('has an operator-hosted gateway to assert about', () => {
    // The floor for the `it.each` below, which is generated from a DERIVED list: were the
    // `=== null` filter behind it ever broken (a table gaining a `''` placeholder instead of a
    // null, say), `it.each([])` would register no cases at all and the suite would report green
    // having asserted nothing about the remedy this file exists for.
    expect(OPERATOR_HOSTED_GATEWAYS.length).toBeGreaterThan(0)
  })

  // Asserted over the shared set rather than one named gateway: the remedy's whole job is to name
  // the ONE env var an operator has to set, so a gateway that reaches the generic branch (which
  // says "the provider's OpenAI-compatible endpoint" about software they host themselves) is the
  // bug. Iterating means a new gateway is covered the day it is added.
  it.each(OPERATOR_HOSTED_GATEWAYS)(
    'gives the operator-hosted %s gateway a remedy naming its own base-URL var',
    (provider) => {
      const msg = openAiCompatibleBaseUrlError(provider)
      expect(msg).toContain(`${provider.toUpperCase()}_BASE_URL`)
      expect(msg).toContain('operator-hosted gateway')
      expect(msg).toContain('docs/environment-variables.md')
      expect(msg).not.toContain(`Provider '${provider}'`)
    },
  )

  it('spells each gateway by its product name, not its provider id', () => {
    expect(openAiCompatibleBaseUrlError('bifrost')).toContain('Bifrost')
    expect(openAiCompatibleBaseUrlError('litellm')).toContain('LiteLLM')
  })

  it('names the ${PROVIDER}_BASE_URL var + key pool for a generic OpenAI-compatible provider', () => {
    const msg = openAiCompatibleBaseUrlError('qwen')
    expect(msg).toContain("Provider 'qwen'")
    expect(msg).toContain('QWEN_BASE_URL')
    expect(msg).toContain('AI provider key pool')
    expect(msg).toContain('backend/docs/model-support.md')
  })
})
