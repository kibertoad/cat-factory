import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoundedTail } from '../src/jsonl-stream.js'
import { PiRunReducer, summarizeFromEvents } from '../src/pi-reduction.js'
import { runPi } from '../src/pi.js'

// Reducing a run's event stream WITHOUT retaining it (stuck-run audit F6). Bounding the JSONL
// framing alone left the other half of that finding open: `runPi` still held every parsed record
// for the run's duration, and a parsed object is typically larger than the raw text it replaced,
// so a chatty producer could still exhaust the heap — another way for a container to stop
// answering polls with no watchdog having fired.

const event = (o: Record<string, unknown>): Record<string, unknown> => o

describe('PiRunReducer', () => {
  it('answers from a folded stream exactly as it does from the whole array', () => {
    const events = [
      event({ type: 'message_end', message: { role: 'assistant', content: 'thinking' } }),
      event({ type: 'tool_execution_end', toolName: 'edit' }),
      event({ type: 'agent_end', messages: [{ role: 'assistant', content: 'the answer' }] }),
    ]
    const folded = new PiRunReducer()
    for (const e of events) folded.observe(e)
    expect(folded.reduce('tail')).toEqual(summarizeFromEvents(events, 'tail'))
  })

  it('retains ONE transcript however many records stream past it', () => {
    // The bound that matters: memory is O(largest single record), not O(records). A reducer that
    // kept growing here is the heap-exhaustion mode this replaced, and it is invisible in a
    // correctness assertion — only the retained-object count shows it.
    const reducer = new PiRunReducer()
    for (let i = 0; i < 50_000; i++) {
      reducer.observe(event({ type: 'message_end', message: { role: 'assistant', content: 'x' } }))
      reducer.observe(event({ type: 'tool_execution_end', toolName: 't' }))
    }
    reducer.observe(
      event({ type: 'agent_end', messages: [{ role: 'assistant', content: 'done' }] }),
    )
    const { summary, stats } = reducer.reduce('')
    expect(summary).toBe('done')
    // The transcript wins over the streamed counters, exactly as the array reduction did.
    expect(stats).toEqual({ toolCalls: 0, assistantChars: 4 })
  })

  it('falls back to streamed counters and text when no transcript arrived', () => {
    const reducer = new PiRunReducer()
    reducer.observe(event({ type: 'message_end', message: { role: 'assistant', content: 'one' } }))
    reducer.observe(event({ type: 'message_end', message: { role: 'assistant', content: 'two' } }))
    reducer.observe(event({ type: 'tool_execution_end', toolName: 'edit' }))
    const { summary, stats } = reducer.reduce('')
    expect(summary).toBe('one\ntwo')
    expect(stats).toEqual({ toolCalls: 1, assistantChars: 6 })
  })

  it('says so when the fallback summary is a TAIL rather than the whole answer', () => {
    // A bounded tail read as a prefix looks like a model that stopped at the first word. The
    // cap has to state what it dropped, or the omission is indistinguishable from the output.
    const reducer = new PiRunReducer()
    for (let i = 0; i < 40; i++) {
      reducer.observe(
        event({ type: 'message_end', message: { role: 'assistant', content: 'y'.repeat(10_000) } }),
      )
    }
    const { summary } = reducer.reduce('')
    expect(summary).toMatch(/^\[earlier assistant output omitted: \d+ characters\]\n/)
    expect(summary.length).toBeLessThan(40 * 10_000)
  })

  it('distinguishes a run that ended cleanly from one that emitted no terminal record', () => {
    // `terminalError()` returning undefined has two causes needing different reactions: the run
    // ended fine, or the record that would have said so never arrived. Only the second makes
    // "no terminal failure" an answer from nothing.
    const clean = new PiRunReducer()
    clean.observe(event({ type: 'agent_end', messages: [] }))
    expect(clean.terminalError()).toBeUndefined()
    expect(clean.sawTerminalRecord).toBe(true)

    const silent = new PiRunReducer()
    silent.observe(event({ type: 'message_end', message: { role: 'assistant', content: 'hi' } }))
    expect(silent.terminalError()).toBeUndefined()
    expect(silent.sawTerminalRecord).toBe(false)
  })

  it('decides on the LAST terminal record, as a scan from the end would', () => {
    const reducer = new PiRunReducer()
    reducer.observe(event({ type: 'agent_end', messages: [] }))
    reducer.observe(event({ type: 'auto_retry_end', success: false, finalError: 'gave up' }))
    expect(reducer.terminalError()).toBe('gave up')
  })
})

