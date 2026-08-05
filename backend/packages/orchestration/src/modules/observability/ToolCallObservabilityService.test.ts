import { describe, expect, it } from 'vitest'
import type { AgentToolCall, LlmToolSpan } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  MAX_TOOL_BODY_CHARS,
  ToolCallObservabilityService,
  makeToolCallRecorder,
} from './ToolCallObservabilityService.js'

/**
 * A repo that HONOURS `limit` and `outcome` the way every real store does.
 *
 * A fake that ignores them cannot fail the tests worth having here: the reads under test are
 * exactly the ones whose job is to notice that a bound bit, and a stub returning `[]` agrees
 * with every possible answer.
 */
function fakeRepo() {
  const rows: AgentToolCall[] = []
  return {
    rows,
    repo: {
      recordMany: async (calls: AgentToolCall[]) => {
        rows.push(...calls)
      },
      listByExecution: async (
        _ws: string,
        query: { executionId: string; limit: number; outcome?: 'ok' | 'error' },
      ) =>
        rows
          .filter((r) => r.executionId === query.executionId)
          .filter((r) => (query.outcome ? r.ok === (query.outcome === 'ok') : true))
          .slice(0, query.limit),
      listPage: async () => [],
      countByExecution: async (_ws: string, executionId: string) => {
        const mine = rows.filter((r) => r.executionId === executionId)
        return { total: mine.length, failed: mine.filter((r) => !r.ok).length }
      },
      deleteOlderThan: async () => 0,
    },
  }
}

/** One stored row, positioned in a run's trajectory. */
function row(overrides: Partial<AgentToolCall> & Pick<AgentToolCall, 'id'>): AgentToolCall {
  return {
    workspaceId: 'ws',
    executionId: 'run',
    agentKind: 'coder',
    jobId: 'job',
    seq: 0,
    tool: 'bash',
    startedAt: 1,
    endedAt: 2,
    ok: true,
    bodies: 'stored',
    args: '',
    result: '',
    argsDropped: 0,
    resultDropped: 0,
    createdAt: 1,
    ...overrides,
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

describe('the panel reads', () => {
  /** Build a service over `count` rows, every `failEvery`-th one a failure. */
  function serviceOver(count: number, failEvery = 0) {
    const { rows, repo } = fakeRepo()
    for (let i = 0; i < count; i++) {
      rows.push(row({ id: `c${i}`, seq: i, ok: failEvery === 0 || i % failEvery !== 0 }))
    }
    return new ToolCallObservabilityService({
      agentToolCallRepository: repo,
      clock: { now: () => 5_000 },
    })
  }

  it('reports an untruncated trajectory as the whole run', () => {
    // `truncated` is read off a row fetched PAST the cap, never off `length === limit`, which
    // guesses wrong on the run whose call count lands exactly on the bound.
    return serviceOver(10)
      .listForRun('ws', 'run')
      .then((trajectory) => {
        expect(trajectory.toolCalls).toHaveLength(10)
        expect(trajectory.truncated).toBe(false)
      })
  })

  it('SAYS a long run was cut to a prefix, and hands back exactly the cap', async () => {
    const trajectory = await serviceOver(2_100).listForRun('ws', 'run')
    expect(trajectory.toolCalls).toHaveLength(2_000)
    expect(trajectory.truncated).toBe(true)
    // A prefix, so the run's OPENING calls: the bound takes the oldest end, which is what makes
    // a truncated read a genuine beginning rather than an arbitrary slice.
    expect(trajectory.toolCalls[0]?.id).toBe('c0')
  })

  it('counts failures over the WHOLE run while returning a bounded list of them', async () => {
    // The split this read exists for. 4,000 calls, every other one failing: the count is a SQL
    // aggregate over all of them, the rows are capped, and the two disagreeing is stated rather
    // than hidden — a panel that counted the rows would report 200 failures out of 2,000.
    const failures = await serviceOver(4_000, 2).failuresForRun('ws', 'run')
    expect(failures.total).toBe(4_000)
    expect(failures.failed).toBe(2_000)
    expect(failures.failures).toHaveLength(200)
    expect(failures.failuresTruncated).toBe(true)
    expect(failures.failures.every((c) => !c.ok)).toBe(true)
  })

  it('answers a clean run with zero failures and no truncation', async () => {
    const failures = await serviceOver(5).failuresForRun('ws', 'run')
    expect(failures).toEqual({ total: 5, failed: 0, failures: [], failuresTruncated: false })
  })
})
