import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryClaudeSystemPrompt, runClaudeCode, runCodex } from '../src/agent-runner.js'

// These drive the REAL `runClaudeCode` / `runCodex` against a FAKE `claude` / `codex`
// binary placed on PATH — the whole path (streamCli + the per-call accumulator) runs, so
// the telemetry (`callMetrics`) extraction is asserted end-to-end. The fakes emit canned
// JSONL mirroring each CLI's `stream-json` / `exec --json` shape. Unix-only (the fake is a
// chmod-+x shebang script; Windows lacks that + the acceptance suite already skips there).
const unix = process.platform !== 'win32'

let binDir: string
let cwd: string
let priorPath: string | undefined

/** Write an executable fake CLI that prints `lines` (LF-framed) to stdout and exits 0. */
function fakeCli(name: string, lines: string[]): void {
  const script = `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\nconst out = ${JSON.stringify(lines.join('\n') + '\n')}\nprocess.stdout.write(out, () => process.exit(0))\n`
  const path = join(binDir, name)
  writeFileSync(path, script, { mode: 0o755 })
}

/**
 * A fake CLI that records its argv + the stdin it received into `argv.json` / `stdin.txt`
 * under its cwd, then emits one `result` line. Lets a test assert HOW the harness passed the
 * system prompt (argv vs folded into stdin) without depending on the real `claude` binary.
 */
function recordingCli(name: string): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
let input = ''
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)))
  fs.writeFileSync(path.join(process.cwd(), 'stdin.txt'), input)
  const line = JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } })
  process.stdout.write(line + '\\n', () => process.exit(0))
})
`
  writeFileSync(join(binDir, name), script, { mode: 0o755 })
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'cf-fakebin-'))
  cwd = mkdtempSync(join(tmpdir(), 'cf-work-'))
  priorPath = process.env.PATH
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${priorPath ?? ''}`
})

afterEach(() => {
  process.env.PATH = priorPath
  rmSync(binDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('carryClaudeSystemPrompt', () => {
  it('keeps a normal system prompt on --append-system-prompt', () => {
    const { appendArgs, prompt, folded } = carryClaudeSystemPrompt('ROLE', 'TASK')
    expect(appendArgs).toEqual(['--append-system-prompt', 'ROLE'])
    expect(prompt).toBe('TASK')
    expect(folded).toBe(false)
  })

  it('folds an argv-overflowing system prompt into the stdin prompt', () => {
    // > the 96 KiB argv-string budget (and the 128 KiB Linux MAX_ARG_STRLEN that caused E2BIG).
    const big = 'X'.repeat(200 * 1024)
    const { appendArgs, prompt, folded } = carryClaudeSystemPrompt(big, 'TASK')
    expect(appendArgs).toEqual([])
    expect(prompt.startsWith(big)).toBe(true)
    expect(prompt.endsWith('TASK')).toBe(true)
    expect(folded).toBe(true)
  })
})

describe.skipIf(!unix)('runClaudeCode system-prompt carriage', () => {
  it('passes a normal system prompt on argv and only the task over stdin', async () => {
    recordingCli('claude')
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'ROLE',
      userPrompt: 'TASK',
      ambientAuth: true,
    })
    expect(outcome.summary).toBe('ok')
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).toContain('--append-system-prompt')
    expect(argv).toContain('ROLE')
    expect(readFileSync(join(cwd, 'stdin.txt'), 'utf8')).toBe('TASK')
  })

  it('does not E2BIG on a huge system prompt: folds it into stdin, off argv', async () => {
    recordingCli('claude')
    // Larger than Linux MAX_ARG_STRLEN (128 KiB) — before the fix, spawning with this on
    // argv fails the whole run with `spawn E2BIG` (the pr-reviewer failure this reproduces).
    const big = 'S'.repeat(200 * 1024)
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: big,
      userPrompt: 'TASK',
      ambientAuth: true,
    })
    expect(outcome.summary).toBe('ok')
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')) as string[]
    expect(argv).not.toContain('--append-system-prompt')
    const stdin = readFileSync(join(cwd, 'stdin.txt'), 'utf8')
    expect(stdin.startsWith(big)).toBe(true)
    expect(stdin).toContain('TASK')
  })
})

