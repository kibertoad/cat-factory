import type { ModelFamilyPolicy } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { familyForModelId, isAllowedByFamilyPolicy } from './models.js'

describe('familyForModelId', () => {
  it('maps catalog ids to their declared family', () => {
    expect(familyForModelId('deepseek')).toBe('deepseek')
    expect(familyForModelId('deepseek-v4-pro')).toBe('deepseek')
    expect(familyForModelId('qwen')).toBe('qwen')
    expect(familyForModelId('kimi')).toBe('kimi')
    expect(familyForModelId('kimi-k2.7')).toBe('kimi')
    expect(familyForModelId('glm')).toBe('glm')
    expect(familyForModelId('claude-opus')).toBe('claude')
    expect(familyForModelId('claude-sonnet')).toBe('claude')
    expect(familyForModelId('gpt-5.5')).toBe('openai')
    expect(familyForModelId('gemini')).toBe('gemini')
    expect(familyForModelId('cloudflare-llama')).toBe('llama')
  })

  it('leaves the gateway entry (LiteLLM) unclassified', () => {
    expect(familyForModelId('litellm-default')).toBeNull()
  })

  it('derives the family of a dynamic OpenRouter id from its slug vendor prefix', () => {
    expect(familyForModelId('openrouter:deepseek/deepseek-chat')).toBe('deepseek')
    expect(familyForModelId('openrouter:moonshotai/kimi-k2.7-code')).toBe('kimi')
    expect(familyForModelId('openrouter:anthropic/claude-opus-4.8')).toBe('claude')
    expect(familyForModelId('openrouter:openai/gpt-5.5')).toBe('openai')
    expect(familyForModelId('openrouter:google/gemini-3-pro')).toBe('gemini')
    expect(familyForModelId('openrouter:z-ai/glm-5.2')).toBe('glm')
    expect(familyForModelId('openrouter:meta-llama/llama-4')).toBe('llama')
  })

  it('returns null for an unrecognised OpenRouter vendor, a local runner id, and unknown/empty ids', () => {
    expect(familyForModelId('openrouter:somevendor/whatever')).toBeNull()
    expect(familyForModelId('ollama:qwen2.5-coder:32b')).toBeNull()
    expect(familyForModelId('not-a-real-model')).toBeNull()
    expect(familyForModelId(undefined)).toBeNull()
    expect(familyForModelId(null)).toBeNull()
  })
})

describe('isAllowedByFamilyPolicy', () => {
  const block = (families: string[], trusted: string[] = []): ModelFamilyPolicy => ({
    mode: 'blocklist',
    families: families as ModelFamilyPolicy['families'],
    trustedProviders: trusted,
  })
  const allow = (families: string[], trusted: string[] = []): ModelFamilyPolicy => ({
    mode: 'allowlist',
    families: families as ModelFamilyPolicy['families'],
    trustedProviders: trusted,
  })

  it('allows everything when the policy is absent or off', () => {
    expect(isAllowedByFamilyPolicy('deepseek', 'workers-ai', undefined)).toBe(true)
    expect(
      isAllowedByFamilyPolicy('deepseek', 'workers-ai', {
        mode: 'off',
        families: [],
        trustedProviders: [],
      }),
    ).toBe(true)
  })

  describe('blocklist', () => {
    it('blocks a listed family on an untrusted route and allows an unlisted one', () => {
      const policy = block(['deepseek', 'qwen'])
      expect(isAllowedByFamilyPolicy('deepseek', 'deepseek', policy)).toBe(false)
      expect(isAllowedByFamilyPolicy('qwen', 'workers-ai', policy)).toBe(false)
      expect(isAllowedByFamilyPolicy('claude-opus', 'anthropic', policy)).toBe(true)
    })

    it('exempts a blocked family when its effective route is a trusted provider', () => {
      const policy = block(['deepseek'], ['bedrock'])
      expect(isAllowedByFamilyPolicy('deepseek', 'deepseek', policy)).toBe(false)
      expect(isAllowedByFamilyPolicy('deepseek', 'bedrock', policy)).toBe(true)
    })

    it('allows an unclassified family (nothing to match)', () => {
      expect(isAllowedByFamilyPolicy('litellm-default', 'litellm', block(['deepseek']))).toBe(true)
    })
  })

  describe('allowlist', () => {
    it('allows a listed family and blocks an unlisted one', () => {
      const policy = allow(['claude', 'openai'])
      expect(isAllowedByFamilyPolicy('claude-opus', 'anthropic', policy)).toBe(true)
      expect(isAllowedByFamilyPolicy('gpt-5.5', 'openai', policy)).toBe(true)
      expect(isAllowedByFamilyPolicy('deepseek', 'deepseek', policy)).toBe(false)
    })

    it('blocks an unclassified family (cannot prove membership) unless its route is trusted', () => {
      expect(isAllowedByFamilyPolicy('litellm-default', 'litellm', allow(['claude']))).toBe(false)
      expect(isAllowedByFamilyPolicy('litellm-default', 'bedrock', allow(['claude'], ['bedrock']))).toBe(
        true,
      )
    })

    it('admits any family reached over a trusted route (the residency-guaranteed-only stance)', () => {
      const policy = allow([], ['bedrock'])
      expect(isAllowedByFamilyPolicy('deepseek', 'bedrock', policy)).toBe(true)
      expect(isAllowedByFamilyPolicy('deepseek', 'deepseek', policy)).toBe(false)
    })
  })
})
