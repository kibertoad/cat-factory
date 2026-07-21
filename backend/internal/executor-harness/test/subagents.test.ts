import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSliceTracker, pickProgress, startSubagentWatcher } from '../src/subagents.js'
import type { TodoProgress } from '../src/pi.js'

// D2.1 (slice progress off the parent stream) + D3 (subagent usage off the transcripts),
// corrected by ADR 0027: the watcher walks the `projects` tree for `**/subagents/*.jsonl`
// (Defect A), and `pickProgress` reconciles the todo-plan + slice-tracker views (Defect B).

describe('createSliceTracker', () => {
  const taskBlock = (id: string, description: string) => ({
    type: 'tool_use',
    name: 'Task',
    id,
    input: { description, subagent_type: 'general-purpose' },
  })
  const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'done' })

  it('derives slices + progress from Task dispatches and their tool_results', () => {
    const t = createSliceTracker()
    expect(t.hasSlices()).toBe(false)
    expect(t.progress()).toBeUndefined()

    t.onAssistant([{ type: 'text', text: 'planning' }, taskBlock('t1', 'Review auth slice')])
    t.onAssistant([taskBlock('t2', 'Review migration SQL slice')])
    expect(t.hasSlices()).toBe(true)
    expect(t.progress()).toEqual({
      completed: 0,
      inProgress: 2,
      total: 2,
      items: [
        { label: 'Review auth slice', status: 'in_progress' },
        { label: 'Review migration SQL slice', status: 'in_progress' },
      ],
    })

    // The first subagent returns.
    t.onUser([toolResult('t1')])
    expect(t.progress()).toMatchObject({ completed: 1, inProgress: 1, total: 2 })

    t.onUser([toolResult('t2')])
    expect(t.progress()).toMatchObject({ completed: 2, inProgress: 0, total: 2 })
  })

  it('ignores non-Task tool_use and is idempotent on a repeated id', () => {
    const t = createSliceTracker()
    t.onAssistant([{ type: 'tool_use', name: 'Bash', id: 'b1', input: {} }])
    expect(t.hasSlices()).toBe(false)
    t.onAssistant([taskBlock('t1', 'slice')])
    t.onAssistant([taskBlock('t1', 'slice again')]) // same id — no double count
    expect(t.progress()?.total).toBe(1)
  })

  it('labels a description-less Task by position', () => {
    const t = createSliceTracker()
    t.onAssistant([{ type: 'tool_use', name: 'Task', id: 't1', input: {} }])
    expect(t.progress()?.items?.[0]?.label).toBe('Subagent 1')
  })
})

describe('pickProgress (ADR 0027 Defect B)', () => {
  const p = (completed: number, inProgress: number, total: number): TodoProgress => ({
    completed,
    inProgress,
    total,
    items: [],
  })

  it('returns whichever single source is present (or neither)', () => {
    expect(pickProgress(undefined, undefined)).toBeUndefined()
    expect(pickProgress(p(1, 0, 3), undefined)).toEqual(p(1, 0, 3))
    expect(pickProgress(undefined, p(0, 2, 2))).toEqual(p(0, 2, 2))
  })

  it('prefers the slice tracker when the once-written todo plan is stale', () => {
    // The pr-reviewer shape: the todo plan is written ONCE (5 slices + an aggregate entry),
    // all pending, and never marked done. The parallel Task slices are what actually advance
    // — first in flight, then all returned — so the slice tracker must win in both states.
    const stalePlan = p(0, 0, 6)
    expect(pickProgress(stalePlan, p(0, 4, 4))).toEqual(p(0, 4, 4)) // in-flight beats all-pending
    expect(pickProgress(stalePlan, p(4, 0, 4))).toEqual(p(4, 0, 4)) // all returned beats 0 done
  })

  it('prefers the advancing todo plan for the sequential shape', () => {
    expect(pickProgress(p(3, 1, 6), undefined)).toEqual(p(3, 1, 6))
    expect(pickProgress(p(3, 1, 6), p(0, 2, 2))).toEqual(p(3, 1, 6)) // more completed wins
  })

  it('breaks a completed+inProgress tie toward the richer (more total) view, else the todo plan', () => {
    expect(pickProgress(p(1, 1, 6), p(1, 1, 4))).toEqual(p(1, 1, 6))
    const todo = p(2, 1, 5)
    expect(pickProgress(todo, p(2, 1, 5))).toBe(todo) // full tie keeps the todo plan
  })
})

