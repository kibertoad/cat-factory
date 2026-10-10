import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  ToolCallTracker,
  captureToolBody,
  recordClaudeToolResults,
  toolCallResult,
  toolCallStart,
  type TrackedToolCall,
} from '../src/tool-trajectory.js'

describe('captureToolBody', () => {
  it('scrubs a credential out of a captured body', () => {
    const captured = captureToolBody('curl -H "auth: sk-secret-value"', 1024, ['sk-secret-value'])
    expect(captured.text).not.toContain('sk-secret-value')
    expect(captured.dropped).toBe(0)
  })

  it('caps a long body and STATES what it dropped', () => {
    const captured = captureToolBody('x'.repeat(100), 40, [])
    expect(captured.text).toHaveLength(40)
    // Not a rounded-off remainder: the exact count, so a reader can tell a short command from
    // the head of a long one.
    expect(captured.dropped).toBe(60)
  })

  it('distinguishes a body that was absent from one that could not be serialised', () => {
    expect(captureToolBody(undefined, 1024, [])).toEqual({ text: '', dropped: 0 })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(captureToolBody(cyclic, 1024, []).text).toBe('[unserialisable]')
  })
})

describe('ToolCallTracker', () => {
  it('pairs a start with its result and numbers the calls', () => {
    const tracker = new ToolCallTracker([], 1_000)
    tracker.started('call_1', 'bash', { command: 'pnpm test' }, 1_100)
    const first = tracker.finished('call_1', 'bash', 'ok', false, 1_500)
    tracker.started('call_2', 'edit_file', { path: 'a.ts' }, 1_600)
    const second = tracker.finished('call_2', 'edit_file', 'written', false, 1_700)

    expect(first).toMatchObject({
      tool: 'bash',
      seq: 0,
      startedAt: 1_100,
      endedAt: 1_500,
      ok: true,
      args: '{"command":"pnpm test"}',
      result: 'ok',
    })
    expect(second).toMatchObject({ tool: 'edit_file', seq: 1, startedAt: 1_600 })
  })

  it('pairs PARALLEL calls by id rather than by arrival order', () => {
    const tracker = new ToolCallTracker([], 0)
    tracker.started('a', 'read', { path: 'first.ts' })
    tracker.started('b', 'read', { path: 'second.ts' })
    // The CLI answers the second call first — routine when a model fires a batch.
    expect(tracker.finished('b', 'read', '', false).args).toBe('{"path":"second.ts"}')
    expect(tracker.finished('a', 'read', '', false).args).toBe('{"path":"first.ts"}')
  })

  it('still emits a call whose start was never seen, timed from the previous call', () => {
    const tracker = new ToolCallTracker([], 500)
    const orphan = tracker.finished(undefined, 'grep', 'no matches', false, 900)
    expect(orphan).toMatchObject({ tool: 'grep', seq: 0, startedAt: 500, args: '' })
    // The ordinal keeps counting, so every later entry's position stays honest.
    expect(tracker.finished(undefined, 'bash', '', true, 950).seq).toBe(1)
  })

  it('marks a failing call, because a stall is part of the trajectory', () => {
    const tracker = new ToolCallTracker([], 0)
    tracker.started('x', 'bash', { command: 'false' })
    expect(tracker.finished('x', 'bash', 'exit 1', true).ok).toBe(false)
  })
})

describe('Pi event readers', () => {
  it('reads a start event, whatever the stream calls the argument field', () => {
    expect(
      toolCallStart({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }),
    ).toEqual({ name: 'bash', args: { command: 'ls' } })
    expect(
      toolCallStart({ type: 'tool_call', toolName: 'read', input: { path: 'a' }, id: 'c1' }),
    ).toEqual({ name: 'read', args: { path: 'a' }, id: 'c1' })
    expect(toolCallStart({ type: 'message_end' })).toBeUndefined()
  })

  it('unwraps a result envelope, and falls back to the envelope for an unknown shape', () => {
    expect(toolCallResult({ type: 'tool_execution_end', result: { details: { n: 1 } } })).toEqual({
      n: 1,
    })
    expect(toolCallResult({ type: 'tool_execution_end', result: { content: 'text' } })).toBe('text')
    expect(toolCallResult({ type: 'tool_execution_end', result: { novel: 'shape' } })).toEqual({
      novel: 'shape',
    })
  })
})

describe('recordClaudeToolResults', () => {
  it('emits one entry per tool_result, paired with its tool_use by id', () => {
    const tracker = new ToolCallTracker([], 0)
    tracker.started('t1', 'Bash', { command: 'pnpm build' })
    const calls: TrackedToolCall[] = []
    recordClaudeToolResults(
      tracker,
      [
        { type: 'text', text: 'ignored' },
        { type: 'tool_result', tool_use_id: 't1', content: 'built', is_error: false },
      ],
      (call) => calls.push(call),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: 'Bash',
      seq: 0,
      ok: true,
      args: '{"command":"pnpm build"}',
      result: 'built',
    })
  })

  it('names an unpaired result rather than emitting a nameless step', () => {
    const calls: TrackedToolCall[] = []
    recordClaudeToolResults(
      new ToolCallTracker([], 0),
      [{ type: 'tool_result', tool_use_id: 'never-seen', content: 'x', is_error: true }],
      (call) => calls.push(call),
    )
    expect(calls[0]).toMatchObject({ tool: 'unknown', ok: false })
  })
})

describe('capture caps', () => {
  it('keeps the result cap above the args cap — the result is where the bytes are', () => {
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThan(MAX_TOOL_ARGS_CHARS)
  })
})
