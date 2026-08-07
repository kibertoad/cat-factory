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

    // --- the tool servers (MCP) one dispatch wired and dropped -------------------------
    // Tool servers had no cross-runtime assertion of any kind before this: everything about
    // them lived in the container executor (which the conformance harness replaces with a fake)
    // and in an untyped corner of `extras`. Now that the decision is a COLUMN, the two things a
    // column can get wrong per runtime are what these two cases pin: the payload, and the
    // difference between "declared none" and "declared some and wired none".

    it('round-trips the tool servers a dispatch wired and dropped', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        snapshot({
          id: `${ws}-mcp`,
          workspaceId: ws,
          executionId: e1,
          toolServers: [
            { id: 'slack', label: 'Slack', status: 'wired' },
            { id: 'jira', label: 'Jira', status: 'unavailable', reason: 'missing_secret' },
          ],
        }),
      )
      const stored = (await repo.listByExecution(ws, e1))[0]!
      // The REASON is the load-bearing half: it is the only record of why an agent was never
      // given a tool its kind declares, and it is what the run surface renders a chip from.
      expect(stored.toolServers).toEqual([
        { id: 'slack', label: 'Slack', status: 'wired' },
        { id: 'jira', label: 'Jira', status: 'unavailable', reason: 'missing_secret' },
      ])
    })

    it('reports a dispatch that declared no tool servers as ABSENT, never as an empty list', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // Both stores default the column to '[]', so a runtime that mapped it back verbatim would
      // report every stock run's every step as having an (empty) tool-server section, breaking the
      // "absent and zero must never render the same" rule, on the surface an operator reads to
      // find out whether a deployment registered any tool servers at all.
      await repo.record(snapshot({ id: `${ws}-none`, workspaceId: ws, executionId: e1 }))
      expect((await repo.listByExecution(ws, e1))[0]!.toolServers).toBeUndefined()
    })

    // --- the remote debugging surface's bounded index (`/api/v1/debug/*`) ---------------
    // The index exists precisely so a page of snapshots can never carry bodies (one row is
    // routinely megabytes). These assertions pin that: the SIZES must be right and the bodies
    // must be absent from the projection entirely.

    it('indexes snapshots by size, keyset-paged, without returning any body', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(
        snapshot({
          id: `${ws}-a`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 10,
          stepIndex: 0,
          systemPrompt: 'sys',
          userPrompt: 'a user prompt',
        }),
      )
      // Shares a millisecond with the next row — the tie a `created_at`-only cursor loses.
      await repo.record(
        snapshot({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20, stepIndex: 1 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20, stepIndex: 2 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-x`, workspaceId: ws, executionId: e2, createdAt: 99 }),
      )

      const first = await repo.listIndex(ws, { executionId: e1, limit: 2 })
      expect(first.map((r) => r.id)).toEqual([`${ws}-c`, `${ws}-b`])
      const last = first[first.length - 1]!
      const second = await repo.listIndex(ws, {
        executionId: e1,
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })
      expect(second.map((r) => r.id)).toEqual([`${ws}-a`])

      const oldest = second[0]!
      expect(oldest.systemPromptChars).toBe('sys'.length)
      expect(oldest.userPromptChars).toBe('a user prompt'.length)
      // The two JSON columns are MEASURED, not parsed — both stores must agree on the serialized
      // length, which is what a caller uses to decide whether a point read is worth it.
      expect(oldest.fragmentsChars).toBeGreaterThan(0)
      expect(oldest.contextFilesChars).toBeGreaterThan(0)
      expect(oldest.model).toBe('workers-ai:m')
      expect(oldest.harness).toBe('pi')
      // No body ever rides an index row.
      expect(Object.keys(oldest)).not.toContain('systemPrompt')
    })

    it("narrows the index to one step and counts a run's snapshots", async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(
        snapshot({ id: `${ws}-s0`, workspaceId: ws, executionId: e1, stepIndex: 0, createdAt: 10 }),
      )
      // A retried step records one snapshot per attempt — both must survive the narrowing.
      await repo.record(
        snapshot({
          id: `${ws}-s1a`,
          workspaceId: ws,
          executionId: e1,
          stepIndex: 1,
          createdAt: 20,
        }),
      )
      await repo.record(
        snapshot({
          id: `${ws}-s1b`,
          workspaceId: ws,
          executionId: e1,
          stepIndex: 1,
          createdAt: 30,
        }),
      )
      await repo.record(
        snapshot({ id: `${ws}-x`, workspaceId: ws, executionId: e2, createdAt: 40 }),
      )

      const step1 = await repo.listIndex(ws, { executionId: e1, limit: 10, stepIndex: 1 })
      expect(step1.map((r) => r.id)).toEqual([`${ws}-s1b`, `${ws}-s1a`])
      expect(await repo.countByExecution(ws, e1)).toBe(3)
      expect(await repo.countByExecution(ws, e2)).toBe(1)
      // A run with nothing captured counts 0 — which the overview reports differently from an
      // unwired sink, so it must not throw.
      expect(await repo.countByExecution(ws, 'exec-nothing')).toBe(0)
    })

    it("pages a run's snapshots WITH bodies on the same keyset the index walks", async () => {
      // The mothership-mode READ-THROUGH read (docs/initiatives/mothership-mode.md, PR 5): a
      // laptop rendering a run whose local rows were pruned drains this from the mothership.
      // It must page on the SAME `(createdAt, id)` composite as `listIndex` — a node that saw
      // one ordering in the index and another in the rows would silently skip a dispatch.
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(
        snapshot({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10, stepIndex: 0 }),
      )
      // Shares a millisecond with the next row — the tie a `created_at`-only cursor loses.
      await repo.record(
        snapshot({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 20, stepIndex: 1 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20, stepIndex: 1 }),
      )
      await repo.record(
        snapshot({ id: `${ws}-x`, workspaceId: ws, executionId: e2, createdAt: 99 }),
      )

      const first = await repo.listRunPage(ws, { executionId: e1, limit: 2 })
      expect(first.map((s) => s.id)).toEqual([`${ws}-c`, `${ws}-b`])
      // Unlike the index, the page carries the bodies — that is the whole point of the read.
      expect(first[0]?.systemPrompt).toBe('system')
      expect(first[0]?.contextFiles).toEqual([
        { path: 'rfc.md', title: 'RFC', url: 'https://x/rfc', content: 'full body' },
      ])
      const last = first[first.length - 1]!
      const second = await repo.listRunPage(ws, {
        executionId: e1,
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })
      expect(second.map((s) => s.id)).toEqual([`${ws}-a`])
      // Drained to exhaustion the page reproduces `listByExecution` exactly, which is the
      // property the read-through relies on to answer that method from the mothership.
      expect([...first, ...second].map((s) => s.id)).toEqual(
        (await repo.listByExecution(ws, e1)).map((s) => s.id),
      )
      // The step narrowing is the index's, applied to the same rows.
      const step1 = await repo.listRunPage(ws, { executionId: e1, limit: 10, stepIndex: 1 })
      expect(step1.map((s) => s.id)).toEqual([`${ws}-c`, `${ws}-b`])
      // Another run's snapshots never leak in, and an unknown run pages empty rather than throwing.
      expect(await repo.listRunPage(ws, { executionId: 'exec-nothing', limit: 10 })).toEqual([])
    })

    it('point-reads one snapshot with its bodies, scoped to its workspace', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        snapshot({ id: `${ws}-a`, workspaceId: ws, executionId: e1, systemPrompt: 'the system' }),
      )

      const found = await repo.get(ws, `${ws}-a`)
      expect(found?.systemPrompt).toBe('the system')
      expect(found?.fragments).toEqual([{ id: 'node-ts', body: 'use TypeScript' }])
      // A foreign workspace reads as missing, never as another tenant's snapshot.
      expect(await repo.get('ws-someone-else', `${ws}-a`)).toBeNull()
      expect(await repo.get(ws, 'acs_nope')).toBeNull()
    })

    it('batch-appends snapshots, ignoring ids it already stored', async () => {
      // The mothership-mode telemetry ingest (docs/initiatives/mothership-mode.md, PR 5) uploads a
      // finished run's snapshots through `recordMany` and RETRIES a chunk whose ack was lost, so
      // both halves are load-bearing: the batch must land whole, and re-offering it must be inert
      // rather than a duplicate-key failure that parks the run's upload forever.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      const batch = [
        snapshot({ id: `${ws}-1`, workspaceId: ws, executionId: e1, createdAt: 10 }),
        snapshot({ id: `${ws}-2`, workspaceId: ws, executionId: e1, createdAt: 20 }),
      ]
      await repo.recordMany(batch)
      expect((await repo.listByExecution(ws, e1)).map((s) => s.id)).toEqual([`${ws}-2`, `${ws}-1`])

      await repo.recordMany([
        // The already-stored row, with a DIFFERENT body: first write wins, so the stored prompt
        // must be untouched — an upsert here would rewrite history the reader already paged.
        snapshot({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 10,
          systemPrompt: 'rewritten',
        }),
        snapshot({ id: `${ws}-3`, workspaceId: ws, executionId: e1, createdAt: 30 }),
      ])
      const after = await repo.listByExecution(ws, e1)
      expect(after.map((s) => s.id)).toEqual([`${ws}-3`, `${ws}-2`, `${ws}-1`])
      expect(after.find((s) => s.id === `${ws}-1`)?.systemPrompt).toBe('system')

      // An empty batch is a no-op, never an error — the drain posts until a page comes back empty.
      await expect(repo.recordMany([])).resolves.toBeUndefined()
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
