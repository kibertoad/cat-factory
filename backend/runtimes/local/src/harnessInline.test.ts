import { describe, expect, it, vi } from 'vitest'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import type { InlineCliRequest } from '@cat-factory/agents'
import { CliInlineLanguageModel } from '@cat-factory/agents'
import {
  type CliExec,
  makeInlineHarnessPredicate,
  runnerForVendor,
  spawnCliExec,
  wrapResolverWithInlineHarness,
} from './harnessInline.js'

// Local-mode inline harness wiring: the shared predicate the config + provider agree on, and the
// resolver wrapper that serves ambient-eligible harness refs via the CLI while delegating the rest.

const CLAUDE_SUB: ModelRef = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  harness: 'claude-code',
}
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

describe('runnerForVendor', () => {
  const req: InlineCliRequest = {
    model: 'claude-opus-4-8',
    system: 'You are a reviewer.',
    prompt: 'Review it.',
  }
  /** A fake CLI exec that records its invocation and returns a canned stdout. */
  function fakeExec(stdout: string): {
    exec: CliExec
    calls: Array<{ command: string; args: string[]; stdin: string }>
  } {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = []
    const exec: CliExec = async (command, args, stdin) => {
      calls.push({ command, args, stdin })
      return stdout
    }
    return { exec, calls }
  }

  describe('claude', () => {
    it('parses the JSON result, flags/system + prompt over stdin, and sums usage', async () => {
      const { exec, calls } = fakeExec(
        JSON.stringify({
          subtype: 'success',
          result: 'REVIEW OK',
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
        }),
      )
      const result = await runnerForVendor('claude', exec)(req)
      expect(result.text).toBe('REVIEW OK')
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 3 })
      expect(calls[0]!.command).toBe('claude')
      expect(calls[0]!.args).toContain('--append-system-prompt')
      expect(calls[0]!.args).toContain('You are a reviewer.')
      expect(calls[0]!.args).toContain('claude-opus-4-8')
      expect(calls[0]!.stdin).toBe('Review it.')
    })

    it('throws when claude reports an in-band error (is_error, exit 0) instead of returning the error text', async () => {
      const { exec } = fakeExec(
        JSON.stringify({
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Credit balance too low',
        }),
      )
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(/Credit balance too low/)
    })

    it('throws on an error_* subtype even without is_error', async () => {
      const { exec } = fakeExec(JSON.stringify({ subtype: 'error_max_turns', result: '' }))
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(/error_max_turns/)
    })

    it('falls back to raw stdout when the output is not JSON', async () => {
      const { exec } = fakeExec('plain text answer')
      const result = await runnerForVendor('claude', exec)(req)
      expect(result.text).toBe('plain text answer')
    })
  })

  describe('codex', () => {
    it('prepends the system prompt to the user prompt over stdin and trims stdout', async () => {
      const { exec, calls } = fakeExec('  CODEX ANSWER  ')
      const result = await runnerForVendor('codex', exec)(req)
      expect(result.text).toBe('CODEX ANSWER')
      expect(calls[0]!.command).toBe('codex')
      expect(calls[0]!.stdin).toBe('You are a reviewer.\n\n---\n\nReview it.')
    })
  })
})

describe('spawnCliExec', () => {
  it('spawns the CLI with the sanitized env (no orchestrator secrets in the agent process)', async () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://secret'
    try {
      // A real spawn of `node` printing its env — the CLI seam's env contract, end to end.
      const stdout = await spawnCliExec(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        '',
        { timeoutMs: 30_000 },
      )
      const childEnv = JSON.parse(stdout) as Record<string, string>
      expect(childEnv.DATABASE_URL).toBeUndefined()
      expect(childEnv.PATH ?? childEnv.Path).toBeDefined()
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = original
    }
  })
})
