import type { AgentToolCall, AgentToolCallRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the tool-call TRAJECTORY sink. The capture is runtime-neutral (the
// harness streams each call, `ContainerAgentExecutor` drains it on the job poll), but each facade
// persists it in its own store — D1 (the dedicated TELEMETRY_DB database) on Cloudflare,
// Drizzle/Postgres (the `telemetry` schema) on Node, `node:sqlite` on a mothership-mode laptop.
// This suite drives the SAME append → read → prune assertions through whichever real repository a
// runtime hands it, so a column mapped differently fails a test instead of shipping.
//
// The assertion this sink needs most is the ORDER one: a trajectory's meaning IS its sequence, so
// two stores disagreeing about it would render one run as two different runs. The sequence lives
// in `(startedAt, seq)` — the drain stamp `createdAt` is shared by a whole poll window, and the
// job id is a STRING whose sort order has nothing to do with when the dispatch ran.

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

    it('reads a run back in TRAJECTORY order, not drain order', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // Every call drained in ONE poll window, so every row shares a `created_at` — the exact
      // shape a `created_at` ordering renders as an arbitrary permutation. Within a dispatch the
      // two calls also share a `started_at` millisecond, which only `seq` separates.
      await repo.recordMany([
        call({
          id: `${ws}-c1`,
          workspaceId: ws,
          executionId: e1,
          jobId: `${e1}-coder`,
          seq: 1,
          startedAt: 1_000,
          createdAt: 7,
        }),
        call({
          id: `${ws}-f0`,
          workspaceId: ws,
          executionId: e1,
          jobId: `${e1}-ci-fixer`,
          seq: 0,
          startedAt: 2_000,
          createdAt: 7,
        }),
        call({
          id: `${ws}-c0`,
          workspaceId: ws,
          executionId: e1,
          jobId: `${e1}-coder`,
          seq: 0,
          startedAt: 1_000,
          createdAt: 7,
        }),
      ])

      // The dispatches come back in the order they RAN. A `job_id` ordering would put the
      // ci-fixer round first, because `<exec>-ci-fixer` sorts before `<exec>-coder`: a
      // trajectory read in an order the run never ran in invites causal conclusions from it.
      const trajectory = await repo.listByExecution(ws, { executionId: e1, limit: 50 })
      expect(trajectory.map((c) => c.id)).toEqual([`${ws}-c0`, `${ws}-c1`, `${ws}-f0`])
    })

    it('orders a step re-run by WHEN it ran, not by the spelling of its epoch', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // `stepJobId` suffixes a re-dispatch with its epoch, so the tenth round's job id ends
      // `-10` and sorts before the second's `-2` as a string. Only the clock gets this right.
      await repo.recordMany([
        call({
          id: `${ws}-e2`,
          workspaceId: ws,
          executionId: e1,
          jobId: `${e1}-coder-2`,
          seq: 0,
          startedAt: 2_000,
        }),
        call({
          id: `${ws}-e10`,
          workspaceId: ws,
          executionId: e1,
          jobId: `${e1}-coder-10`,
          seq: 0,
          startedAt: 10_000,
        }),
      ])

      expect(
        (await repo.listByExecution(ws, { executionId: e1, limit: 10 })).map((c) => c.id),
      ).toEqual([`${ws}-e2`, `${ws}-e10`])
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
      expect(
        (await repo.listByExecution(ws, { executionId: e1, limit: 2 })).map((c) => c.id),
      ).toEqual([`${ws}-0`, `${ws}-1`])
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
          startedAt: 500,
          endedAt: 600,
        }),
      ])

      const [stored, withheld] = await repo.listByExecution(ws, { executionId: e1, limit: 10 })
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

      expect(await repo.countByExecution(ws, e1)).toEqual({ total: 3, failed: 0 })
      expect(await repo.countByExecution(ws, e2)).toEqual({ total: 1, failed: 0 })
      // A run that called no tools counts 0 rather than throwing — the overview reports that
      // differently from an unwired sink. `failed` is 0 and not null: `SUM` over no rows is NULL
      // in both SQL dialects, and letting that reach the wire would put a null where the
      // overview's schema promises a number.
      expect(await repo.countByExecution(ws, 'exec-nothing')).toEqual({ total: 0, failed: 0 })
    })

    it('counts the FAILED tool calls in the same pass as the total', async () => {
      // The rollup that did not exist: a tool-execution failure leaves the model call that
      // requested it reporting `ok`, so nothing in the LLM telemetry counts these.
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-ok`, workspaceId: ws, executionId: e1, seq: 0, ok: true }),
        call({ id: `${ws}-bad1`, workspaceId: ws, executionId: e1, seq: 1, ok: false }),
        call({ id: `${ws}-bad2`, workspaceId: ws, executionId: e1, seq: 2, ok: false }),
        // A failure in a DIFFERENT run must not leak into this one's count.
        call({ id: `${ws}-other`, workspaceId: ws, executionId: e2, seq: 0, ok: false }),
      ])
      expect(await repo.countByExecution(ws, e1)).toEqual({ total: 3, failed: 2 })
      expect(await repo.countByExecution(ws, e2)).toEqual({ total: 1, failed: 1 })
    })

    it('narrows BOTH reads to the failing calls, in SQL', async () => {
      // Narrowed in the store rather than after the read, so the bound applies to the MATCHES:
      // the failing calls here sit past a `limit: 2` prefix, which a post-filter would return
      // empty, which is the "this run's tools all worked" answer that is exactly wrong.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-1`, workspaceId: ws, executionId: e1, seq: 0, startedAt: 10, ok: true }),
        call({ id: `${ws}-2`, workspaceId: ws, executionId: e1, seq: 1, startedAt: 20, ok: true }),
        call({ id: `${ws}-3`, workspaceId: ws, executionId: e1, seq: 2, startedAt: 30, ok: false }),
        call({ id: `${ws}-4`, workspaceId: ws, executionId: e1, seq: 3, startedAt: 40, ok: false }),
      ])

      // Trajectory: oldest-first, still in the order the agent made the calls.
      expect(
        (await repo.listByExecution(ws, { executionId: e1, limit: 2, outcome: 'error' })).map(
          (c) => c.id,
        ),
      ).toEqual([`${ws}-3`, `${ws}-4`])
      expect(
        (await repo.listByExecution(ws, { executionId: e1, limit: 10, outcome: 'ok' })).map(
          (c) => c.id,
        ),
      ).toEqual([`${ws}-1`, `${ws}-2`])
      // Page: newest-first on the keyset, same predicate.
      expect(
        (await repo.listPage(ws, { executionId: e1, limit: 10, outcome: 'error' })).map(
          (c) => c.id,
        ),
      ).toEqual([`${ws}-4`, `${ws}-3`])
      // Absent is NOT `ok`: no filter returns every row, which is what makes the two-member
      // picklist safe to carry on a query string.
      expect((await repo.listPage(ws, { executionId: e1, limit: 10 })).length).toBe(4)
    })

    it('composes the outcome filter with the dispatch filter', async () => {
      // "Did the third ci-fixer round keep hitting the same failing tool" needs both at once.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({ id: `${ws}-r1a`, workspaceId: ws, executionId: e1, jobId: 'r1', seq: 0, ok: false }),
        call({ id: `${ws}-r2a`, workspaceId: ws, executionId: e1, jobId: 'r2', seq: 0, ok: false }),
        call({ id: `${ws}-r2b`, workspaceId: ws, executionId: e1, jobId: 'r2', seq: 1, ok: true }),
      ])
      expect(
        (
          await repo.listByExecution(ws, {
            executionId: e1,
            limit: 10,
            jobId: 'r2',
            outcome: 'error',
          })
        ).map((c) => c.id),
      ).toEqual([`${ws}-r2a`])
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

    it('narrows the TRAJECTORY to one dispatch too', async () => {
      // "What did the third ci-fixer round actually do, in order" is the question the ordered
      // read and the dispatch filter only answer together.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.recordMany([
        call({
          id: `${ws}-r1a`,
          workspaceId: ws,
          executionId: e1,
          jobId: 'round-1',
          seq: 0,
          startedAt: 10,
        }),
        call({
          id: `${ws}-r2b`,
          workspaceId: ws,
          executionId: e1,
          jobId: 'round-2',
          seq: 1,
          startedAt: 30,
        }),
        call({
          id: `${ws}-r2a`,
          workspaceId: ws,
          executionId: e1,
          jobId: 'round-2',
          seq: 0,
          startedAt: 20,
        }),
      ])
      const round2 = await repo.listByExecution(ws, {
        executionId: e1,
        limit: 10,
        jobId: 'round-2',
      })
      expect(round2.map((c) => c.id)).toEqual([`${ws}-r2a`, `${ws}-r2b`])
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

      const after = await repo.listByExecution(ws, { executionId: e1, limit: 10 })
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
      expect(
        (await repo.listByExecution(ws, { executionId: e1, limit: 10 })).map((c) => c.id),
      ).toEqual([`${ws}-new`])
    })
  })
}
