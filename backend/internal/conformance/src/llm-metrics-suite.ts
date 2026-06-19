import type { LlmCallMetric, LlmCallMetricRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the LLM observability sink. The proxy that records these
// metrics is runtime-neutral, but each facade persists them in its own store (D1 on
// Cloudflare, Drizzle/Postgres on Node). This suite drives the SAME record → list →
// summarize → prune assertions through whichever real repository a runtime hands it,
// so a column mapped differently or an aggregate computed differently fails a test
// instead of shipping. Both runtimes invoke it over their real database.

/** Build a fully-specified metric, overriding only what a case cares about. */
function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 30,
    totalMs: 230,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link LlmCallMetricRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids are unique
 * per run so the shared database stays isolated between cases.
 */
export function defineLlmMetricsSuite(
  name: string,
  makeRepo: () => LlmCallMetricRepository,
): void {
  describe(`[${name}] llm metrics repository parity`, () => {
    // Unique workspace/execution per case so the shared DB doesn't bleed across tests.
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('records calls and lists them newest-first per execution', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
      await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 30 }))
      await repo.record(metric({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))
      await repo.record(metric({ id: `${ws}-d`, workspaceId: ws, executionId: e2, createdAt: 99 }))

      const calls = await repo.listByExecution(ws, e1)
      expect(calls.map((c) => c.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
      // The other execution's call is excluded.
      expect((await repo.listByExecution(ws, e2)).map((c) => c.id)).toEqual([`${ws}-d`])
      // Round-trips the full record (incl. the heavy text columns + nullable fields).
      const first = calls[0]!
      expect(first.responseText).toBe('ok')
      expect(first.streaming).toBe(false)
      expect(first.requestMaxTokens).toBe(1000)
    })

    it('round-trips the delta prompt fields and reports the newest chain tip', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // No calls yet ⇒ no chain tip.
      expect(await repo.latestChainTip(ws, e1, 'coder')).toBeNull()

      await repo.record(
        metric({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 10,
          messageCount: 2,
          promptText: '[{"role":"system"},{"role":"user"}]',
          promptPrefixCount: 0,
          promptHash: 'h1',
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-2`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 20,
          messageCount: 4,
          promptText: '[{"role":"assistant"},{"role":"tool"}]',
          promptPrefixCount: 2,
          promptHash: 'h2',
        }),
      )

      // The tip is the newest call for the (ws, execution, kind) chain.
      expect(await repo.latestChainTip(ws, e1, 'coder')).toEqual({ messageCount: 4, promptHash: 'h2' })
      // A different agent kind has its own (empty) chain.
      expect(await repo.latestChainTip(ws, e1, 'reviewer')).toBeNull()

      // The delta fields survive the round-trip.
      const stored = (await repo.listByExecution(ws, e1)).find((c) => c.id === `${ws}-2`)!
      expect(stored.promptPrefixCount).toBe(2)
      expect(stored.promptHash).toBe('h2')
      expect(stored.promptText).toBe('[{"role":"assistant"},{"role":"tool"}]')
    })

    it('summarizes per agent-kind: tokens, peak, headroom, truncation, errors, warnings', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // ok stop, truncated (length → warning), and a failed call — same agent kind.
      await repo.record(
        metric({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          completionTokens: 50,
          requestMaxTokens: 1000,
          upstreamMs: 100,
          overheadMs: 10,
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-2`,
          workspaceId: ws,
          executionId: e1,
          completionTokens: 990,
          requestMaxTokens: 1000,
          finishReason: 'length',
          upstreamMs: 200,
          overheadMs: 20,
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-3`,
          workspaceId: ws,
          executionId: e1,
          ok: false,
          httpStatus: 502,
          finishReason: null,
          completionTokens: 0,
          upstreamMs: 5,
          overheadMs: 5,
        }),
      )

      const summaries = await repo.summarizeByExecution(ws, e1)
      expect(summaries).toHaveLength(1)
      const s = summaries[0]!
      expect(s.agentKind).toBe('coder')
      expect(s.calls).toBe(3)
      expect(s.completionTokens).toBe(1040)
      expect(s.peakCompletionTokens).toBe(990)
      expect(s.maxOutputTokens).toBe(1000)
      expect(s.truncatedCalls).toBe(1)
      expect(s.errors).toBe(1)
      expect(s.warnings).toBe(1)
      expect(s.upstreamMs).toBe(305)
      expect(s.overheadMs).toBe(35)
    })

    it('groups summaries by agent kind', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(metric({ id: `${ws}-x`, workspaceId: ws, executionId: e1, agentKind: 'coder' }))
      await repo.record(
        metric({ id: `${ws}-y`, workspaceId: ws, executionId: e1, agentKind: 'reviewer' }),
      )
      const summaries = await repo.summarizeByExecution(ws, e1)
      expect(summaries.map((s) => s.agentKind).sort()).toEqual(['coder', 'reviewer'])
    })

    it('prunes rows older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // Far-apart timestamps so the cutoff is unambiguous. `deleteOlderThan` is a
      // global (table-wide) retention prune, so its count can include other cases'
      // rows in the shared DB — assert the scoped, deterministic outcome instead.
      await repo.record(metric({ id: `${ws}-old`, workspaceId: ws, executionId: e1, createdAt: 1_000 }))
      await repo.record(
        metric({ id: `${ws}-new`, workspaceId: ws, executionId: e1, createdAt: 9_000_000 }),
      )
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByExecution(ws, e1)).map((c) => c.id)).toEqual([`${ws}-new`])
    })
  })
}
