import type { AgentToolCall, AgentToolCallRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the tool-call TRAJECTORY sink. The capture is runtime-neutral (the
// harness streams each call, `ContainerAgentExecutor` drains it on the job poll), but each facade
// persists it in its own store — D1 (the dedicated TELEMETRY_DB database) on Cloudflare,
// Drizzle/Postgres (the `telemetry` schema) on Node, `node:sqlite` on a mothership-mode laptop.
// This suite drives the SAME append → read → prune assertions through whichever real repository a
// runtime hands it, so a column mapped differently fails a test instead of shipping.
//
// The assertion this sink needs most is the ORDER one: a trajectory's meaning IS its sequence, and
// the sequence lives in `(jobId, seq)` rather than in a timestamp, because a tool loop routinely
// fires several calls inside one millisecond and each dispatch numbers its own from zero.

function call(overrides: Partial<AgentToolCall> & Pick<AgentToolCall, 'id'>): AgentToolCall {
  return {
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
    args: '{"command":"pnpm test"}',
    result: 'ok',
    argsDropped: 0,
    resultDropped: 0,
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link AgentToolCallRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; ids are unique per run so the shared
 * database stays isolated between cases.
 */
export function defineAgentToolCallSuite(
  name: string,
  makeRepo: () => AgentToolCallRepository,
): void {
  describe(`[${name}] agent tool call repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('reads a run back in TRAJECTORY order, not timestamp order', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // Every call in one millisecond, inserted out of order, across two dispatches — the exact
      // shape a `created_at` ordering renders as an arbitrary permutation.
      await repo.recordMany([
        call({ id: `${ws}-b1`, workspaceId: ws, executionId: e1, jobId: 'job-b', seq: 1, createdAt: 7 }),
        call({ id: `${ws}-a1`, workspaceId: ws, executionId: e1, jobId: 'job-a', seq: 1, createdAt: 7 }),
        call({ id: `${ws}-a0`, workspaceId: ws, executionId: e1, jobId: 'job-a', seq: 0, createdAt: 7 }),
        call({ id: `${ws}-b0`, workspaceId: ws, executionId: e1, jobId: 'job-b', seq: 0, createdAt: 7 }),
      ])

      const trajectory = await repo.listByExecution(ws, e1, 50)
      expect(trajectory.map((c) => c.id)).toEqual([
        `${ws}-a0`,
        `${ws}-a1`,
        `${ws}-b0`,
        `${ws}-b1`,
      ])
    })

    it('bounds the trajectory read at its OLDEST end, so a truncated read is a prefix', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-0`, workspaceId: ws, executionId: e1, seq: 0 }),
        call({ id: `${ws}-1`, workspaceId: ws, executionId: e1, seq: 1 }),
        call({ id: `${ws}-2`, workspaceId: ws, executionId: e1, seq: 2 }),
      ])
      // A middle slice with no beginning would be unreadable as a trajectory.
      expect((await repo.listByExecution(ws, e1, 2)).map((c) => c.id)).toEqual([
        `${ws}-0`,
        `${ws}-1`,
      ])
    })

    it('round-trips the bodies, the dropped counts and the withheld state', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({
          id: `${ws}-stored`,
          workspaceId: ws,
          executionId: e1,
          seq: 0,
          agentKind: 'ci-fixer',
          tool: 'run_command',
          args: '{"command":"pnpm build"}',
          result: 'build failed',
          argsDropped: 3,
          resultDropped: 4_096,
          ok: false,
          startedAt: 100,
          endedAt: 400,
        }),
        // A withheld call: the metadata is the same shape, the bodies are empty, and the row SAYS
        // why — the distinction the whole gate exists to keep legible.
        call({
          id: `${ws}-withheld`,
          workspaceId: ws,
          executionId: e1,
          seq: 1,
          bodies: 'withheld',
          args: '',
          result: '',
        }),
      ])

      const [stored, withheld] = await repo.listByExecution(ws, e1, 10)
      expect(stored).toMatchObject({
        agentKind: 'ci-fixer',
        tool: 'run_command',
        ok: false,
        bodies: 'stored',
        args: '{"command":"pnpm build"}',
        result: 'build failed',
        argsDropped: 3,
        resultDropped: 4_096,
        startedAt: 100,
        endedAt: 400,
      })
      expect(withheld).toMatchObject({ bodies: 'withheld', args: '', result: '' })
    })

    it('scopes reads to the run, and pages the debug list on a composite keyset', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-a`, workspaceId: ws, executionId: e1, seq: 0, createdAt: 10 }),
        // Same millisecond: the tie a `created_at`-only cursor loses.
        call({ id: `${ws}-b`, workspaceId: ws, executionId: e1, seq: 1, createdAt: 20 }),
        call({ id: `${ws}-c`, workspaceId: ws, executionId: e1, seq: 2, createdAt: 20 }),
        call({ id: `${ws}-x`, workspaceId: ws, executionId: e2, seq: 0, createdAt: 30 }),
      ])

      const first = await repo.listPage(ws, { executionId: e1, limit: 2 })
      expect(first.map((c) => c.id)).toEqual([`${ws}-c`, `${ws}-b`])
      const last = first[first.length - 1]!
      const second = await repo.listPage(ws, {
        executionId: e1,
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })
      expect(second.map((c) => c.id)).toEqual([`${ws}-a`])

      expect(await repo.countByExecution(ws, e1)).toBe(3)
      expect(await repo.countByExecution(ws, e2)).toBe(1)
      // A run that called no tools counts 0 rather than throwing — the overview reports that
      // differently from an unwired sink.
      expect(await repo.countByExecution(ws, 'exec-nothing')).toBe(0)
    })

    it('narrows a page to ONE dispatch', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-r1`, workspaceId: ws, executionId: e1, jobId: 'round-1', seq: 0 }),
        call({ id: `${ws}-r2`, workspaceId: ws, executionId: e1, jobId: 'round-2', seq: 0 }),
      ])
      const page = await repo.listPage(ws, { executionId: e1, limit: 10, jobId: 'round-2' })
      expect(page.map((c) => c.id)).toEqual([`${ws}-r2`])
    })

    it('batch-appends calls, ignoring ids it already stored', async () => {
      // Two producers re-offer the same call: the durable poll path replays, and the
      // mothership-mode ingest retries a chunk whose ack was lost. A repeat must be inert rather
      // than a duplicate-key failure that parks the upload, and FIRST WRITE WINS rather than an
      // upsert — a re-offered call is byte-identical, so there is nothing to correct.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-1`, workspaceId: ws, executionId: e1, seq: 0 }),
        call({ id: `${ws}-2`, workspaceId: ws, executionId: e1, seq: 1 }),
      ])
      await repo.recordMany([
        call({ id: `${ws}-1`, workspaceId: ws, executionId: e1, seq: 0, tool: 'rewritten' }),
        call({ id: `${ws}-3`, workspaceId: ws, executionId: e1, seq: 2 }),
      ])

      const after = await repo.listByExecution(ws, e1, 10)
      expect(after.map((c) => c.id)).toEqual([`${ws}-1`, `${ws}-2`, `${ws}-3`])
      expect(after[0]!.tool).toBe('bash')

      await expect(repo.recordMany([])).resolves.toBeUndefined()
    })

    it('prunes calls older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-old`, workspaceId: ws, executionId: e1, seq: 0, createdAt: 5 }),
        call({ id: `${ws}-new`, workspaceId: ws, executionId: e1, seq: 1, createdAt: 50 }),
      ])
      const removed = await repo.deleteOlderThan(10)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByExecution(ws, e1, 10)).map((c) => c.id)).toEqual([`${ws}-new`])
    })
  })
}
