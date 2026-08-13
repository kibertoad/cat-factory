import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryClaudeSystemPrompt, runClaudeCode, runCodex } from '../src/agent-runner.js'
import type { HarnessCallMetric } from '../src/pi.js'

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
 * Like {@link fakeCli} but ends badly: it prints `lines` to stdout, optionally something on
 * stderr, and exits with `code`. Models the failure this file's `runClaudeCode failure
 * reporting` block is about — a CLI whose only account of what went wrong is on STDOUT.
 */
function failingCli(name: string, lines: string[], code: number, stderr = ''): void {
  const out = JSON.stringify(lines.length ? lines.join('\n') + '\n' : '')
  const script = `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\nif (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)})\nprocess.stdout.write(${out}, () => process.exit(${code}))\n`
  writeFileSync(join(binDir, name), script, { mode: 0o755 })
}

/**
 * A fake `codex` that copies its `CODEX_HOME/config.toml` into its cwd before exiting, then emits
 * one usable event. That copy is the only way to see the file the harness wrote: the per-run
 * `CODEX_HOME` is a temp dir removed in `finally`, deliberately, so the leased credential does not
 * outlive the run — which means the assertion has to be taken from INSIDE the run.
 */
function codexHomeRecordingCli(): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME
  const config = home ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : ''
  fs.writeFileSync(path.join(process.cwd(), 'config.toml.copy'), config)
  const line = JSON.stringify({ type: 'agent_message', message: 'done' })
  process.stdout.write(line + '\\n', () => process.exit(0))
})
`
  writeFileSync(join(binDir, 'codex'), script, { mode: 0o755 })
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

// The subagent-dispatch stream fixture, hoisted to module scope when the one long `describe` was
// split into siblings so both still see it.
const subagentDispatchStream = (): string[] => [
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'Agent', input: {} }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: 'toolu_01',
    message: {
      id: 'msg_sub',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 19_430, output_tokens: 400 },
      content: [{ type: 'text', text: 'slice findings' }],
    },
  }),
  JSON.stringify({
    type: 'user',
    parent_tool_use_id: 'toolu_01',
    message: { content: [{ type: 'tool_result', content: 'subagent tool output' }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'the Agent result' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_2',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 20 },
      content: [{ type: 'text', text: 'aggregated' }],
    },
  }),
  JSON.stringify({
    type: 'result',
    result: 'done',
    usage: { input_tokens: 300, output_tokens: 30 },
  }),
]

describe.skipIf(!unix)('runClaudeCode telemetry — per-call folding', () => {
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

    // First call: prompt is the seeded [system, user]. Anthropic reports the three input
    // classes separately and `input_tokens` is already exclusive of both, so they map across
    // unchanged rather than being folded into one count.
    expect(calls[0]!.model).toBe('claude-opus-4-8')
    expect(calls[0]!.responseText).toBe('Reading the repo')
    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.cacheReadTokens).toBe(50)
    expect(calls[0]!.cacheWriteTokens).toBe(0)
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

  it('counts a block-split response as ONE call, not one per content block', async () => {
    // The CLI emits one envelope per content block, each repeating that response's usage.
    // Recording per envelope is what turned ~230 real calls into 575 rows and 16.3M input
    // tokens into 39.4M on the measured pr-review run.
    const usage = { input_tokens: 40, cache_read_input_tokens: 49_621, output_tokens: 5 }
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          usage,
          content: [{ type: 'text', text: 'Planning' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          usage,
          content: [{ type: 'tool_use', name: 'TaskCreate', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          usage: { ...usage, output_tokens: 316 },
          content: [{ type: 'tool_use', name: 'TaskCreate', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 49_661, output_tokens: 316 },
      }),
    ])

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(1)
    // Counted ONCE, and with the input side kept in its three orthogonal classes: this turn is
    // 99.9% cache reads, which a single summed count could not have told apart from 49,661
    // fresh tokens.
    expect(calls[0]!.inputTokens).toBe(40)
    expect(calls[0]!.cacheReadTokens).toBe(49_621)
    expect(calls[0]!.cacheWriteTokens).toBe(0)
    // The final block carries the real output count; the earlier ones carry a partial.
    expect(calls[0]!.outputTokens).toBe(316)
    expect(calls[0]!.finishReason).toBe('tool_use')
    expect(calls[0]!.responseText).toBe('Planning')
    // Three tool calls in one turn is still ONE turn on the reconstructed transcript, followed
    // by its results — the shape the model was actually sent.
    expect(JSON.parse(calls[0]!.promptText).map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
    ])
    expect(outcome.stats.toolCalls).toBe(2)
  })

  /** A parent turn that dispatches a subagent, the subagent's own tagged turns, then the join. */
})

