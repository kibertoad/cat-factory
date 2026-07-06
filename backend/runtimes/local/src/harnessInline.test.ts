import { describe, expect, it, vi } from 'vitest'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import { CliInlineLanguageModel, type InlineCliRequest } from '@cat-factory/agents'
import type { InlineContainerRequest } from './LocalContainerRunnerTransport.js'
import type { InlineJobResult } from './harnessHttp.js'
import {
  type CliExec,
  detectHostInlineClis,
  makeInlineHarnessPredicate,
  runnerForVendor,
  spawnCliExec,
  wrapResolverWithInlineHarness,
} from './harnessInline.js'

// Local-mode inline harness wiring: the shared predicate the config + provider agree on, and the
// resolver wrapper that serves an enabled subscription harness ref either via the developer's host
// CLI (native ambient vendor, binary present) or a warm container on a leased credential.

const CLAUDE_SUB: ModelRef = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  harness: 'claude-code',
}
const CODEX_SUB: ModelRef = { provider: 'openai', model: 'gpt-5.5-codex', harness: 'codex' }
const GLM_SUB: ModelRef = { provider: 'zai', model: 'glm-5.2', harness: 'claude-code' }
const KIMI_SUB: ModelRef = { provider: 'moonshot', model: 'kimi-k2.6', harness: 'claude-code' }
const QWEN: ModelRef = { provider: 'qwen', model: 'qwen3-max' }

describe('makeInlineHarnessPredicate', () => {
  it('accepts every subscription vendor whose harness is enabled (host CLI OR container)', () => {
    const predicate = makeInlineHarnessPredicate(['claude-code', 'codex'])
    expect(predicate(CLAUDE_SUB)).toBe(true)
    expect(predicate(CODEX_SUB)).toBe(true)
    // Non-native claude-code vendors now qualify too — the container serves them on a leased token.
    expect(predicate(GLM_SUB)).toBe(true)
    expect(predicate(KIMI_SUB)).toBe(true)
    expect(predicate(QWEN)).toBe(false) // not a subscription ref
  })

  it('is empty (never inline) when no inline harnesses are enabled', () => {
    expect(makeInlineHarnessPredicate(undefined)(CLAUDE_SUB)).toBe(false)
    expect(makeInlineHarnessPredicate([])(GLM_SUB)).toBe(false)
  })

  it('only accepts a vendor whose HARNESS is enabled', () => {
    const predicate = makeInlineHarnessPredicate(['codex'])
    expect(predicate(CLAUDE_SUB)).toBe(false) // claude-code not enabled
    expect(predicate(GLM_SUB)).toBe(false) // claude-code not enabled
    expect(predicate(CODEX_SUB)).toBe(true)
  })
})

describe('detectHostInlineClis', () => {
  it('reports no native CLIs when PATH is empty', () => {
    expect(detectHostInlineClis({ PATH: '' }).size).toBe(0)
  })
})

describe('wrapResolverWithInlineHarness', () => {
  function innerResolver(inner: ModelProvider): ModelProviderResolver {
    return { forScope: async () => inner }
  }
  const delegated = { id: 'delegated' } as unknown as ReturnType<ModelProvider['resolve']>

  it('serves a native ambient vendor via the HOST CLI when its binary is present', async () => {
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const runInline = vi.fn()
    const wrap = wrapResolverWithInlineHarness({
      inlineHarnesses: ['claude-code'],
      hostCliVendors: new Set(['claude']),
      runInline,
    })
    const provider = await wrap(innerResolver(inner)).forScope({ workspaceId: 'ws' })
    expect(provider.resolve(CLAUDE_SUB)).toBeInstanceOf(CliInlineLanguageModel)
    expect(runInline).not.toHaveBeenCalled()
    // A non-subscription ref falls through to the inner provider.
    expect(provider.resolve(QWEN)).toBe(delegated)
  })

  it('serves via the CONTAINER on a leased personal credential when no host CLI is present', async () => {
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const runInline = vi.fn(
      async (req: InlineContainerRequest): Promise<InlineJobResult> => ({
        text: `ran ${req.model} via ${req.subscriptionBaseUrl ?? 'anthropic'}`,
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
    )
    const leasePersonalSubscriptionToken = vi.fn(async () => ({ secret: 'oat-token' }))
    const wrap = wrapResolverWithInlineHarness({
      inlineHarnesses: ['claude-code'],
      hostCliVendors: new Set(), // no host CLI → container path
      runInline,
      leasePersonalSubscriptionToken,
    })
    const provider = await wrap(innerResolver(inner)).forScope({
      workspaceId: 'ws',
      userId: 'usr_1',
      executionId: 'exec_1',
    })
    const model = provider.resolve(CLAUDE_SUB)
    expect(model).toBeInstanceOf(CliInlineLanguageModel)

    // Drive the runner: it leases the initiator's personal credential and dispatches to the container.
    const runner = (model as unknown as { run: (r: InlineCliRequest) => Promise<unknown> }).run
    const result = (await runner({
      model: 'claude-opus-4-8',
      system: 'sys',
      prompt: 'go',
    })) as { text: string }
    expect(leasePersonalSubscriptionToken).toHaveBeenCalledWith('exec_1', 'usr_1', 'claude')
    expect(runInline).toHaveBeenCalledOnce()
    expect(runInline.mock.calls[0]![0].subscriptionToken).toBe('oat-token')
    expect(result.text).toContain('claude-opus-4-8')
  })

  it('leases a POOLED token (workspace only) for a poolable vendor via the container', async () => {
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const runInline = vi.fn(
      async (_req: InlineContainerRequest): Promise<InlineJobResult> => ({ text: 'ok' }),
    )
    const leaseSubscriptionToken = vi.fn(async () => ({ secret: 'pool-token' }))
    const wrap = wrapResolverWithInlineHarness({
      inlineHarnesses: ['claude-code'],
      hostCliVendors: new Set(),
      runInline,
      leaseSubscriptionToken,
    })
    const provider = await wrap(innerResolver(inner)).forScope({ workspaceId: 'ws' })
    const model = provider.resolve(KIMI_SUB)
    const runner = (model as unknown as { run: (r: InlineCliRequest) => Promise<unknown> }).run
    await runner({ model: 'kimi-k2.6', system: '', prompt: 'go' })
    expect(leaseSubscriptionToken).toHaveBeenCalledWith('ws', 'kimi')
    // The vendor base URL rides the container job so the harness points ANTHROPIC_BASE_URL there.
    expect(runInline.mock.calls[0]![0].subscriptionBaseUrl).toBe(
      'https://api.moonshot.ai/anthropic',
    )
  })

  it("throws for an individual vendor with no run context (can't lease a per-run activation)", async () => {
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const wrap = wrapResolverWithInlineHarness({
      inlineHarnesses: ['claude-code'],
      hostCliVendors: new Set(),
      runInline: vi.fn(),
      leasePersonalSubscriptionToken: vi.fn(),
    })
    const provider = await wrap(innerResolver(inner)).forScope({ workspaceId: 'ws' })
    const runner = (
      provider.resolve(CLAUDE_SUB) as unknown as {
        run: (r: InlineCliRequest) => Promise<unknown>
      }
    ).run
    await expect(runner({ model: 'claude-opus-4-8', system: '', prompt: 'go' })).rejects.toThrow(
      /signed-in user and an active run/,
    )
  })

  it('is a passthrough when no inline harnesses are enabled', async () => {
    const inner: ModelProvider = { resolve: vi.fn(() => delegated) }
    const wrap = wrapResolverWithInlineHarness({ inlineHarnesses: [], hostCliVendors: new Set() })
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
