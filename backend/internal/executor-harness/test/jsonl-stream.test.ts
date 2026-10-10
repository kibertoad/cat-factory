import { describe, expect, it } from 'vitest'
import { BoundedTail, JsonlLineReader } from '../src/jsonl-stream.js'
import {
  summarizeFromEvents,
  summarizePiRun,
  terminalErrorFromEvents,
  terminalRunError,
} from '../src/pi-reduction.js'

// The bounds that keep an agent CLI's stream off the harness's event loop and out of its heap
// (stuck-run audit F6). Both watchdog timers and the /health + /jobs poll endpoints run on the
// same loop as this framing, so an unbounded buffer here is what turns "a container can never
// run forever" into a container that stops answering polls with no watchdog having fired.

describe('JsonlLineReader', () => {
  /** Collect what the reader emits, tagged with its `final` flag. */
  const collect = (maxLineChars?: number) => {
    const lines: { line: string; final: boolean }[] = []
    const reader = new JsonlLineReader((line, final) => lines.push({ line, final }), maxLineChars)
    return { lines, reader }
  }

  it('frames complete records across chunk boundaries', () => {
    const { lines, reader } = collect()
    reader.push('{"type":"a"}\n{"ty')
    reader.push('pe":"b"}\n')
    expect(lines).toEqual([
      { line: '{"type":"a"}', final: false },
      { line: '{"type":"b"}', final: false },
    ])
    expect(reader.droppedLines).toBe(0)
  })

  it('flushes a trailing unterminated record as final', () => {
    const { lines, reader } = collect()
    reader.push('{"type":"a"}\n{"type":"agent_end"}')
    reader.flush()
    expect(lines).toEqual([
      { line: '{"type":"a"}', final: false },
      { line: '{"type":"agent_end"}', final: true },
    ])
  })

  it('flushes nothing when the stream ended on a newline', () => {
    const { lines, reader } = collect()
    reader.push('{"type":"a"}\n')
    reader.flush()
    expect(lines).toEqual([{ line: '{"type":"a"}', final: false }])
  })

  // The COST of that bound is pinned in `pi-reduction.test.ts`, which streams a real over-cap
  // record through `runPi`: framing that scanned the accumulated buffer once per chunk flattened
  // its rope every time, blocking the loop for ~6s on 32 MB, and those tests simply time out.
  it('drops a record that outgrows the cap and resynchronises on the next one', () => {
    const { lines, reader } = collect(64)
    reader.push(`{"pad":"${'x'.repeat(200)}"}\n{"type":"after"}\n`)
    // The oversized record is gone entirely rather than truncated — half a JSON document is not
    // a record — and everything after it still arrives.
    expect(lines).toEqual([{ line: '{"type":"after"}', final: false }])
    expect(reader.droppedLines).toBe(1)
  })

  it('counts a runaway record ONCE however many chunks it spans', () => {
    const { lines, reader } = collect(64)
    for (let i = 0; i < 50; i++) reader.push('x'.repeat(100))
    reader.push('\n{"type":"after"}\n')
    expect(lines).toEqual([{ line: '{"type":"after"}', final: false }])
    expect(reader.droppedLines).toBe(1)
  })

  it('never lets the buffer exceed the cap for an unterminated runaway record', () => {
    // The point of the whole bound: a producer that never emits a newline must not be able to
    // grow the buffer until parsing/allocating it stalls the loop. Observable through the fact
    // that nothing is emitted and the flush stays empty rather than handing over a giant line.
    const { lines, reader } = collect(1_000)
    for (let i = 0; i < 500; i++) reader.push('y'.repeat(1_000))
    reader.flush()
    expect(lines).toEqual([])
    expect(reader.droppedLines).toBe(1)
  })
})

describe('BoundedTail', () => {
  it('keeps everything while under the bound', () => {
    const tail = new BoundedTail(100)
    tail.push('hello ')
    tail.push('world')
    expect(tail.toString()).toBe('hello world')
  })

  it('keeps exactly the last maxChars across many small pushes', () => {
    const tail = new BoundedTail(10)
    for (let i = 0; i < 1_000; i++) tail.push(String(i % 10))
    const text = tail.toString()
    expect(text).toHaveLength(10)
    // The lazy trim must not lose ordering or drop the newest characters.
    expect(text).toBe('0123456789')
  })

  it('keeps the last maxChars of a single oversized push', () => {
    const tail = new BoundedTail(5)
    tail.push('abcdefghij')
    expect(tail.toString()).toBe('fghij')
  })
})

describe('close-of-run reductions over streamed records', () => {
  // `runPi` now reduces the records it parsed AS THEY STREAMED instead of re-parsing the whole
  // of stdout twice more at close. These pin that the two entry points agree, so the streaming
  // path cannot silently drift from the string-taking twins the offline tooling still uses.
  const lines = [
    '{"type":"message_end","message":{"role":"assistant","content":"partial"}}',
    '{"type":"tool_execution_end","toolName":"edit","isError":false}',
    '{"type":"agent_end","messages":[{"role":"assistant","content":"the answer"}]}',
  ]
  const stdout = `${lines.join('\n')}\n`
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

  it('summarizes identically whether reduced from records or re-parsed from stdout', () => {
    expect(summarizeFromEvents(events, stdout)).toEqual(summarizePiRun(stdout))
    expect(summarizeFromEvents(events, stdout).summary).toBe('the answer')
  })

  it('falls back to the stdout TAIL when nothing structured matched', () => {
    // The fallback only ever sliced the last 2 KB, which is why passing the bounded tail rather
    // than the whole run's output is lossless here.
    const noise = 'not json at all'
    expect(summarizeFromEvents([], noise).summary).toBe(noise)
  })

  it('detects a terminal run error identically from records and from stdout', () => {
    const failed = '{"type":"agent_end","stopReason":"error","error":"model unreachable"}'
    expect(terminalErrorFromEvents([JSON.parse(failed) as Record<string, unknown>])).toBe(
      terminalRunError(`${failed}\n`),
    )
    // A clean terminal transcript is not an error on either path.
    expect(terminalErrorFromEvents(events)).toBe(terminalRunError(stdout))
    expect(terminalErrorFromEvents(events)).toBeUndefined()
  })
})
