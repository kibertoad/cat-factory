import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseInlineJob } from '../src/job.js'
import { handleInline } from '../src/inline.js'

// parseInlineJob is a pure validator (runs anywhere); handleInline drives the REAL
// runSubscriptionHarness against a FAKE `claude` binary on PATH (Unix-only, like
// agent-runner.test.ts) so the whole one-shot inline path — the throwaway cwd, the CLI
// stream, and the finishReason/usage lift — is asserted end to end.
const unix = process.platform !== 'win32'

describe('parseInlineJob', () => {
  it('accepts a claude-code inline job with a subscription token', () => {
    const job = parseInlineJob({
      jobId: 'j1',
      harness: 'claude-code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are a reviewer.',
      userPrompt: 'Review it.',
      subscriptionToken: 'sk-ant-oat01-x',
      subscriptionBaseUrl: 'https://api.z.ai/api/anthropic',
    })
    expect(job.harness).toBe('claude-code')
    expect(job.subscriptionToken).toBe('sk-ant-oat01-x')
    expect(job.subscriptionBaseUrl).toBe('https://api.z.ai/api/anthropic')
    expect(job.userPrompt).toBe('Review it.')
  })

  it('accepts an ambient job without a token, and a codex job', () => {
    expect(
      parseInlineJob({
        jobId: 'j',
        harness: 'claude-code',
        model: 'm',
        userPrompt: 'p',
        ambientAuth: true,
      }).ambientAuth,
    ).toBe(true)
    expect(
      parseInlineJob({
        jobId: 'j',
        harness: 'codex',
        model: 'm',
        userPrompt: 'p',
        subscriptionToken: 't',
      }).harness,
    ).toBe('codex')
  })

  it('rejects a non-subscription harness and a missing user prompt', () => {
    expect(() =>
      parseInlineJob({ jobId: 'j', harness: 'pi', model: 'm', userPrompt: 'p' }),
    ).toThrow(/must be 'claude-code' or 'codex'/)
    expect(() =>
      parseInlineJob({ jobId: 'j', harness: 'claude-code', model: 'm', subscriptionToken: 't' }),
    ).toThrow(/userPrompt/)
  })

  it('requires a subscription token when not ambient', () => {
    expect(() =>
      parseInlineJob({ jobId: 'j', harness: 'claude-code', model: 'm', userPrompt: 'p' }),
    ).toThrow(/subscriptionToken/)
  })
})

describe.skipIf(!unix)('handleInline', () => {
  let binDir: string
  let priorPath: string | undefined

  function fakeCli(name: string, lines: string[]): void {
    const script = `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\nconst out = ${JSON.stringify(lines.join('\n') + '\n')}\nprocess.stdout.write(out, () => process.exit(0))\n`
    writeFileSync(join(binDir, name), script, { mode: 0o755 })
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'cf-fakebin-'))
    priorPath = process.env.PATH
    process.env.PATH = `${binDir}:${priorPath ?? ''}`
  })
  afterEach(() => {
    process.env.PATH = priorPath
    rmSync(binDir, { recursive: true, force: true })
  })

  it('returns the reply text + usage, and maps a max_tokens stop to finishReason length', async () => {
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'max_tokens',
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
          content: [{ type: 'text', text: 'REVIEW OK' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'REVIEW OK',
        usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
      }),
    ])
    const result = await handleInline(
      {
        jobId: 'j1',
        harness: 'claude-code',
        model: 'claude-opus-4-8',
        systemPrompt: 'You are a reviewer.',
        userPrompt: 'Review it.',
        subscriptionToken: 'sk-ant-oat01-x',
      },
      {},
    )
    expect(result.text).toBe('REVIEW OK')
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 20 })
    expect(result.finishReason).toBe('length')
    expect(result.callMetrics?.length).toBeGreaterThan(0)
  })

  it('defaults finishReason to stop for a normal completion', async () => {
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: 'done' }],
        },
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ])
    const result = await handleInline(
      {
        jobId: 'j2',
        harness: 'claude-code',
        model: 'claude-opus-4-8',
        systemPrompt: '',
        userPrompt: 'go',
        subscriptionToken: 't',
      },
      {},
    )
    expect(result.text).toBe('done')
    expect(result.finishReason).toBe('stop')
  })
})