describe('BoundedTail', () => {
  it('reports what the bound dropped off the front', () => {
    const tail = new BoundedTail(5)
    tail.push('abcdefghij')
    expect(tail.toString()).toBe('fghij')
    expect(tail.totalChars).toBe(10)
    expect(tail.droppedChars).toBe(5)
  })

  it('reports nothing dropped while everything still fits', () => {
    const tail = new BoundedTail(50)
    tail.push('abc')
    expect(tail.droppedChars).toBe(0)
  })
})

// Unix-only for the same reason as `agent-runner.test.ts`: the fake CLI is a chmod-+x shebang
// script, and Windows has no equivalent.
const unix = process.platform !== 'win32'

describe.runIf(unix)('runPi terminal-record certification', () => {
  let binDir: string
  let cwd: string
  let priorPath: string | undefined

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'cf-bin-'))
    cwd = mkdtempSync(join(tmpdir(), 'cf-cwd-'))
    priorPath = process.env.PATH
    process.env.PATH = `${binDir}:${priorPath ?? ''}`
  })

  afterEach(() => {
    process.env.PATH = priorPath
    rmSync(binDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  /**
   * A fake `pi` streaming the given records, where a record may ask for `pad` bytes of filler.
   * The filler is generated INSIDE the fake rather than embedded in its source: the cap this
   * exercises is 32 MB, and a script literal that size costs more to write and parse than the
   * whole rest of the suite.
   */
  function fakePi(records: { type: string; body?: string; pad?: number }[]): void {
    const script =
      `#!/usr/bin/env node\n` +
      `process.stdin.resume()\nprocess.stdin.on('data', () => {})\n` +
      `const records = ${JSON.stringify(records)}\n` +
      `for (const r of records) {\n` +
      `  const line = r.pad\n` +
      `    ? JSON.stringify({ type: r.type, pad: 'x'.repeat(r.pad) })\n` +
      `    : r.body\n` +
      `  process.stdout.write(line + '\\n')\n` +
      `}\n` +
      `process.stdout.end(() => process.exit(0))\n`
    writeFileSync(join(binDir, 'pi'), script, { mode: 0o755 })
  }

  const OVER_CAP = 33 * 1024 * 1024
  const answer = '{"type":"agent_end","messages":[{"role":"assistant","content":"the answer"}]}'
  const run = () => runPi({ cwd, model: 'm', userPrompt: 'p', sessionToken: 't' })

  it('refuses to certify a clean exit whose terminal record was dropped for being oversized', async () => {
    // The exact case the terminal scan exists to prevent, arriving through the F6 line cap: the
    // record that decides whether the run failed is `agent_end`, which carries the whole
    // transcript and so is the one most likely to blow the cap. With it dropped the scan finds
    // no failure — from having seen nothing at all — and a hard-failed run would resolve GREEN.
    fakePi([
      { type: 'message_end', body: '{"type":"message_end","message":{"role":"assistant"}}' },
      { type: 'agent_end', pad: OVER_CAP },
    ])
    await expect(run()).rejects.toThrow(/terminal record was dropped/)
  })

  it('still resolves when an oversized record was dropped but the terminal one arrived', async () => {
    // A mid-run drop costs that record's signal and nothing else — the run's outcome is still
    // known, so refusing here would fail a run that plainly succeeded.
    fakePi([
      { type: 'message_end', pad: OVER_CAP },
      { type: 'agent_end', body: answer },
    ])
    await expect(run()).resolves.toMatchObject({ summary: 'the answer' })
  })

  it('resolves normally when nothing was dropped', async () => {
    fakePi([{ type: 'agent_end', body: answer }])
    await expect(run()).resolves.toMatchObject({ summary: 'the answer' })
  })
})
