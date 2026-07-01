import { describe, expect, it, vi } from 'vitest'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { CliInlineLanguageModel } from '@cat-factory/agents'
import { makeInlineHarnessPredicate, wrapResolverWithInlineHarness } from './harnessInline.js'

// Local-mode inline harness wiring: the shared predicate the config + provider agree on, and the
// resolver wrapper that serves ambient-eligible harness refs via the CLI while delegating the rest.

const CLAUDE_SUB: ModelRef = { provider: 'anthropic', model: 'claude-opus-4-8', harness: 'claude-code' }
const CODEX_SUB: ModelRef = { provider: 'openai', model: 'gpt-5.5-codex', harness: 'codex' }
const GLM_SUB: ModelRef = { provider: 'zai', model: 'glm-5.2', harness: 'claude-code' }
const QWEN: ModelRef = { provider: 'qwen', model: 'qwen3-max' }

describe('makeInlineHarnessPredicate', () => {
  it('accepts native ambient vendors listed in the allow-list, rejects the rest', () => {
    const predicate = makeInlineHarnessPredicate(['claude-code', 'codex'])
    expect(predicate(CLAUDE_SUB)).toBe(true)
    expect(predicate(CODEX_SUB)).toBe(true)
    expect(predicate(GLM_SUB)).toBe(false) // non-native (has a base URL)
    expect(predicate(QWEN)).toBe(false) // not a harness ref
  })

  it('is empty (never inline) when no native harnesses are enabled', () => {
    const predicate = makeInlineHarnessPredicate(undefined)
    expect(predicate(CLAUDE_SUB)).toBe(false)
  })

  it('only accepts a vendor whose harness is in the allow-list', () => {
    const predicate = makeInlineHarnessPredicate(['codex'])
    expect(predicate(CLAUDE_SUB)).toBe(false) // claude-code not allowed
    expect(predicate(CODEX_SUB)).toBe(true)
  })
})

describe('wrapResolverWithInlineHarness', () => {
  function innerResolver(inner: ModelProvider): ModelProviderResolver {
    return { forScope: async () => inner }
  }

  it('serves an ambient-eligible harness ref via the CLI model, delegating everything else', async () => {
    const delegated = { id: 'delegated' } as unknown as ReturnType<ModelProvider['resolve']>
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const wrap = wrapResolverWithInlineHarness(['claude-code'])
    const provider = await wrap(innerResolver(inner)).forScope({ workspaceId: 'ws' })

    expect(provider.resolve(CLAUDE_SUB)).toBeInstanceOf(CliInlineLanguageModel)
    expect(inner.resolve).not.toHaveBeenCalled()

    // A non-native ref falls through to the inner provider.
    expect(provider.resolve(QWEN)).toBe(delegated)
    expect(inner.resolve).toHaveBeenCalledWith(QWEN)
  })

  it('is a passthrough when no native harnesses are enabled', async () => {
    const delegated = { id: 'delegated' } as unknown as ReturnType<ModelProvider['resolve']>
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const wrap = wrapResolverWithInlineHarness([])
    const provider = await wrap(innerResolver(inner)).forScope({ workspaceId: 'ws' })
    expect(provider.resolve(CLAUDE_SUB)).toBe(delegated)
  })
})