describe.skipIf(!unix)('runClaudeCode telemetry — subagents and the live stream', () => {
  it('never splices a subagent’s turns into the PARENT’s prompt chain', async () => {
    // Subagent turns ride the parent's stdout tagged with the dispatch that spawned them. Folding
    // them into the parent's reconstruction produced a `promptText` interleaving two conversations
    // — a request that was never sent — whichever channel ends up billing them.
    fakeCli('claude', subagentDispatchStream())

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    const parent = calls.filter((c) => c.promptText.includes('SYS'))
    expect(parent.map((c) => c.inputTokens)).toEqual([100, 200])
    // The parent's chain holds its own dispatch and the Agent's result, never the subagent's
    // internal turns.
    expect(JSON.parse(parent[1]!.promptText).map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    expect(parent[1]!.promptText).toContain('the Agent result')
    expect(parent[1]!.promptText).not.toContain('subagent tool output')
  })

  it('records a subagent’s tokens off the parent stream when no transcript watcher will run', async () => {
    // `startSubagentWatcher` is wired only when the CLI has an isolated config home to watch, which
    // an `ambientAuth` run has none of. Filtering the tagged turns out unconditionally would leave
    // this run's subagent spend recorded by NEITHER channel — an under-count reads as a cheap run,
    // which is strictly worse than the double count the filter removes.
    fakeCli('claude', subagentDispatchStream())

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    const subagent = calls.filter((c) => !c.promptText.includes('SYS'))
    expect(subagent.map((c) => c.inputTokens)).toEqual([19_430])
    // On its OWN chain: seeded empty, because the CLI minted that prompt and it never crossed
    // this stream.
    expect(subagent[0]!.messageCount).toBe(0)
    expect(subagent[0]!.responseText).toBe('slice findings')
  })

  it('reconciles the terminal total against the PARENT loop alone, never a subagent turn', async () => {
    // Both halves of one bug, in the mode that has them: `ambientAuth` has no transcript watcher, so
    // the CLI's tagged subagent turns are captured through the parent's own publisher. The terminal
    // `result` cumulative covers the parent conversation ONLY — so counting a subagent's 400 output
    // tokens as already accounted hid most of the parent's real shortfall, and what survived was
    // pinned onto the last captured call, which by flush order IS the subagent's turn.
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          usage: { input_tokens: 100, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'toolu_01', name: 'Agent', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_01',
        message: {
          id: 'msg_sub',
          usage: { input_tokens: 19_430, output_tokens: 400 },
          content: [{ type: 'text', text: 'slice findings' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'the Agent result' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_2',
          usage: { input_tokens: 200, output_tokens: 5 },
          content: [{ type: 'text', text: 'aggregated' }],
        },
      }),
      // The parent loop's own cumulative: its input reconciles, its output does not.
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 300, output_tokens: 9_000 },
      }),
    ])

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    // The subagent's turn keeps its own 400: it is a measured number from its own conversation.
    const subagent = calls.find((c) => c.responseText === 'slice findings')
    expect(subagent?.outputTokens).toBe(400)
    // The parent's whole shortfall (9,000 − 5 − 5) lands on the job-level row, and on nothing else.
    const remainder = calls.filter((c) => c.standsForJob)
    expect(remainder.map((c) => [c.inputTokens, c.outputTokens])).toEqual([[0, 8_990]])
  })

  it('counts a subagent’s work in the run stats whichever channel bills it', async () => {
    // `stats` answers "did the agent ACT at all" (`agentNeverActed`), which is true of a
    // subagent's turns however their telemetry rows are attributed. Riding the ownership split
    // would make an identical run report different activity on two deployments.
    fakeCli('claude', subagentDispatchStream())

    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

    // The parent's `Agent` dispatch is the only tool_use; 'slice findings' + 'aggregated' is the
    // assistant text, and the subagent's half of it is counted.
    expect(outcome.stats.toolCalls).toBe(1)
    expect(outcome.stats.assistantChars).toBe('slice findings'.length + 'aggregated'.length)
  })

  it('streams every costed call live, with the same objects the terminal list carries', async () => {
    // The point of the live channel: a run killed mid-flight never returns a result, so
    // telemetry batched to the end reports nothing for a run that spent real tokens.
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: 'text', text: 'first' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 30 },
          content: [{ type: 'text', text: 'second' }],
        },
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ])
    const streamed: HarnessCallMetric[] = []
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      onCallMetric: (call) => streamed.push(call),
    })

    expect(streamed.map((c) => c.responseText)).toEqual(['first', 'second'])
    // The SAME instances, not copies: the job registry stamps `seq` on the object it is handed,
    // and the terminal list must carry that stamp so both channels mint one row id per call.
    expect(streamed[0]).toBe(outcome.callMetrics?.[0])
    expect(streamed[1]).toBe(outcome.callMetrics?.[1])
  })

  it('files a run whose CLI costed no turn at all as one job-level row', async () => {
    // A CLI/version that reports only a cumulative total leaves every turn at zero tokens. Those
    // turns are streamed as the zero-token rows they honestly are, and the whole total arrives as
    // ONE row standing for the job — which for such a run is the only spend record there is.
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'uncosted' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 300, output_tokens: 50 },
      }),
    ])
    const asPublished: Array<{ text: string; inputTokens: number; outputTokens: number }> = []
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      onCallMetric: (call) => {
        asPublished.push({
          text: call.responseText,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        })
      },
    })

    expect(asPublished).toEqual([
      { text: 'uncosted', inputTokens: 0, outputTokens: 0 },
      { text: '', inputTokens: 300, outputTokens: 50 },
    ])
    // Every published object is on the terminal list too, so both channels mint one row id each.
    expect(outcome.callMetrics?.map((c) => c.standsForJob)).toEqual([undefined, true])
  })

  it('recovers the OUTPUT side when the stream costed every turn at the message-start snapshot', async () => {
    // The shape Claude Code actually emits: each `assistant` envelope carries the usage as of
    // message_start, so the input and cache counts are final and `output_tokens` is the handful
    // of tokens produced when the message opened. Because every turn was "costed", the old
    // all-or-nothing fallback stood down and the run's real output was never recorded at all
    // (measured: a `coder` step at 198 output tokens against a true 14,033). The turns must keep
    // their own numbers and the shortfall must land, WITHOUT double-counting the input side that
    // already added up.
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          usage: { input_tokens: 2, cache_read_input_tokens: 998, output_tokens: 4 },
          content: [{ type: 'text', text: 'first' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_2',
          usage: { input_tokens: 2, cache_read_input_tokens: 4_998, output_tokens: 5 },
          content: [{ type: 'text', text: 'second' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        // Every billed input bucket summed (2+998+2+4998), and the TRUE output total.
        usage: { input_tokens: 4, cache_read_input_tokens: 5_996, output_tokens: 9_000 },
      }),
    ])
    const asPublished: Array<{ text: string; inputTokens: number; outputTokens: number }> = []
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      onCallMetric: (call) => {
        asPublished.push({
          text: call.responseText,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
        })
      },
    })

    // Both turns keep exactly what the CLI reported them at; the input side already reconciled, so
    // the extra row carries the 8,991 output tokens no turn accounted for and nothing else.
    expect(asPublished).toEqual([
      { text: 'first', inputTokens: 2, outputTokens: 4 },
      { text: 'second', inputTokens: 2, outputTokens: 5 },
      { text: '', inputTokens: 0, outputTokens: 8_991 },
    ])
    // What the live channel published IS what the terminal list holds, and the last row says it
    // stands for the job rather than for a turn (the backend files it with a null turn index).
    expect(outcome.callMetrics?.map((c) => c.outputTokens)).toEqual([4, 5, 8_991])
    expect(outcome.callMetrics?.map((c) => c.standsForJob)).toEqual([undefined, undefined, true])
    expect(outcome.callMetrics?.reduce((n, c) => n + c.outputTokens, 0)).toBe(9_000)
  })

  it('seeds telemetry as a single folded user turn (no phantom system) when the prompt overflows argv', async () => {
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: 'Done' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        result: 'ok',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ])

    // Overflows the 96 KiB argv budget, so the system prompt is folded into the stdin user
    // turn — and the telemetry must reflect that no system turn of ours was actually sent.
    const big = 'S'.repeat(200 * 1024)
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: big,
      userPrompt: 'TASK',
      ambientAuth: true,
    })

    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(1)
    // One folded user turn, not a [system, user] pair — the reconstruction matches the wire.
    expect(calls[0]!.messageCount).toBe(1)
    const seeded = JSON.parse(calls[0]!.promptText) as Array<{ role: string; content: string }>
    expect(seeded.map((m) => m.role)).toEqual(['user'])
    expect(seeded[0]!.content.startsWith(big)).toBe(true)
    expect(seeded[0]!.content.endsWith('TASK')).toBe(true)
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

