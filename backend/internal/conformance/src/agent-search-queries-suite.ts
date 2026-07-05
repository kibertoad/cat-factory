import type { AgentSearchQuery, AgentSearchQueryRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the agent-search-query observability sink. The recorder that
// writes these rows is runtime-neutral (the WebSearchProxyController + the
// SearchQueryObservabilityService), but each facade persists them in its own store —
// D1 (the dedicated TELEMETRY_DB database) on Cloudflare, Drizzle/Postgres (the
// `telemetry` schema) on Node. This suite drives the SAME record → list → prune
// assertions through whichever real repository a runtime hands it, so a column mapped
// differently fails a test instead of shipping. Both runtimes invoke it over their real
// database.

function query(
  overrides: Partial<AgentSearchQuery> & Pick<AgentSearchQuery, 'id'>,
): AgentSearchQuery {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'searxng',
    query: 'how to write a valibot schema',
    resultCount: 5,
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link AgentSearchQueryRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; ids are unique per run so the
 * shared database stays isolated between cases.
 */
export function defineAgentSearchQuerySuite(
  name: string,
  makeRepo: () => AgentSearchQueryRepository,
): void {
  describe(`[${name}] agent search query repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('records queries and lists them newest-first per execution', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(query({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
      await repo.record(query({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 30 }))
      await repo.record(query({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))
      await repo.record(query({ id: `${ws}-d`, workspaceId: ws, executionId: e2, createdAt: 99 }))

      const list = await repo.listByExecution(ws, e1)
      expect(list.map((q) => q.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
      // The other execution's query is excluded.
      expect((await repo.listByExecution(ws, e2)).map((q) => q.id)).toEqual([`${ws}-d`])
    })

    it('round-trips the query text, provider, and result count', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        query({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          agentKind: 'ci-fixer',
          provider: 'brave',
          query: 'fix flaky vitest timeout',
          resultCount: 3,
        }),
      )
      const stored = (await repo.listByExecution(ws, e1))[0]!
      expect(stored.agentKind).toBe('ci-fixer')
      expect(stored.provider).toBe('brave')
      expect(stored.query).toBe('fix flaky vitest timeout')
      expect(stored.resultCount).toBe(3)
    })

    it('persists a null provider', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(query({ id: `${ws}-np`, workspaceId: ws, executionId: e1, provider: null }))
      expect((await repo.listByExecution(ws, e1))[0]!.provider).toBeNull()
    })

    it('prunes queries older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(query({ id: `${ws}-old`, workspaceId: ws, executionId: e1, createdAt: 5 }))
      await repo.record(query({ id: `${ws}-new`, workspaceId: ws, executionId: e1, createdAt: 50 }))
      const removed = await repo.deleteOlderThan(10)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByExecution(ws, e1)).map((q) => q.id)).toEqual([`${ws}-new`])
    })
  })
}