describe('startSubagentWatcher', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-subagents-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const assistantLine = (obj: {
    input: number
    output: number
    text?: string
    model?: string
    cacheRead?: number
  }): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        ...(obj.model ? { model: obj.model } : {}),
        stop_reason: 'end_turn',
        usage: {
          input_tokens: obj.input,
          output_tokens: obj.output,
          ...(obj.cacheRead ? { cache_read_input_tokens: obj.cacheRead } : {}),
        },
        content: [{ type: 'text', text: obj.text ?? 'reviewing' }],
      },
    })

  it('sums subagent usage and lifts per-call telemetry from *.jsonl transcripts', async () => {
    const sub = join(dir, 'subagents')
    mkdirSync(sub)
    writeFileSync(
      join(sub, 'a.jsonl'),
      assistantLine({ input: 100, output: 20, model: 'claude-opus-4-8', cacheRead: 40 }) + '\n',
    )
    writeFileSync(join(sub, 'b.jsonl'), assistantLine({ input: 200, output: 30 }) + '\n')

    let activity = 0
    const watcher = startSubagentWatcher(sub, {
      onActivity: () => {
        activity++
      },
      intervalMs: 1_000_000, // only the stop() final poll runs — deterministic
      model: 'fallback-model',
    })
    await watcher.stop()

    // input tokens fold in the cache-read bucket (100+40) + 200 = 340; output 20+30 = 50.
    expect(watcher.usage()).toEqual({ inputTokens: 340, outputTokens: 50 })
    const calls = watcher.calls()
    expect(calls).toHaveLength(2)
    expect(calls.find((c) => c.model === 'claude-opus-4-8')).toBeTruthy()
    // A transcript with no model falls back to the supplied model.
    expect(calls.find((c) => c.model === 'fallback-model')).toBeTruthy()
    expect(activity).toBeGreaterThan(0)
  })

  it('discovers subagent transcripts under the real projects/<cwd>/<session>/subagents layout', async () => {
    // Lay the tree out exactly as the Claude CLI writes it (recovered verbatim in ADR 0027):
    // the PARENT session transcript sits directly under the session dir, and each parallel
    // Task subagent writes beside it in a `subagents/` subdir. The watcher is pointed at the
    // `projects` ROOT (the session uuid isn't known before the CLI mints it), so it must find
    // the subagent files by walking — the exact case Defect A got wrong.
    const projects = join(dir, 'projects')
    const session = join(
      projects,
      '-tmp-agent-explore-Z0Fhxx',
      'aeb3854a-0ff9-42a2-8b82-b60615a3834e',
    )
    const sub = join(session, 'subagents')
    mkdirSync(sub, { recursive: true })
    // The parent's OWN session transcript. It carries usage too, but the terminal `result`
    // event already totals it — reading it here would double-count the parent, so a file NOT
    // under a `subagents/` dir must be EXCLUDED.
    writeFileSync(
      join(session, 'aeb3854a-0ff9-42a2-8b82-b60615a3834e.jsonl'),
      assistantLine({ input: 9999, output: 9999 }) + '\n',
    )
    writeFileSync(
      join(sub, 'agent-1.jsonl'),
      assistantLine({ input: 100, output: 20, model: 'claude-opus-4-8' }) + '\n',
    )
    writeFileSync(join(sub, 'agent-2.jsonl'), assistantLine({ input: 200, output: 30 }) + '\n')

    const watcher = startSubagentWatcher(projects, {
      intervalMs: 1_000_000,
      model: 'fallback-model',
    })
    await watcher.stop()

    // Only the two subagent transcripts are summed (300 in / 50 out); the parent session
    // transcript's 9999/9999 is skipped — proof the walk excludes the sibling parent file.
    expect(watcher.usage()).toEqual({ inputTokens: 300, outputTokens: 50 })
    expect(watcher.calls()).toHaveLength(2)
  })

  it('tails only NEW content across polls (no double count)', async () => {
    const sub = join(dir, 'subagents')
    mkdirSync(sub)
    const file = join(sub, 'a.jsonl')
    writeFileSync(file, assistantLine({ input: 10, output: 5 }) + '\n')

    const watcher = startSubagentWatcher(sub, { intervalMs: 1_000_000 })
    await watcher.stop() // reads the first line
    expect(watcher.usage()).toEqual({ inputTokens: 10, outputTokens: 5 })

    appendFileSync(file, assistantLine({ input: 7, output: 3 }) + '\n')
    await watcher.stop() // idempotent stop still drains the tail
    expect(watcher.usage()).toEqual({ inputTokens: 17, outputTokens: 8 })
  })

  it('reassembles a multi-byte character split across two polls (no corruption)', async () => {
    const sub = join(dir, 'subagents')
    mkdirSync(sub)
    const file = join(sub, 'a.jsonl')
    // A subagent turn whose response text carries a multi-byte character (é = C3 A9). Write
    // the file in two chunks split BETWEEN é's two bytes, polling in between — the byte carry
    // must stitch it back rather than emit two U+FFFD replacements.
    const line = Buffer.from(assistantLine({ input: 8, output: 4, text: 'café' }) + '\n', 'utf8')
    const splitAt = line.indexOf(0xc3) + 1 // land inside the é
    writeFileSync(file, line.subarray(0, splitAt))

    const watcher = startSubagentWatcher(sub, { intervalMs: 1_000_000 })
    await watcher.stop() // partial line: nothing ingested yet
    expect(watcher.calls()).toHaveLength(0)

    appendFileSync(file, line.subarray(splitAt))
    await watcher.stop()
    expect(watcher.usage()).toEqual({ inputTokens: 8, outputTokens: 4 })
    expect(watcher.calls()[0]?.responseText).toBe('café')
  })

  it('degrades gracefully when the directory never appears', async () => {
    const watcher = startSubagentWatcher(join(dir, 'nope'), { intervalMs: 1_000_000 })
    await expect(watcher.stop()).resolves.toBeUndefined()
    expect(watcher.usage()).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(watcher.calls()).toEqual([])
  })

  it('skips malformed lines and lines without usage', async () => {
    const sub = join(dir, 'subagents')
    mkdirSync(sub)
    writeFileSync(
      join(sub, 'a.jsonl'),
      [
        'not json',
        JSON.stringify({ type: 'user', message: { content: [] } }),
        JSON.stringify({ type: 'assistant', message: { content: [], usage: {} } }),
        assistantLine({ input: 5, output: 2 }),
      ].join('\n') + '\n',
    )
    const watcher = startSubagentWatcher(sub, { intervalMs: 1_000_000 })
    await watcher.stop()
    expect(watcher.usage()).toEqual({ inputTokens: 5, outputTokens: 2 })
    expect(watcher.calls()).toHaveLength(1)
  })
})
