import { describe, expect, it } from 'vitest'
import {
  inlineModelRef,
  isModelUsableInline,
  nativeVendorForRef,
  type ModelRef,
  type ProviderCapabilities,
} from '@cat-factory/kernel'

// The pure inline-model-resolution logic that decides whether an inline LLM step can run a
// given model: a subscription harness ref runs inline only where the deployment can drive the
// harness (local ambient), otherwise it degrades to a provider fallback. Exercised here (agents
// has the vitest runner; kernel does not) since these functions gate the requirements reviewer +
// the preset satisfiability guard.

const CLAUDE_SUB: ModelRef = { provider: 'anthropic', model: 'claude-opus-4-8', harness: 'claude-code' }
const GLM_SUB: ModelRef = { provider: 'zai', model: 'glm-5.2', harness: 'claude-code' }
const CODEX_SUB: ModelRef = { provider: 'openai', model: 'gpt-5.5-codex', harness: 'codex' }
const QWEN_DIRECT: ModelRef = { provider: 'qwen', model: 'qwen3-max' }

describe('nativeVendorForRef', () => {
  it('maps only the native ambient vendors (claude / codex)', () => {
    expect(nativeVendorForRef(CLAUDE_SUB)).toBe('claude')
    expect(nativeVendorForRef(CODEX_SUB)).toBe('codex')
  })

  it('excludes a non-native claude-code vendor (GLM/Kimi/DeepSeek reuse the harness with a base URL)', () => {
    expect(nativeVendorForRef(GLM_SUB)).toBeUndefined()
  })

  it('is undefined for a plain (non-harness / pi) ref', () => {
    expect(nativeVendorForRef(QWEN_DIRECT)).toBeUndefined()
    expect(nativeVendorForRef({ ...QWEN_DIRECT, harness: 'pi' })).toBeUndefined()
  })
})

describe('inlineModelRef', () => {
  const fallback = QWEN_DIRECT
  it('degrades a subscription harness ref when no inline-harness support', () => {
    expect(inlineModelRef(CLAUDE_SUB, fallback)).toBe(fallback)
  })

  it('keeps the harness ref when the deployment runs it inline', () => {
    const kept = inlineModelRef(CLAUDE_SUB, fallback, { runsInline: () => true })
    expect(kept).toBe(CLAUDE_SUB)
  })

  it('passes a plain ref through unchanged regardless of the predicate', () => {
    expect(inlineModelRef(QWEN_DIRECT, fallback, { runsInline: () => true })).toBe(QWEN_DIRECT)
  })
})

describe('isModelUsableInline', () => {
  // Caps where the Claude subscription is connected (so the model is CONTAINER-usable) but no
  // direct key / Cloudflare is configured — the exact state that stranded the inline reviewer.
  const subOnlyCaps: ProviderCapabilities = {
    directProviders: new Set(),
    subscriptionVendors: new Set(['claude']),
    cloudflareEnabled: false,
  }

  it('is false for a subscription-only model with no inline-harness support', () => {
    expect(isModelUsableInline('claude-opus', subOnlyCaps)).toBe(false)
  })

  it('is true for the same model when the deployment runs the harness inline (local ambient)', () => {
    const runsInline = (ref: ModelRef): boolean => nativeVendorForRef(ref) === 'claude'
    expect(isModelUsableInline('claude-opus', subOnlyCaps, runsInline)).toBe(true)
  })

  it('is true for a model with a usable non-subscription flavour (Cloudflare on)', () => {
    const cfCaps: ProviderCapabilities = {
      directProviders: new Set(),
      subscriptionVendors: new Set(),
      cloudflareEnabled: true,
    }
    // qwen resolves to its Cloudflare flavour — a real inline provider.
    expect(isModelUsableInline('qwen', cfCaps)).toBe(true)
  })

  it('is false for a model with no usable flavour at all', () => {
    const noneCaps: ProviderCapabilities = {
      directProviders: new Set(),
      subscriptionVendors: new Set(),
      cloudflareEnabled: false,
    }
    expect(isModelUsableInline('qwen', noneCaps)).toBe(false)
  })
})