describe.skipIf(!unix)('runClaudeCode subagent observability (D2.1/D3)', () => {
  // A fake `claude` that (1) writes a subagent transcript at the REAL location the CLI uses —
  // `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl` (ADR 0027
  // Defect A; the old `$CLAUDE_CONFIG_DIR/subagents` this fake used to write never exists) —
  // exactly as the real CLI does for a `Task`-parallelised review, and (2) emits a parent
  // stream that dispatches one `Task` subagent and returns. Lets the test assert that the
  // slice progress is derived from the parent stream AND the subagent's tokens (invisible on
  // the parent stream) are folded into the outcome.
  function fakeClaudeWithSubagent(): void {
    const parent = [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: 'text', text: 'Grouping the diff' },
            {
              type: 'tool_use',
              name: 'Task',
              id: 'task-1',
              input: { description: 'Review auth/session slice' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'done' }] },
      }),
      JSON.stringify({
        type: 'result',
        result: 'Reviewed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]
    const subagentLine = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 295 },
        content: [{ type: 'text', text: 'subagent findings' }],
      },
    })
    const script = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
const home = process.env.CLAUDE_CONFIG_DIR
if (home) {
  const sub = path.join(home, 'projects', '-tmp-agent-explore', 'session-uuid', 'subagents')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'a.jsonl'), ${JSON.stringify(subagentLine + '\n')})
}
process.stdin.resume(); process.stdin.on('data', () => {})
process.stdout.write(${JSON.stringify(parent.join('\n') + '\n')}, () => process.exit(0))
`
    writeFileSync(join(binDir, 'claude'), script, { mode: 0o755 })
  }

  it('derives slice progress from Task dispatches and folds in subagent token usage', async () => {
    fakeClaudeWithSubagent()
    const progresses: Array<{ completed: number; total: number }> = []
    const outcome = await runClaudeCode({
      cwd,
      model: 'claude-opus-4-8',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      subscriptionToken: 'sk-ant-oat01-tok',
      onProgress: (p) => progresses.push({ completed: p.completed, total: p.total }),
    })

    // Slice progress came off the parent stream's Task dispatch + its tool_result.
    expect(progresses.some((p) => p.total === 1 && p.completed === 0)).toBe(true)
    expect(progresses.some((p) => p.total === 1 && p.completed === 1)).toBe(true)

    // The subagent's 500/295 tokens (invisible on the parent stream) are summed into the
    // run's usage on top of the parent's 10/5.
    expect(outcome.usage).toEqual({ inputTokens: 510, outputTokens: 300 })
    // Its per-call telemetry is appended after the parent's call.
    const calls = outcome.callMetrics ?? []
    expect(calls).toHaveLength(2)
    expect(calls[1]!.outputTokens).toBe(295)
    expect(calls[1]!.responseText).toBe('subagent findings')
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
    // Codex `input_tokens` is the WHOLE prompt count and already includes the cached share
    // (OpenAI semantics), so the fresh figure is the difference: 100 - 10 = 90. Codex reports
    // no separate cache-write class.
    expect(calls[0]!.inputTokens).toBe(90)
    expect(calls[0]!.cacheReadTokens).toBe(10)
    expect(calls[0]!.cacheWriteTokens).toBe(0)
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

  it('writes the run’s tool servers into the per-run CODEX_HOME config.toml, beside the auth store', async () => {
    // End to end for the whole Codex MCP path: the job-body specs, the TOML writer, and the file
    // the CLI actually reads. Asserted from inside the run because the per-run home is wiped in
    // `finally` — the credential must not outlive the job.
    codexHomeRecordingCli()
    await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      subscriptionToken: JSON.stringify({ tokens: { access_token: 'tok-secret' } }),
      mcpServers: [
        {
          id: 'issues',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'issue-mcp'],
          env: { ISSUE_TOKEN: 'tok-abcdef' },
          secretKeys: ['ISSUE_TOKEN'],
        },
      ],
    })
    const config = readFileSync(join(cwd, 'config.toml.copy'), 'utf8')
    // The auth-store setting must survive the MCP addition: it is what makes the injected
    // auth.json usable at all, so a writer that replaced the file rather than appending to it
    // would fail the run for a reason no MCP test would notice.
    expect(config).toContain('cli_auth_credentials_store = "file"')
    expect(config).toContain('[mcp_servers.issues]')
    expect(config).toContain('command = "npx"')
    expect(config).toContain('args = ["-y", "issue-mcp"]')
    expect(config).toContain('env = { "ISSUE_TOKEN" = "tok-abcdef" }')
  })

  it('writes a config with no MCP tables when the job carries no tool servers', async () => {
    // Every built-in run: the file must be byte-for-byte what it was before tool servers existed.
    codexHomeRecordingCli()
    await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      subscriptionToken: JSON.stringify({ tokens: { access_token: 'tok-secret' } }),
    })
    expect(readFileSync(join(cwd, 'config.toml.copy'), 'utf8')).toBe(
      'cli_auth_credentials_store = "file"\n',
    )
  })

  it('writes NO tool servers under ambient auth, which has no per-run config home', async () => {
    // The harness will not write servers into the developer's own ~/.codex: they would outlive the
    // run and race a concurrent job. The backend drops them for this case at dispatch (so the
    // prompt states the gap); this asserts the harness never writes them even if a body carries some.
    codexHomeRecordingCli()
    await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      mcpServers: [{ id: 'issues', transport: 'stdio', command: 'npx' }],
    })
    // No CODEX_HOME ⇒ the fake had nothing to copy, and nothing was written anywhere.
    expect(readFileSync(join(cwd, 'config.toml.copy'), 'utf8')).toBe('')
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

// The failure this covers: a headless agent CLI reports an upstream refusal (quota, rate limit,
// a provider outage it retried out on) in its STDOUT event stream and exits non-zero with an
// EMPTY stderr. The harness used to surface `claude exited with code 1: ` — the exit code and
// nothing else — while the CLI's own explanation sat in a variable only the success path read.
describe.skipIf(!unix)('runClaudeCode failure reporting', () => {
  const run = (): Promise<unknown> =>
    runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
    })

  /**
   * The message the run failed with. Asserting on a captured string rather than through
   * `rejects.not.toThrow(pattern)`, whose reading is ambiguous — "rejected with something else"
   * and "did not reject" both satisfy it, so a negative assertion written that way can pass
   * for the wrong reason.
   */
  const failureMessage = (): Promise<string> =>
    run().then(
      () => '(resolved)',
      (err: Error) => err.message,
    )

  it("folds the CLI's terminal result into a bad exit that left nothing on stderr", async () => {
    failingCli(
      'claude',
      [
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Claude AI usage limit reached|1785302400',
        }),
      ],
      1,
    )
    await expect(run()).rejects.toThrow(/Claude AI usage limit reached\|1785302400/)
    await expect(run()).rejects.toThrow(/error_during_execution/)
    // The empty stderr is named as empty rather than trailing off after a colon.
    await expect(run()).rejects.toThrow(/\(no stderr output\)/)
  })

  it('keeps stderr as the message when that is where the CLI spoke', async () => {
    failingCli('claude', [], 1, 'claude: command not usable here\n')
    await expect(run()).rejects.toThrow(/command not usable here/)
  })

  it('names the signal instead of "code null" when something killed the CLI', async () => {
    const script = `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.kill(process.pid, 'SIGKILL')\n`
    writeFileSync(join(binDir, 'claude'), script, { mode: 0o755 })
    await expect(run()).rejects.toThrow(/killed by SIGKILL/)
  })

  it('reports a Codex bad exit with the last thing the agent said', async () => {
    failingCli('codex', [JSON.stringify({ type: 'agent_message', message: 'quota exhausted' })], 1)
    await expect(
      runCodex({
        cwd,
        model: 'gpt-5.5-codex',
        systemPrompt: 'SYS',
        userPrompt: 'USER',
        ambientAuth: true,
      }),
    ).rejects.toThrow(/quota exhausted/)
  })

  // The report is capped, and the cap keeps its HEAD — the opposite bias from the stderr tail
  // beside it. The failure `subtype` leads the report, so tail-slicing an over-long one would
  // drop exactly the classification the fold exists to surface.
  it('keeps the head of an over-long report, marked as cut, not its tail', async () => {
    failingCli(
      'claude',
      [
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: `upstream refused: ${'x'.repeat(2_000)} TAIL_MARKER`,
        }),
      ],
      1,
    )
    const message = await failureMessage()
    expect(message).toMatch(/error_during_execution: upstream refused/)
    expect(message).toMatch(/report truncated/)
    expect(message).not.toMatch(/TAIL_MARKER/)
  })

  it('scrubs a credential out of the report it folds in', async () => {
    failingCli(
      'claude',
      [
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'push rejected for ghp_0123456789abcdefghijklmnopqrstuvwxyz',
        }),
      ],
      1,
    )
    const message = await failureMessage()
    expect(message).not.toMatch(/ghp_0123456789/)
    expect(message).toMatch(/push rejected for/)
  })
})

// An abort is not always a watchdog. `JobRegistry.abortAll` fires one at every running job when
// something shuts the harness down, and a backend-requested stop fires one at a single job; only
// the signal's reason tells those apart, because a watchdog kill is relabelled downstream from
// the structured `killReason` and these two have no such label. The runner used to reject with a
// hard-coded "agent run aborted by watchdog", so a container killed mid-job (in the incident that
// prompted this: the agent pattern-killed the harness itself) filed its failure against a
// watchdog that never fired.
describe.skipIf(!unix)('what an aborted run reports', () => {
  /** A fake CLI that never finishes on its own, so only the abort can end the run. */
  function hangingCli(name: string): void {
    writeFileSync(
      join(binDir, name),
      '#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on("data", () => {})\n' +
        'setInterval(() => {}, 1000)\n',
      { mode: 0o755 },
    )
  }

  /** Start a hanging run, abort it with `reason` once it is up, and answer how it failed. */
  async function abortedMessage(reason?: Error): Promise<string> {
    hangingCli('claude')
    const controller = new AbortController()
    const run = runClaudeCode({
      cwd,
      model: 'claude-opus-5',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      signal: controller.signal,
    })
    // Let the spawn land, so the abort kills a RUNNING child rather than taking the
    // already-aborted-at-entry shortcut, which is a different rejection.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort(reason)
    return run.then(
      () => '(resolved)',
      (err: Error) => err.message,
    )
  }

  it('names the caller that aborted it', async () => {
    expect(await abortedMessage(new Error('harness shutting down (SIGTERM)'))).toBe(
      'harness shutting down (SIGTERM)',
    )
  })

  it('blames no watchdog when the abort named no reason', async () => {
    expect(await abortedMessage()).not.toMatch(/watchdog/i)
  })
})

// Stuck-run audit F13. The tool-silence window is opened by the CLI runner itself and beaten
// from where each stream reports tool activity — NOT from `onSpan`. That distinction is the
// finding: `runCodex` builds no `ToolCallTracker` and emits no spans at all, so a span-keyed
// window would have force-failed every codex pass longer than the window while it worked.
describe.runIf(unix)('the tool-silence window each runner opens', () => {
  /** Record the window's lifecycle for one run. */
  function recorder() {
    const events: string[] = []
    return {
      events,
      beginToolWindow: () => {
        events.push('open')
        return {
          toolCompleted: () => events.push('beat'),
          close: () => events.push('close'),
        }
      },
    }
  }

  it('is beaten by codex tool activity, which produces no spans at all', async () => {
    fakeCli('codex', [
      JSON.stringify({ type: 'exec_command_end', exit_code: 0 }),
      JSON.stringify({ type: 'agent_message', message: 'done' }),
    ])
    const spans: unknown[] = []
    const { events, beginToolWindow } = recorder()
    await runCodex({
      cwd,
      model: 'gpt-5.5-codex',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      onSpan: (span) => spans.push(span),
      beginToolWindow,
    })
    // The premise of the finding, asserted rather than assumed.
    expect(spans).toEqual([])
    expect(events).toEqual(['open', 'beat', 'close'])
  })

  it('is beaten by the claude-code turn that carries a tool_result', async () => {
    fakeCli('claude', [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ])
    const { events, beginToolWindow } = recorder()
    await runClaudeCode({
      cwd,
      model: 'sonnet',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      beginToolWindow,
    })
    expect(events).toEqual(['open', 'beat', 'close'])
  })

  it('is not beaten by a plain user turn that carries no tool result', async () => {
    // "The model sent a user turn" is not "a tool call completed"; treating it as one would
    // hand the watchdog a reset for work that did nothing.
    fakeCli('claude', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'continue' }] } }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ])
    const { events, beginToolWindow } = recorder()
    await runClaudeCode({
      cwd,
      model: 'sonnet',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      beginToolWindow,
    })
    expect(events).toEqual(['open', 'close'])
  })

  it('closes the window even when the CLI fails', async () => {
    failingCli('claude', [JSON.stringify({ type: 'result', is_error: true, result: 'boom' })], 1)
    const { events, beginToolWindow } = recorder()
    await expect(
      runClaudeCode({
        cwd,
        model: 'sonnet',
        systemPrompt: 'SYS',
        userPrompt: 'USER',
        ambientAuth: true,
        beginToolWindow,
      }),
    ).rejects.toThrow()
    expect(events).toEqual(['open', 'close'])
  })
})

// Stuck-run audit F6. `runPi` reports the records its reader refused to buffer; this path did
// not, so an oversized record cost the run its progress, its trajectory and that turn's
// telemetry with nothing to say it had happened.
describe.runIf(unix)('oversized-record reporting on the subscription stream', () => {
  it('warns once, with a count, when the reader dropped a record', async () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
    // The padding is generated INSIDE the fake rather than embedded in its source: the cap is
    // 32 MB, and a script literal that size costs more to write and parse than the rest of this
    // suite put together.
    const pad = "JSON.stringify({ type: 'pad', pad: 'x'.repeat(33 * 1024 * 1024) })"
    const done = "JSON.stringify({ type: 'result', result: 'done' })"
    writeFileSync(
      join(binDir, 'claude'),
      `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('data', () => {})\n` +
        `process.stdout.write(${pad} + '\\n')\n` +
        `process.stdout.write(${done} + '\\n')\n` +
        `process.stdout.end(() => process.exit(0))\n`,
      { mode: 0o755 },
    )
    await runClaudeCode({
      cwd,
      model: 'sonnet',
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      ambientAuth: true,
      log: {
        debug: () => {},
        info: () => {},
        warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
        error: () => {},
        child: () => {
          throw new Error('unused')
        },
      } as never,
    })
    const dropped = warnings.filter((w) => w.msg.includes('oversized'))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.fields).toMatchObject({ command: 'claude', oversizedLines: 1 })
  })
})