describe.skipIf(!unix)('runClaudeCode telemetry', () => {
  it('lifts full per-call bodies, per-turn tokens, model and finish reason', async () => {
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
          content: [
            { type: 'text', text: 'Reading the repo' },
            { type: 'tool_use', name: 'Bash', input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 30 },
          content: [{ type: 'text', text: 'Done' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'Final summary',
        usage: { input_tokens: 300, output_tokens: 50 },
      }),
    ])

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    expect(outcome.summary).toBe('Final summary')
    // Cumulative usage (rotation path) comes from the terminal `result` event.
    expect(outcome.usage).toEqual({ inputTokens: 300, outputTokens: 50 })

    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(2)

    // First call: prompt is the seeded [system, user]; tokens fold cache into input.
    expect(calls[0]!.model).toBe('claude-opus-4-8')
    expect(calls[0]!.responseText).toBe('Reading the repo')
    expect(calls[0]!.inputTokens).toBe(150)
    expect(calls[0]!.cachedInputTokens).toBe(50)
    expect(calls[0]!.outputTokens).toBe(20)
    expect(calls[0]!.finishReason).toBe('tool_use')
    expect(calls[0]!.messageCount).toBe(2)
    expect(JSON.parse(calls[0]!.promptText).map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
    ])

    // Second call: the transcript grew by the prior assistant turn + the tool_result.
    expect(calls[1]!.responseText).toBe('Done')
    expect(calls[1]!.inputTokens).toBe(200)
    expect(calls[1]!.outputTokens).toBe(30)
    expect(calls[1]!.finishReason).toBe('end_turn')
    expect(calls[1]!.messageCount).toBe(4)
    expect(JSON.parse(calls[1]!.promptText).map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
  })

  it('scrubs the leased credential from captured bodies', async () => {
    const token = 'sk-ant-oat01-super-secret-value'
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: `leaked ${token} here` }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ])

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      subscriptionToken: token,
    })

    const call = (outcome.callMetrics ?? [])[0]!
    expect(call.responseText).not.toContain(token)
  })
})

describe.skipIf(!unix)('runCodex telemetry', () => {
  it('records one call per token_count using the per-turn usage + latest text', async () => {
    fakeCli('codex', [
      JSON.stringify({ type: 'item.completed', item: { text: 'Working on it' } }),
      JSON.stringify({
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 },
        },
      }),
      JSON.stringify({ type: 'agent_message', message: 'Final answer' }),
      JSON.stringify({
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 300, cached_input_tokens: 10, output_tokens: 60 },
          last_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 40 },
        },
      }),
    ])

    const outcome = await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    expect(outcome.summary).toBe('Final answer')
    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(2)

    expect(calls[0]!.model).toBe('gpt-5.5-codex')
    expect(calls[0]!.responseText).toBe('Working on it')
    // Codex `input_tokens` is the total prompt count and already includes the cached
    // share, so it is recorded as-is (100), with cached surfaced separately (10).
    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.cachedInputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(20)
    expect(calls[0]!.messageCount).toBe(1)

    expect(calls[1]!.responseText).toBe('Final answer')
    expect(calls[1]!.inputTokens).toBe(200)
    expect(calls[1]!.outputTokens).toBe(40)
    // The prior assistant turn was appended, so the transcript grew by one.
    expect(calls[1]!.messageCount).toBe(2)
  })

  it("does not let a command item's text clobber the assistant response", async () => {
    fakeCli('codex', [
      JSON.stringify({
        type: 'item.completed',
        item: { item_type: 'agent_message', text: 'The real answer' },
      }),
      // A command-execution item also carries a `text` field (its stdout); it must NOT
      // become the turn's recorded responseText.
      JSON.stringify({
        type: 'item.completed',
        item: { item_type: 'command_execution', text: 'total 8\ndrwxr-xr-x' },
      }),
      JSON.stringify({
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
        },
      }),
    ])

    const outcome = await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]!.responseText).toBe('The real answer')
    expect(outcome.summary).toBe('The real answer')
  })

  it('falls back to a single call from the cumulative total when no per-turn usage is emitted', async () => {
    fakeCli('codex', [
      JSON.stringify({ type: 'agent_message', message: 'All done' }),
      JSON.stringify({
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 80 },
        },
      }),
    ])

    const outcome = await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]!.responseText).toBe('All done')
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.outputTokens).toBe(80)
  })
})
