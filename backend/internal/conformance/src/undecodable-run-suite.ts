import type {
  AgentRunRepository,
  ExecutionRepository,
  PlatformMetricsRepository,
} from '@cat-factory/kernel'
import { isDataIntegrityError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { PlatformMetricsSeed } from './platform-metrics-suite.js'

// Cross-runtime parity for the disposal of a run whose stored row cannot be decoded.
//
// The engine's half is unit-tested against a fake; what CANNOT be is the claim the whole mechanism
// rests on, because it is a fact about each facade's real SQL: that `markFailed` reaches a row
// `get` cannot decode. Both repositories guard that write with their own predicate (D1
// `AND kind='execution' AND status NOT IN ('done','failed')`, Drizzle `isExecution` +
// `notInArray`), and a facade whose `markFailed` grew a read, a different filter, or a
// `block_id`-joined UPDATE would keep the unit test green while the row stayed `running` forever on
// that runtime alone. That is precisely the immortal run this whole change exists to end.
//
// The poison row is seeded through the RAW seam rather than the repository, and has to be: the
// write-side guard now refuses to compose one, which is the point of that guard. A raw insert with
// no `block_id` is exactly the shape production produced.

/** What one runtime supplies to run this suite over its real store. */
export interface UndecodableRunDeps {
  /** The facade's execution repository: the `get` that must throw and the `markFailed` that must land. */
  executions: ExecutionRepository
  /** The kind-spanning `agent_runs` view, for the terminality read that decodes nothing. */
  agentRuns: AgentRunRepository
  /** The operator rollup, where the disposed run has to become a `state_unreadable` count. */
  platformMetrics: PlatformMetricsRepository
  /** The raw seed seam (shared with the platform-metrics suite): a workspace and one `agent_runs` row. */
  seed: PlatformMetricsSeed
}

export function defineUndecodableRunSuite(name: string, makeDeps: () => UndecodableRunDeps): void {
  describe(`[${name}] a run whose row cannot be decoded`, () => {
    it('is refused by the read and still settled by the SQL-only write', async () => {
      const { executions, agentRuns, platformMetrics, seed } = makeDeps()
      // A unique account per case, so the account-scoped rollup below cannot see another's rows.
      const account = `acct_undecodable_${name}`
      const workspaceId = `ws_undecodable_${name}`
      const runId = `exec_undecodable_${name}`
      await seed.workspace(workspaceId, account)
      // No `block_id`: the exact row production produced, and the one `rowToExecution` refuses.
      await seed.run({
        workspaceId,
        id: runId,
        kind: 'execution',
        status: 'running',
        createdAt: 1_000,
        updatedAt: 1_000,
      })

      // 1. The read guard is real on this store, and it is recognisable BY TYPE: the engine's
      //    disposal branches on that and nothing else.
      const thrown = await executions.get(workspaceId, runId).then(
        () => null,
        (error: unknown) => error,
      )
      expect(isDataIntegrityError(thrown)).toBe(true)

      // 2. The run is LIVE, which is what kept the sweeper re-listing it forever.
      expect(await agentRuns.liveRunIds([runId])).toEqual([runId])

      // 3. The disposal write lands on a row nothing can decode. This is the load-bearing fact.
      await executions.markFailed(workspaceId, runId, {
        kind: 'state_unreadable',
        message: 'This run’s stored state could not be read, so it could not be resumed.',
        detail: 'Execution row has no block_id',
        hint: null,
        reason: 'run_state_unreadable',
        occurredAt: 2_000,
        lastSubtasks: null,
      })

      // 4. And it LEFT the live set, so no sweeper re-drives it again. The read decodes nothing,
      //    so it can answer for a row `get` still cannot.
      expect(await agentRuns.liveRunIds([runId])).toEqual([])

      // 5. The operator's failure-kind breakdown gains the count, which is the whole reason the
      //    kind is distinct from `stalled`: it is the one surface where such a run is visible at
      //    all, the board having dropped the row.
      const breakdown = await platformMetrics.failureKindBreakdown(account, 0)
      expect(breakdown).toEqual(
        expect.arrayContaining([expect.objectContaining({ failureKind: 'state_unreadable' })]),
      )
    })

    it('is refused by the read for an out-of-bounds cursor too', async () => {
      // The SECOND unreadable shape, and the reason the write-side guard asserts both invariants
      // rather than only the one that motivated it: a truncated step list with the cursor left
      // where it was is as un-loadable as a blockless row, on both stores.
      const { executions, seed } = makeDeps()
      const account = `acct_cursor_${name}`
      const workspaceId = `ws_cursor_${name}`
      const runId = `exec_cursor_${name}`
      await seed.workspace(workspaceId, account)
      await seed.run({
        workspaceId,
        id: runId,
        kind: 'execution',
        status: 'running',
        createdAt: 1_000,
        updatedAt: 1_000,
        blockId: 'blk_cursor',
        detail: JSON.stringify({ steps: [], currentStep: 3 }),
      })

      const thrown = await executions.get(workspaceId, runId).then(
        () => null,
        (error: unknown) => error,
      )
      expect(isDataIntegrityError(thrown)).toBe(true)
    })
  })
}
