import { describe, expect, it } from 'vitest'
import { analyzeCase, computeMetrics } from '../src/analyze'
import { caseId } from '../src/case'
import { SMOKETEST_FIXTURES } from '../src/fixtures'
import { renderTranscript } from '../src/transcript'
import type { Finding, PiEvent } from '../src/types'

// All offline: the analyser is a pure function over a captured Pi event stream,
// so these construct representative event sequences and assert the findings +
// verdict. No Pi, no network.

const toolEnd = (toolName: string, isError = false, extra: PiEvent = {}): PiEvent => ({
  type: 'tool_execution_end',
  toolName,
  isError,
  ...extra,
})
const toolStart = (toolName: string, args: unknown): PiEvent => ({
  type: 'tool_execution_start',
  toolName,
  args,
})
const agentEnd = (text: string, toolCalls: string[] = [], stopReason = 'end_turn'): PiEvent => ({
  type: 'agent_end',
  stopReason,
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...toolCalls.map((toolName) => ({ type: 'toolCall', toolName })),
      ],
    },
  ],
})

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code)
}

describe('analyzeCase — healthy', () => {
  it('a run that edits files and finishes cleanly is healthy with no findings', () => {
    const events = [toolEnd('read'), toolEnd('edit'), agentEnd('Added /health endpoint.', ['edit'])]
    const a = analyzeCase({ events, durationMs: 1000, diffBytes: 420, filesChanged: 2 })
    expect(a.verdict).toBe('healthy')
    expect(a.findings).toHaveLength(0)
    expect(a.metrics.edits).toBe(1)
    expect(a.metrics.toolCalls).toBe(2)
    expect(a.summary).toContain('/health')
  })
})

describe('analyzeCase — breakage', () => {
  it('flags a no-op run (no tool calls, no assistant text) as broken', () => {
    const events: PiEvent[] = [{ type: 'agent_end', messages: [] }]
    const a = analyzeCase({ events, durationMs: 500, diffBytes: 0, filesChanged: 0 })
    expect(a.verdict).toBe('broken')
    expect(codes(a.findings)).toContain('no-op-run')
  })

  it('flags an empty event stream as broken', () => {
    const a = analyzeCase({
      events: [],
      error: 'pi exited with code 1',
      durationMs: 100,
      diffBytes: 0,
      filesChanged: 0,
    })
    expect(a.verdict).toBe('broken')
    expect(codes(a.findings)).toContain('no-events')
  })

  it("flags 'pi not on PATH' as a harness breakage", () => {
    const a = analyzeCase({
      events: [],
      error: 'spawn pi ENOENT',
      durationMs: 5,
      diffBytes: 0,
      filesChanged: 0,
    })
    expect(codes(a.findings)).toContain('pi-not-runnable')
  })

  it('flags a terminal model error (retries exhausted) as broken', () => {
    const events = [toolEnd('bash'), { type: 'auto_retry_end', success: false, finalError: '502' }]
    const a = analyzeCase({ events, durationMs: 9000, diffBytes: 0, filesChanged: 0 })
    expect(a.verdict).toBe('broken')
    expect(codes(a.findings)).toContain('terminal-model-error')
  })
})

describe('analyzeCase — dead-ends', () => {
  it('classifies a no-edits guard abort', () => {
    const error =
      'no progress: 40 tool calls and not one file edit — the agent is exploring or probing ' +
      'the environment without implementing anything. Aborting before it burns the whole run.'
    const events = Array.from({ length: 40 }, () => toolEnd('bash'))
    const a = analyzeCase({ events, error, durationMs: 60000, diffBytes: 0, filesChanged: 0 })
    expect(a.verdict).toBe('broken')
    const f = a.findings.find((x) => x.code === 'guard-no-edits')
    expect(f?.category).toBe('dead-end')
  })

  it('flags a run that produced no file changes as a soft dead-end', () => {
    const events = [toolEnd('read'), agentEnd('I looked around but did not change anything.')]
    const a = analyzeCase({ events, durationMs: 3000, diffBytes: 0, filesChanged: 0 })
    expect(a.verdict).toBe('degraded')
    expect(codes(a.findings)).toContain('no-changes')
  })
})

