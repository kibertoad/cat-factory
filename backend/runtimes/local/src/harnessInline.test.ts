import { describe, expect, it, vi } from 'vitest'
import type {
  InlineLlmCall,
  InlineObservabilityContext,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ModelScope,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/kernel'
import {
  CliInlineLanguageModel,
  type InlineCliRequest,
  vendorConcurrencyLimiterFromEnv,
} from '@cat-factory/agents'
import { wrapResolverWithTelemetry } from '@cat-factory/server'
import type { InlineContainerRequest } from './LocalContainerRunnerTransport.js'
import type { InlineJobResult } from './harnessHttp.js'
import {
  type CliExec,
  CliExecFailure,
  type CliExecFailureReason,
  type CliExecOptions,
  detectHostInlineClis,
  makeInlineHarnessPredicate,
  runnerForVendor,
  silenceClause,
  spawnCliExec,
  wrapResolverWithInlineHarness,
} from './harnessInline.js'

// Local-mode inline harness wiring: the shared predicate the config + provider agree on, and the
// resolver wrapper that serves an enabled subscription harness ref either via the developer's host
// CLI (native ambient vendor, binary present) or a warm container on a leased credential.

// Must stay in step with the `claude-opus` catalog entry's subscription ref: the predicate and
// the resolver wrapper resolve a vendor by looking the ref up in the real MODEL_CATALOG, so a
// stale model id here makes every assertion below fall through to the delegated provider.
const CLAUDE_SUB: ModelRef = {
  provider: 'anthropic',
  model: 'claude-opus-5',
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
      model: 'claude-opus-5',
      system: 'sys',
      prompt: 'go',
    })) as { text: string }
    expect(leasePersonalSubscriptionToken).toHaveBeenCalledWith('exec_1', 'usr_1', 'claude')
    expect(runInline).toHaveBeenCalledOnce()
    expect(runInline.mock.calls[0]![0].subscriptionToken).toBe('oat-token')
    expect(result.text).toContain('claude-opus-5')
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
    await expect(runner({ model: 'claude-opus-5', system: '', prompt: 'go' })).rejects.toThrow(
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
    model: 'claude-opus-5',
    system: 'You are a reviewer.',
    prompt: 'Review it.',
  }
  /**
   * Deliver a canned stdout exactly as {@link spawnCliExec} would: line-by-line to an `onLine`
   * observer (resolving with no body), or as the buffered body when there is none. A fake that
   * just returned the string would let the streaming path go untested through every runner test.
   */
  function deliverStdout(stdout: string, opts: CliExecOptions | undefined): string {
    if (!opts?.onLine) return stdout
    for (const line of stdout.split('\n')) opts.onLine(line)
    return ''
  }

  /** A fake CLI exec that records its invocation and delivers a canned stdout. */
  function fakeExec(stdout: string): {
    exec: CliExec
    calls: Array<{ command: string; args: string[]; stdin: string }>
  } {
    const calls: Array<{ command: string; args: string[]; stdin: string }> = []
    const exec: CliExec = async (command, args, stdin, opts) => {
      calls.push({ command, args, stdin })
      return deliverStdout(stdout, opts)
    }
    return { exec, calls }
  }

  /** A fake exec that streams `partial` and THEN dies — a killed run, as the runner sees it. */
  function dyingExec(partial: string, failure: CliExecFailure): CliExec {
    return async (_command, _args, _stdin, opts) => {
      deliverStdout(partial, opts)
      throw failure
    }
  }

  describe('claude', () => {
    /** One `stream-json` line. */
    function event(value: Record<string, unknown>): string {
      return JSON.stringify(value)
    }
    /** An assistant envelope: one CONTENT BLOCK of the call `id`, repeating that call's usage. */
    function envelope(id: string, usage: Record<string, number>): string {
      return event({ type: 'assistant', message: { id, model: 'claude-opus-5', usage } })
    }

    it('reads the terminal result event, flags/system + prompt over stdin, and splits usage by class', async () => {
      const { exec, calls } = fakeExec(
        [
          // Deliberately DIFFERENT from the terminal figure below, so this pins WHICH source the
          // success path reports: on a run that finished, the CLI's own cumulative account is
          // authoritative and the folded per-call sum (which exists for the killed case) must not
          // be substituted for it. Matching numbers here would let a swap pass unnoticed.
          envelope('msg_1', { input_tokens: 7, cache_read_input_tokens: 2, output_tokens: 1 }),
          event({
            type: 'result',
            subtype: 'success',
            result: 'REVIEW OK',
            usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
          }),
        ].join('\n'),
      )
      const result = await runnerForVendor('claude', exec)(req)
      expect(result.text).toBe('REVIEW OK')
      // The three input classes stay APART: this is the only place a local deployment's inline
      // steps are observable, and one summed count cannot say whether a run rode a warm cache
      // (~0.1x base input) or re-wrote it (1.25-2x).
      expect(result.usage).toEqual({
        inputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        outputTokens: 3,
      })
      expect(calls[0]!.command).toBe('claude')
      // `--verbose` is mandatory alongside `stream-json` in print mode; without it the CLI refuses
      // and the step fails before reaching the model.
      expect(calls[0]!.args).toEqual(
        expect.arrayContaining(['--output-format', 'stream-json', '--verbose']),
      )
      expect(calls[0]!.args).toContain('--append-system-prompt')
      expect(calls[0]!.args).toContain('You are a reviewer.')
      expect(calls[0]!.args).toContain('claude-opus-5')
      expect(calls[0]!.stdin).toBe('Review it.')
    })

    it('throws when claude reports an in-band error (is_error, exit 0) instead of returning the error text', async () => {
      const { exec } = fakeExec(
        event({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Credit balance too low',
        }),
      )
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(/Credit balance too low/)
    })

    it('throws on an error_* subtype even without is_error', async () => {
      const { exec } = fakeExec(event({ type: 'result', subtype: 'error_max_turns', result: '' }))
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(/error_max_turns/)
    })

    it('falls back to raw stdout when the stream carries no terminal result event', async () => {
      const { exec } = fakeExec('plain text answer')
      const result = await runnerForVendor('claude', exec)(req)
      expect(result.text).toBe('plain text answer')
    })

    // The point of streaming rather than taking the one-shot `json` object: a killed run has no
    // terminal event, so without the partial stream it could report nothing about what it spent —
    // and nothing else records it either (a failed step writes no `token_usage` row).
    it('reports what a TIMED-OUT run had already burned, from its partial stream', async () => {
      const partial = [
        envelope('msg_1', {
          input_tokens: 100,
          cache_read_input_tokens: 900_000,
          cache_creation_input_tokens: 50_000,
          output_tokens: 4_000,
        }),
        envelope('msg_2', { input_tokens: 40, cache_read_input_tokens: 500_000 }),
      ].join('\n')
      const exec = dyingExec(
        partial,
        new CliExecFailure('claude timed out after 300000ms; silent for 69s', 'timeout'),
      )
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(
        /timed out after 300000ms; silent for 69s; burned 1\.45M tokens \(1\.40M cache-read\) across 2 model calls/,
      )
    })

    // A killed run's last line is cut wherever the writer happened to be. The fold must drop it and
    // still report everything that arrived whole — the alternative (one unparseable line poisoning
    // the count) would strike exactly the runs this exists for.
    it('survives a final line cut mid-JSON, keeping the calls that arrived whole', async () => {
      const partial = [
        envelope('msg_1', { input_tokens: 1_000, output_tokens: 500 }),
        '{"type":"assistant","message":{"id":"msg_2","usa', // killed mid-write
      ].join('\n')
      const exec = dyingExec(partial, new CliExecFailure('claude aborted', 'aborted'))
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(
        /burned 1\.5k tokens \(0 cache-read\) across 1 model call$/,
      )
    })

    // An envelope whose usage is absent, zeroed or garbled is not evidence that a call completed,
    // so it must not inflate the count into "burned 0 tokens across N model calls" — a sentence
    // that contradicts the `no model call completed` branch below.
    it('does not count an envelope that reported no usable usage as a model call', async () => {
      const partial = [
        event({ type: 'assistant', message: { id: 'msg_1', usage: {} } }),
        event({ type: 'assistant', message: { id: 'msg_2', usage: { input_tokens: 0 } } }),
      ].join('\n')
      const exec = dyingExec(partial, new CliExecFailure('claude aborted', 'aborted'))
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(
        /claude aborted; no model call completed$/,
      )
    })

    // Envelopes are per CONTENT BLOCK, each repeating the SAME call's usage, so summing them
    // multiplies the burn — the trap that made the container harness's metering untrustworthy
    // (575 rows for ~230 real calls). Fold by `message.id` first.
    it('counts a multi-block response ONCE rather than once per envelope', async () => {
      const usage = { input_tokens: 1_000, output_tokens: 2_000 }
      // Six envelopes, one call: text plus five parallel tool_use blocks.
      const partial = [
        envelope('msg_same', usage),
        envelope('msg_same', usage),
        envelope('msg_same', usage),
        envelope('msg_same', usage),
        envelope('msg_same', usage),
        envelope('msg_same', usage),
      ].join('\n')
      const exec = dyingExec(partial, new CliExecFailure('claude aborted', 'aborted'))
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(
        /burned 3\.0k tokens \(0 cache-read\) across 1 model call$/,
      )
    })

    it('says no model call completed when the run died before the model answered', async () => {
      const exec = dyingExec(
        '',
        new CliExecFailure('claude timed out after 300000ms; no output at all in 300s', 'timeout'),
      )
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(
        /no output at all in 300s; no model call completed$/,
      )
    })

    // The enriched throw stays a CliExecFailure so `reason` is readable on the error a caller
    // actually catches — not only one link down the chain — while the un-enriched original rides
    // as `cause`.
    it('keeps the failure TYPE and reason through enrichment, with the original as cause', async () => {
      const original = new CliExecFailure('claude timed out after 300000ms', 'timeout')
      const exec = dyingExec('', original)
      const thrown = await runnerForVendor(
        'claude',
        exec,
      )(req).then(
        () => null,
        (err: unknown) => err,
      )
      expect(thrown).toBeInstanceOf(CliExecFailure)
      expect((thrown as CliExecFailure).reason).toBe('timeout')
      expect((thrown as CliExecFailure).cause).toBe(original)
    })

    it('passes a non-CliExecFailure through untouched (a spawn ENOENT is not a burn story)', async () => {
      const exec: CliExec = async () => {
        throw new Error('spawn claude ENOENT')
      }
      await expect(runnerForVendor('claude', exec)(req)).rejects.toThrow(/^spawn claude ENOENT$/)
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

  // `claude -p` reports an API refusal (quota, rate limit, auth) on STDOUT and leaves stderr EMPTY,
  // so a stderr-only failure message carried the exit code and nothing else — the same defect the
  // container harness's `streamCli` had.
  const runFailing = (body: string): Promise<string> =>
    spawnCliExec(process.execPath, ['-e', body], '', { timeoutMs: 30_000 })

  it('carries the stdout report when the CLI failed with an empty stderr', async () => {
    await expect(
      runFailing(
        'process.stdout.write(JSON.stringify({is_error:true,result:"usage limit reached"}));process.exit(1)',
      ),
    ).rejects.toThrow(/exited with code 1: .*usage limit reached/)
  })

  it('prefers stderr when that is where the CLI spoke', async () => {
    await expect(
      runFailing(
        'process.stderr.write("not usable here");process.stdout.write("{}");process.exit(2)',
      ),
    ).rejects.toThrow(/exited with code 2: not usable here/)
  })

  it('names an empty failure as empty rather than trailing off after a colon', async () => {
    await expect(runFailing('process.exit(3)')).rejects.toThrow(/exited with code 3: \(no output\)/)
  })

  it('names the signal instead of rendering "code null" when something killed the CLI', async () => {
    await expect(runFailing('process.kill(process.pid, "SIGKILL")')).rejects.toThrow(
      /killed by SIGKILL/,
    )
  })

  // Both streams are command output on a path whose stdout holds the model's own text, so the
  // failure message is scrubbed at this emit site — the sibling in the container harness redacts
  // its stderr tail for the same reason.
  it('scrubs a credential out of the output it carries onto the failure', async () => {
    const message = await runFailing(
      'process.stdout.write("auth failed for ghp_0123456789abcdefghijklmnopqrstuvwxyz");process.exit(1)',
    ).then(
      () => '(resolved)',
      (err: Error) => err.message,
    )
    expect(message).not.toMatch(/ghp_0123456789/)
    expect(message).toMatch(/auth failed for/)
  })

  /** The structured kill reason a caller switches on, off whatever the run rejected with. */
  const reasonOf = (failure: unknown): CliExecFailureReason | undefined =>
    failure instanceof CliExecFailure ? failure.reason : undefined

  /** Run `body` and hand back whatever it rejected with. */
  const failureFrom = (body: string, timeoutMs: number): Promise<unknown> =>
    spawnCliExec(process.execPath, ['-e', body], '', { timeoutMs }).then(
      () => null,
      (err: unknown) => err,
    )

  /** Run `body` once, streaming its stdout to an observer; hand back the lines and the outcome. */
  const streamFrom = async (
    body: string,
    timeoutMs: number,
  ): Promise<{ lines: string[]; failure: unknown; resolved: string | null }> => {
    const lines: string[] = []
    const outcome = await spawnCliExec(process.execPath, ['-e', body], '', {
      timeoutMs,
      onLine: (line) => lines.push(line),
    }).then(
      (out) => ({ resolved: out as string | null, failure: null as unknown }),
      (err: unknown) => ({ resolved: null as string | null, failure: err }),
    )
    return { lines, ...outcome }
  }

  // The watchdog path is the one that used to throw the partial output away, so the run that spent a
  // whole poll budget and the run that never started read identically. The evidence now reaches the
  // OBSERVER rather than riding on the error, which is what keeps the stream out of memory.
  it('streams a TIMED-OUT run its partial output before rejecting as a CliExecFailure', async () => {
    const { lines, failure } = await streamFrom(
      'process.stdout.write("partial event\\n");setInterval(() => {}, 1000)',
      300,
    )
    expect(lines).toContain('partial event')
    expect(failure).toBeInstanceOf(CliExecFailure)
    expect(reasonOf(failure)).toBe('timeout')
    expect((failure as CliExecFailure).message).toMatch(/timed out after 300ms/)
  })

  it('tags a bad exit as `exit` and still reports its output', async () => {
    const { lines, failure } = await streamFrom(
      'process.stdout.write("boom");process.exit(4)',
      30_000,
    )
    // No trailing newline: the last line is flushed on close, or a clean run's terminal `result`
    // event — the very thing the success path reads — would be dropped.
    expect(lines).toContain('boom')
    expect(reasonOf(failure)).toBe('exit')
    expect((failure as CliExecFailure).message).toMatch(/boom/)
  })

  it('reassembles a line split across chunk boundaries and resolves with no body', async () => {
    const { lines, resolved } = await streamFrom(
      'process.stdout.write("{\\"a\\":1}\\n{\\"b\\":");' +
        'setTimeout(() => process.stdout.write("2}\\n"), 20)',
      30_000,
    )
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    // Streaming and buffering are mutually exclusive: an observer means no retained body, which is
    // the whole point — `stream-json` output is unbounded where the one-shot object never was.
    expect(resolved).toBe('')
  })

  // A multi-byte character split across a chunk boundary decodes to replacement characters when
  // each Buffer is stringified alone, and these lines are handed to `JSON.parse` — one unlucky
  // boundary would silently drop an event, and its usage, from the fold.
  it('decodes a multi-byte character split across chunk boundaries', async () => {
    const { lines } = await streamFrom(
      'process.stdout.write(Buffer.from("{\\"t\\":\\""));' +
        'process.stdout.write(Buffer.from([0xe2]));' +
        'setTimeout(() => {' +
        '  process.stdout.write(Buffer.from([0x82, 0xac]));' +
        '  process.stdout.write("\\"}\\n");' +
        '}, 20)',
      30_000,
    )
    expect(lines).toEqual(['{"t":"€"}'])
  })

  // A fast failure must NOT gain a silence clause (the threshold's whole purpose), which is also
  // what keeps every message asserted above unchanged.
  it('leaves a fast failure free of a silence clause', async () => {
    const failure = await failureFrom('process.exit(5)', 30_000)
    expect((failure as CliExecFailure).message).not.toMatch(/silent|no output at all/)
  })
})

describe('silenceClause', () => {
  const start = 1_000_000

  it('stays empty below the reporting threshold', () => {
    expect(silenceClause(start, undefined, start + 29_000)).toBe('')
    expect(silenceClause(start, start + 1_000, start + 20_000)).toBe('')
  })

  it('separates a run that went quiet from one that never spoke at all', () => {
    // Measured from the LAST output, not the start: this run talked, then stalled for 69s.
    expect(silenceClause(start, start + 10_000, start + 79_000)).toBe('silent for 69s')
    // Nothing ever arrived, so the window is the whole run — the wedge-before-first-token case.
    expect(silenceClause(start, undefined, start + 300_000)).toBe('no output at all in 300s')
  })
})

describe('inline call telemetry across the local subscription wrap', () => {
  // The BEHAVIOURAL half of the order guard, and the only place a substituting wrap really
  // exists: this wrap answers a subscription harness ref with its OWN `CliInlineLanguageModel`
  // instead of delegating downwards, so it is invisible to anything wrapped BENEATH it. The
  // inline `llm_call_metrics` feeder shipped underneath — inside
  // `createScopedModelProviderResolver` — and the consequence was silent and selective: on the
  // default local shape (`LOCAL_NATIVE_INLINE`) every inline step on a host `claude`/`codex`
  // login recorded zero calls, while the same step on a metered API model recorded fine. Nothing
  // in the type system holds the fix, so the order lives in ONE composer
  // (`wrapResolverWithTelemetry`, whose structural assertions are in
  // `server/src/agents/modelProviderResolver.test.ts`) and this suite drives a real call through
  // it.
  type GenerateOptions = Parameters<CliInlineLanguageModel['doGenerate']>[0]
  type Generatable = Pick<CliInlineLanguageModel, 'doGenerate'>

  const RESULT_LINE = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'RESEARCH BRIEF',
    usage: {
      input_tokens: 11,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 7,
      output_tokens: 5,
    },
  })

  /** A host `claude` that streams one terminal `result` event, exactly as spawnCliExec would. */
  const exec: CliExec = async (_command, _args, _stdin, opts) => {
    if (!opts?.onLine) return RESULT_LINE
    opts.onLine(RESULT_LINE)
    return ''
  }

  /**
   * Compose exactly as `buildNodeModelDeps` does — this wrap first, then the telemetry composer
   * on top of it. Going through `wrapResolverWithTelemetry` rather than applying the
   * instrumentation by hand is deliberate: it is the same seam production uses, so this suite
   * fails if that composer's internal order is ever inverted.
   */
  function compose(recorded: InlineLlmCall[], cliExec: CliExec): ModelProviderResolver {
    const base: ModelProviderResolver = {
      forScope: async () => ({
        resolve: () => {
          throw new Error('the base provider must not be reached for a subscription harness ref')
        },
      }),
    }
    return wrapResolverWithTelemetry(
      wrapResolverWithInlineHarness({
        inlineHarnesses: ['claude-code'],
        hostCliVendors: new Set(['claude']),
        exec: cliExec,
      })(base),
      {
        instrument: {
          recordCall: (call) => {
            recorded.push(call)
            return Promise.resolve()
          },
          recordPrompts: true,
          workspaceBodiesEnabled: () => Promise.resolve(true),
        },
        // Capped, as a stock deployment's is: the limiter must sit OUTSIDE the instrumentation,
        // so a substituted subscription call passes through both.
        limiter: vendorConcurrencyLimiterFromEnv(() => undefined),
      },
    )
  }

  /** Resolve the subscription ref through the composition and drive one generation. */
  async function generate(
    resolver: ModelProviderResolver,
    scope: ModelScope,
    tag?: InlineObservabilityContext,
  ): Promise<void> {
    const provider = await resolver.forScope(scope)
    const model = provider.resolve(CLAUDE_SUB) as unknown as Generatable
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'research it' }] }],
      ...(tag ? { providerOptions: catFactoryObservability(tag) } : {}),
    } as GenerateOptions)
  }

  it('records a call the wrap SUBSTITUTED, with the three input classes kept apart', async () => {
    const recorded: InlineLlmCall[] = []
    await generate(
      compose(recorded, exec),
      { workspaceId: 'ws_1', executionId: 'ex_1' },
      {
        agentKind: 'doc-researcher',
        workspaceId: 'ws_1',
        executionId: 'ex_1',
      },
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'ex_1',
      agentKind: 'doc-researcher',
      // A cache-heavy subscription run is the norm here, and summing these would read as a loop
      // that keeps invalidating its prefix rather than one riding a warm cache.
      promptTokens: 11,
      cacheReadTokens: 400,
      cacheWriteTokens: 7,
      completionTokens: 5,
      ok: true,
    })
  })

  it('attributes an untagged call to the run its credential SCOPE names', async () => {
    // Most inline callers tag only the workspace, so without the scope fallback these rows land
    // with a null execution id: present in the store, absent from every run-scoped read.
    const recorded: InlineLlmCall[] = []
    await generate(
      compose(recorded, exec),
      { workspaceId: 'ws_1', executionId: 'ex_run' },
      {
        agentKind: 'doc-interviewer',
        workspaceId: 'ws_1',
      },
    )
    expect(recorded[0]?.executionId).toBe('ex_run')
  })

  it('records a FAILED substituted call rather than losing the run that needs explaining', async () => {
    const recorded: InlineLlmCall[] = []
    const dying: CliExec = async () => {
      throw new CliExecFailure('claude timed out after 300000ms', 'timeout')
    }
    const resolver = compose(recorded, dying)
    await expect(
      generate(
        resolver,
        { workspaceId: 'ws_1', executionId: 'ex_2' },
        { agentKind: 'doc-researcher', workspaceId: 'ws_1' },
      ),
    ).rejects.toThrow(/timed out/)
    // This is the run from #1521 — a killed host `claude` whose four attempts spent 1.47M
    // tokens. Its spend now lands in `token_usage`; this pins that the CALL lands too, since a
    // run that died is the one an operator actually goes looking for.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ ok: false, executionId: 'ex_2' })
    expect(recorded[0]?.errorMessage).toMatch(/timed out/)
  })
})
