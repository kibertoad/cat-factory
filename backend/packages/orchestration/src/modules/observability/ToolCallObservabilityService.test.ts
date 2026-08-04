import { describe, expect, it } from 'vitest'
import type { AgentToolCall, LlmToolSpan } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  MAX_TOOL_BODY_CHARS,
  ToolCallObservabilityService,
  makeToolCallRecorder,
} from './ToolCallObservabilityService.js'

function fakeRepo() {
  const rows: AgentToolCall[] = []
  return {
    rows,
    repo: {
      recordMany: async (calls: AgentToolCall[]) => {
        rows.push(...calls)
      },
      listByExecution: async () => [],
      listPage: async () => [],
      countByExecution: async () => 0,
      deleteOlderThan: async () => 0,
    },
  }
}

const span = (overrides: Partial<LlmToolSpan> = {}): LlmToolSpan => ({
  tool: 'bash',
  seq: 0,
  startedAt: 1,
  endedAt: 2,
  ok: true,
  bodies: 'stored',
  args: '{"command":"ls"}',
  result: 'a.ts',
  argsDropped: 0,
  resultDropped: 0,
  ...overrides,
})

describe('ToolCallObservabilityService', () => {
  const clock = { now: () => 5_000 }

  it('derives each row id from (jobId, seq), so a replayed poll re-records rather than duplicates', async () => {
    const { rows, repo } = fakeRepo()
    const service = new ToolCallObservabilityService({ agentToolCallRepository: repo, clock })
    const call = {
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      jobId: 'job_7',
      seq: 3,
      tool: 'bash',
      startedAt: 1,
      endedAt: 2,
      ok: true,
      bodies: 'stored' as const,
      args: '',
      result: '',
      argsDropped: 0,
      resultDropped: 0,
    }
    await service.record([call])
    await service.record([call])

    // Same id both times — the store's first-write-wins is what makes the replay a no-op.
    expect(rows.map((r) => r.id)).toEqual(['job_7-tc-000003', 'job_7-tc-000003'])
    expect(rows[0]?.createdAt).toBe(5_000)
  })

  it('pads the ordinal so the debug page’s id tiebreak agrees with the call order', async () => {
    // A whole poll window is stamped at ONE `createdAt`, so `(createdAt, id)` ties are the
    // common case here and the id decides. Unpadded, call 19 would sort before call 2 and the
    // page would contradict the `seq` printed on its own rows.
    const { rows, repo } = fakeRepo()
    const service = new ToolCallObservabilityService({ agentToolCallRepository: repo, clock })
    const base = {
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      jobId: 'job',
      tool: 'bash',
      startedAt: 1,
      endedAt: 2,
      ok: true,
      bodies: 'stored' as const,
      args: '',
      result: '',
      argsDropped: 0,
      resultDropped: 0,
    }
    await service.record([2, 19].map((seq) => ({ ...base, seq })))

    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(['job-tc-000002', 'job-tc-000019'])
    expect([...ids].sort()).toEqual(ids)
  })

  it('never upgrades a withheld body, whatever text arrives with it', async () => {
    const { rows, repo } = fakeRepo()
    const service = new ToolCallObservabilityService({ agentToolCallRepository: repo, clock })
    await service.record([
      {
        workspaceId: 'ws',
        executionId: 'exec',
        agentKind: 'coder',
        jobId: 'job',
        seq: 0,
        tool: 'bash',
        startedAt: 1,
        endedAt: 2,
        ok: true,
        bodies: 'withheld',
        args: 'should not be stored',
        result: 'nor this',
        argsDropped: 0,
        resultDropped: 0,
      },
    ])
    expect(rows[0]).toMatchObject({ bodies: 'withheld', args: '', result: '' })
  })

  it('clamps an over-long body and ADDS what it dropped to the capture cap’s own count', async () => {
    const { rows, repo } = fakeRepo()
    const service = new ToolCallObservabilityService({ agentToolCallRepository: repo, clock })
    await service.record([
      {
        workspaceId: 'ws',
        executionId: 'exec',
        agentKind: 'coder',
        jobId: 'job',
        seq: 0,
        tool: 'bash',
        startedAt: 1,
        endedAt: 2,
        ok: true,
        bodies: 'stored',
        args: 'x'.repeat(MAX_TOOL_BODY_CHARS + 10),
        // The harness already cut 40 characters; the backstop's own cut adds to that count
        // rather than replacing it, or the row would understate what the reader is missing.
        argsDropped: 40,
        result: '',
        resultDropped: 0,
      },
    ])
    expect(rows[0]?.args).toHaveLength(MAX_TOOL_BODY_CHARS)
    expect(rows[0]?.argsDropped).toBe(50)
  })
})

describe('makeToolCallRecorder', () => {
  it('SKIPS a batch whose image numbers no calls, and names the job', async () => {
    const recorded: unknown[][] = []
    const log = createRecordingLogger()
    const record = makeToolCallRecorder({ record: async (calls) => void recorded.push(calls) }, log)
    await record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      jobId: 'job',
      // An older harness image: the position in the batch restarts at zero every poll window, so
      // deriving ids from it would collide every window's first call onto one row and
      // first-write-wins would silently drop the rest.
      spans: [span({ seq: undefined }), span({ seq: undefined })],
    })

    expect(recorded).toHaveLength(0)
    const warning = log.lines.find((line) => line.level === 'warn')
    expect(warning?.msg).toMatch(/no call ordinals/)
    expect(warning?.fields).toMatchObject({ jobId: 'job' })
  })

  it('defaults an older image’s missing body state to WITHHELD, never to stored', async () => {
    const recorded: { bodies: string; args: string }[][] = []
    const record = makeToolCallRecorder({
      record: async (calls) => void recorded.push(calls),
    })
    await record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      jobId: 'job',
      spans: [{ tool: 'read', seq: 0, startedAt: 1, endedAt: 2, ok: true }],
    })
    // Reading that image's silence as `stored` would present its empty `args` as a tool that
    // took none.
    expect(recorded[0]?.[0]).toMatchObject({ bodies: 'withheld', args: '' })
  })
})