describe('analyzeCase — loops', () => {
  it('flags repeated identical tool calls', () => {
    const events = [
      ...Array.from({ length: 4 }, () => toolStart('bash', { cmd: 'npm test' })),
      ...Array.from({ length: 4 }, () => toolEnd('bash')),
      agentEnd('Kept re-running the tests.', ['edit']),
    ]
    const a = analyzeCase({ events, durationMs: 20000, diffBytes: 300, filesChanged: 1 })
    expect(a.verdict).toBe('degraded')
    expect(codes(a.findings)).toContain('repeated-tool-call')
  })

  it('flags consecutive failing tool calls (sub-guard threshold)', () => {
    const events = [...Array.from({ length: 5 }, () => toolEnd('bash', true)), agentEnd('stuck')]
    const a = analyzeCase({ events, durationMs: 20000, diffBytes: 50, filesChanged: 1 })
    expect(codes(a.findings)).toContain('consecutive-tool-errors')
    expect(codes(a.findings)).toContain('high-error-rate')
    expect(a.verdict).toBe('degraded')
  })

  it('does not double-report errors already covered by the guard kill', () => {
    const error =
      'no progress: 12 consecutive failing tool calls — the agent is stuck retrying a failing ' +
      'operation rather than making progress. Aborting.'
    const events = Array.from({ length: 12 }, () => toolEnd('bash', true))
    const a = analyzeCase({ events, error, durationMs: 30000, diffBytes: 0, filesChanged: 0 })
    expect(codes(a.findings)).toContain('guard-error-loop')
    expect(codes(a.findings)).not.toContain('consecutive-tool-errors')
  })
})

describe('computeMetrics', () => {
  it('derives the tool histogram and todo state', () => {
    const events = [
      toolEnd('read'),
      toolEnd('read'),
      toolEnd('edit'),
      toolEnd('todo', false, {
        result: { details: { tasks: [{ status: 'completed' }, { status: 'pending' }] } },
      }),
    ]
    const m = computeMetrics({ events, durationMs: 1000, diffBytes: 100, filesChanged: 1 })
    expect(m.toolHistogram).toMatchObject({ read: 2, edit: 1, todo: 1 })
    expect(m.edits).toBe(1)
    expect(m.todo).toEqual({ completed: 1, inProgress: 0, total: 2 })
  })
})

describe('renderTranscript', () => {
  it('renders assistant text, tool results and todo state', () => {
    const events = [
      { type: 'message_end', message: { role: 'assistant', content: 'Starting work.' } },
      toolEnd('bash', false, { output: 'ok' }),
      toolEnd('todo', false, {
        result: { details: { tasks: [{ status: 'completed', subject: 'Add route' }] } },
      }),
      agentEnd('Done.'),
    ]
    const md = renderTranscript(events)
    expect(md).toContain('Starting work.')
    expect(md).toContain('bash')
    expect(md).toContain('todo')
    expect(md).toContain('agent end')
  })

  it('handles an empty stream', () => {
    expect(renderTranscript([])).toContain('no renderable events')
  })
})

describe('fixtures + ids', () => {
  it('ships moderate coding fixtures with clone urls and tasks', () => {
    expect(SMOKETEST_FIXTURES.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const fx of SMOKETEST_FIXTURES) {
      expect(fx.repo.cloneUrl).toMatch(/^https:\/\//)
      expect(fx.task.length).toBeGreaterThan(40)
      expect(ids.has(fx.id)).toBe(false)
      ids.add(fx.id)
    }
  })

  it('caseId is filesystem-safe', () => {
    expect(caseId('healthcheck-endpoint', 'workers-ai:@cf/x')).toBe(
      'healthcheck-endpoint__workers-ai-cf-x',
    )
  })
})
