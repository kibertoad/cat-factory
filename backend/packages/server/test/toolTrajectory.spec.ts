import { describe, expect, it } from 'vitest'
import type { AgentJobHandle, LlmToolSpan, LlmToolSpanContext } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { ToolCallsRecordInput } from '@cat-factory/orchestration'
import { drainToolCalls } from '../src/agents/toolTrajectory.js'

// The poll's tool-call drain. What it owns is the BODY GATE: one decision per drained batch,
// applied before either destination sees it, because a body withheld from the store and shipped
// to an external trace backend anyway is precisely the privacy defect the shared gate exists to
// prevent — and two reads is how the two answers get to disagree.

const handle = {
  workspaceId: 'ws_1',
  runId: 'exec_1',
  jobId: 'job_1',
  agentKind: 'coder',
} as unknown as AgentJobHandle

const span = (overrides: Partial<LlmToolSpan> = {}): LlmToolSpan => ({
  tool: 'run_command',
  seq: 0,
  startedAt: 1,
  endedAt: 2,
  ok: true,
  bodies: 'stored',
  args: '{"command":"pnpm build"}',
  result: 'built',
  argsDropped: 0,
  resultDropped: 7,
  ...overrides,
})

function collect() {
  const traced: { context: LlmToolSpanContext; spans: LlmToolSpan[] }[] = []
  const recorded: ToolCallsRecordInput[] = []
  return {
    traced,
    recorded,
    llmTraceSink: {
      recordGeneration: () => {},
      recordToolSpans: (context: LlmToolSpanContext, spans: LlmToolSpan[]) => {
        traced.push({ context, spans })
      },
    },
    recordToolCalls: async (input: ToolCallsRecordInput) => {
      recorded.push(input)
    },
  }
}

describe('drainToolCalls', () => {
  const log = createRecordingLogger()

  it('sends the SAME gated batch to the store and the trace sink', async () => {
    const sinks = collect()
    await drainToolCalls(
      { ...sinks, toolBodyGate: async () => true },
      handle,
      [span(), span({ seq: 1, tool: 'read' })],
      log,
    )

    expect(sinks.recorded[0]?.spans.map((s) => s.args)).toEqual([
      '{"command":"pnpm build"}',
      '{"command":"pnpm build"}',
    ])
    expect(sinks.traced[0]?.spans).toEqual(sinks.recorded[0]?.spans)
    // The dispatch rides both, since `seq` restarts per dispatch and orders nothing without it.
    expect(sinks.traced[0]?.context.jobId).toBe('job_1')
    expect(sinks.recorded[0]?.jobId).toBe('job_1')
  })

  it('MARKS a refused body as withheld rather than only blanking it', async () => {
    const sinks = collect()
    await drainToolCalls({ ...sinks, toolBodyGate: async () => false }, handle, [span()], log)

    // Blanking alone would leave `bodies: 'stored'` with empty text, which reads as a tool that
    // took no arguments — a claim about the run this drain is in no position to make.
    for (const batch of [sinks.recorded[0]?.spans, sinks.traced[0]?.spans]) {
      expect(batch?.[0]).toMatchObject({
        bodies: 'withheld',
        args: '',
        result: '',
        resultDropped: 0,
      })
      // The metadata survives: a withheld body must not cost the trajectory itself.
      expect(batch?.[0]).toMatchObject({ tool: 'run_command', seq: 0, ok: true })
    }
  })

  it('withholds bodies when NO gate is wired, rather than assuming permission', async () => {
    const sinks = collect()
    await drainToolCalls(sinks, handle, [span()], log)
    expect(sinks.recorded[0]?.spans[0]?.bodies).toBe('withheld')
  })

  it('fails CLOSED on an unreadable gate, but still forwards the batch', async () => {
    const sinks = collect()
    const recording = createRecordingLogger()
    await drainToolCalls(
      {
        ...sinks,
        toolBodyGate: async () => {
          throw new Error('settings store down')
        },
      },
      handle,
      [span()],
      recording,
    )

    // An unreadable settings row is not consent — but losing the run's whole trajectory to a
    // store hiccup would trade a privacy bug for an observability one.
    expect(sinks.recorded[0]?.spans[0]?.bodies).toBe('withheld')
    expect(sinks.recorded[0]?.spans).toHaveLength(1)
    expect(recording.lines.some((line) => line.level === 'warn')).toBe(true)
  })

  it('traces a job with no workspace, but files no row for it', async () => {
    const sinks = collect()
    await drainToolCalls(
      { ...sinks, toolBodyGate: async () => true },
      { ...handle, workspaceId: undefined } as unknown as AgentJobHandle,
      [span()],
      log,
    )

    // A trajectory row is workspace-scoped state; a placeholder would put one deployment's tool
    // calls in another's reads. A span has no such problem.
    expect(sinks.traced).toHaveLength(1)
    expect(sinks.recorded).toHaveLength(0)
  })

  it('is a no-op on an empty drain, so a quiet poll costs no gate read', async () => {
    const sinks = collect()
    let gateReads = 0
    await drainToolCalls(
      {
        ...sinks,
        toolBodyGate: async () => {
          gateReads += 1
          return true
        },
      },
      handle,
      [],
      log,
    )
    expect(gateReads).toBe(0)
    expect(sinks.traced).toHaveLength(0)
  })
})
