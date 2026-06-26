import type { AgentContextSnapshot, AgentContextSnapshotRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the agent-context observability sink. The recorder that
// writes these snapshots is runtime-neutral (the ContainerAgentExecutor + the
// AgentContextObservabilityService), but each facade persists them in its own store —
// D1 (the dedicated TELEMETRY_DB database) on Cloudflare, Drizzle/Postgres (the
// `telemetry` schema) on Node. This suite drives the SAME record → list → prune
// assertions through whichever real repository a runtime hands it, so a column mapped
// differently or a JSON blob (de)serialised differently fails a test instead of
// shipping. Both runtimes invoke it over their real database.

function snapshot(
  overrides: Partial<AgentContextSnapshot> & Pick<AgentContextSnapshot, 'id'>,
): AgentContextSnapshot {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    stepIndex: 0,
    createdAt: 1,
    model: 'workers-ai:m',
    harness: 'pi',
    systemPrompt: 'system',
    userPrompt: 'user',
    fragments: [{ id: 'node-ts', body: 'use TypeScript' }],
    contextFiles: [{ path: 'rfc.md', title: 'RFC', url: 'https://x/rfc', content: 'full body' }],
    extras: { pipelineName: 'pl_build', webSearch: false },
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link AgentContextSnapshotRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids are unique per
 * run so the shared database stays isolated between cases.
 */
export function defineAgentContextSuite(
  name: string,
  makeRepo: () => AgentContextSnapshotRepository,
): void {
  describe(`[${name}] agent context snapshot repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('records snapshots and lists them newest-first per execution', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(
        snapshot({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 30 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-d`, workspaceId: ws, executionId: e2, createdAt: 99 }),
      )

      const list = await repo.listByExecution(ws, e1)
      expect(list.map((s) => s.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
      // The other execution's snapshot is excluded.
      expect((await repo.listByExecution(ws, e2)).map((s) => s.id)).toEqual([`${ws}-d`])
    })

    it('round-trips prompts, fragment + file arrays and the extras object', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        snapshot({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          stepIndex: 3,
          model: 'anthropic:claude',
          fragments: [
            { id: 'f1', body: 'body one' },
            { id: 'f2', body: 'body two' },
          ],
          contextFiles: [
            { path: 'a.md', title: 'A', url: 'https://x/a', content: 'AAA' },
            { path: 'b.md', title: 'B', url: 'https://x/b', content: 'BBB' },
          ],
          extras: { pipelineName: 'pl_build', branch: 'cat-factory/blk', webSearch: true },
        }),
      )
      const stored = (await repo.listByExecution(ws, e1))[0]!
      expect(stored.stepIndex).toBe(3)
      expect(stored.model).toBe('anthropic:claude')
      expect(stored.systemPrompt).toBe('system')
      expect(stored.userPrompt).toBe('user')
      expect(stored.fragments).toEqual([
        { id: 'f1', body: 'body one' },
        { id: 'f2', body: 'body two' },
      ])
      expect(stored.contextFiles).toEqual([
        { path: 'a.md', title: 'A', url: 'https://x/a', content: 'AAA' },
        { path: 'b.md', title: 'B', url: 'https://x/b', content: 'BBB' },
      ])
      expect(stored.extras).toMatchObject({ branch: 'cat-factory/blk', webSearch: true })
    })

    it('prunes snapshots older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        snapshot({ id: `${ws}-old`, workspaceId: ws, executionId: e1, createdAt: 5 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-new`, workspaceId: ws, executionId: e1, createdAt: 50 }),
      )
      const removed = await repo.deleteOlderThan(10)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByExecution(ws, e1)).map((s) => s.id)).toEqual([`${ws}-new`])
    })
  })
}
