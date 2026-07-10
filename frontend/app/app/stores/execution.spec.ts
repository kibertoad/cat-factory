import { describe, it, expect, beforeEach } from 'vitest'
import { useExecutionStore } from '~/stores/execution'
import type { ExecutionInstance } from '~/types/domain'

/**
 * Minimal instance shape — the `decisionsByBlock` / `approvalsByBlock` getters only read
 * `id`, `blockId` and each step's `{ decision, approval, agentKind }`, so a cast keeps the
 * fixtures focused on the grouping behaviour rather than the full wire contract.
 */
function instance(id: string, blockId: string, steps: unknown[]): ExecutionInstance {
  return { id, blockId, steps } as unknown as ExecutionInstance
}

describe('execution store gate grouping', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('decisionsByBlock groups open (unchosen) decisions by block', () => {
    store.hydrate(
      [
        instance('e1', 'b1', [
          { agentKind: 'coder', decision: { id: 'd1', chosen: null } },
          { agentKind: 'coder', decision: { id: 'd2', chosen: 'yes' } }, // chosen ⇒ excluded
        ]),
        instance('e2', 'b2', [{ agentKind: 'architect', decision: { id: 'd3', chosen: null } }]),
      ],
      'ws1',
    )
    expect(store.decisionsByBlock.get('b1')?.map((d) => d.decision.id)).toEqual(['d1'])
    expect(store.decisionsByBlock.get('b2')?.map((d) => d.decision.id)).toEqual(['d3'])
    expect(store.decisionsByBlock.has('missing')).toBe(false)
  })

  it('approvalsByBlock groups pending approvals by block', () => {
    store.hydrate(
      [
        instance('e1', 'b1', [
          { agentKind: 'merger', approval: { id: 'a1', status: 'pending' } },
          { agentKind: 'merger', approval: { id: 'a2', status: 'approved' } }, // not pending ⇒ excluded
        ]),
      ],
      'ws1',
    )
    expect(store.approvalsByBlock.get('b1')?.map((a) => a.approval.id)).toEqual(['a1'])
    expect(store.approvalsByBlock.get('b2')).toBeUndefined()
  })
})

/** A run fixture carrying the fields the reconcile guards read (`id`, `rev`, `status`). */
function run(id: string, rev: number, status: string): ExecutionInstance {
  return { id, blockId: `blk_${id}`, steps: [], status, rev } as unknown as ExecutionInstance
}

describe('execution store snapshot/event reconcile', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('a lagging snapshot cannot regress a run a live event already advanced (REGRESS)', () => {
    store.hydrate([run('e1', 3, 'running')], 'ws1')
    // Live event: the run reached a terminal state (rev 4). It emits nothing further.
    store.upsert(run('e1', 4, 'done'))
    // A snapshot read BEFORE the event resolves after it — same run at the older rev.
    store.hydrate([run('e1', 3, 'running')], 'ws1')
    expect(store.getInstance('e1')?.status).toBe('done')
  })

  it('keeps a live-added run a lagging snapshot never saw (DROP)', () => {
    store.hydrate([run('e1', 1, 'running')], 'ws1')
    store.upsert(run('e2', 1, 'running'))
    store.hydrate([run('e1', 2, 'running')], 'ws1') // stale read: predates e2
    expect(store.getInstance('e2')).toBeTruthy()
    expect(store.getInstance('e1')?.rev).toBe(2)
  })

  it('drops a superseded failed run when a retry replaces it under a new id (same block)', () => {
    // A failed run for a block is cached...
    store.hydrate(
      [{ id: 'e_old', blockId: 'b1', steps: [], status: 'failed', rev: 1 } as never],
      'ws1',
    )
    // ...then a retry mints a FRESH run (new id) for the SAME block and deletes the old one
    // server-side. The post-retry snapshot carries only the new running run.
    store.hydrate(
      [{ id: 'e_new', blockId: 'b1', steps: [], status: 'running', rev: 1 } as never],
      'ws1',
    )
    // The dead predecessor must not linger and shadow the running run in the by-block projection.
    expect(store.getInstance('e_old')).toBeUndefined()
    expect(store.getInstance('e_new')?.status).toBe('running')
    expect(store.getByBlock('b1')?.id).toBe('e_new')
  })

  it('keeps a live-added running run when a stale snapshot still lists its block predecessor', () => {
    // A retry already minted e_new (running) for b1 — a live event added it to the cache...
    store.hydrate(
      [{ id: 'e_new', blockId: 'b1', steps: [], status: 'running', rev: 1 } as never],
      'ws1',
    )
    // ...but a reconnect resync fetched BEFORE the retry resolves late (under load) and still
    // carries the now-deleted predecessor e_old (failed) for the same block.
    store.hydrate(
      [{ id: 'e_old', blockId: 'b1', steps: [], status: 'failed', rev: 1 } as never],
      'ws1',
    )
    // The live running run must survive — only a TERMINAL cached run is a superseded predecessor.
    expect(store.getInstance('e_new')?.status).toBe('running')
    expect(store.getByBlock('b1')?.id).toBe('e_new')
  })

  it('a workspace switch replaces the cache outright (no cross-board leak)', () => {
    store.hydrate([run('e1', 1, 'running')], 'ws1')
    store.upsert(run('e2', 1, 'running'))
    store.hydrate([run('e3', 1, 'running')], 'ws2')
    expect(store.getInstance('e1')).toBeUndefined()
    expect(store.getInstance('e2')).toBeUndefined()
    expect(store.getInstance('e3')).toBeTruthy()
  })

  it('an out-of-order live event cannot regress a newer cached run; same-rev replaces', () => {
    store.upsert(run('e1', 5, 'done'))
    store.upsert(run('e1', 4, 'running')) // stale event → ignored
    expect(store.getInstance('e1')?.status).toBe('done')
    store.upsert(run('e1', 5, 'failed')) // equal rev → latest event wins
    expect(store.getInstance('e1')?.status).toBe('failed')
  })

  it('treats a missing rev as 0 (legacy rows still hydrate)', () => {
    store.hydrate([{ id: 'e1', blockId: 'b1', steps: [], status: 'running' } as never], 'ws1')
    store.upsert(run('e1', 1, 'done'))
    expect(store.getInstance('e1')?.status).toBe('done')
  })
})

/** A run whose steps carry an (optional) per-step metrics rollup. */
function runWithMetrics(
  id: string,
  rev: number,
  steps: Array<{ agentKind: string; metrics?: { calls: number } | null }>,
): ExecutionInstance {
  return { id, blockId: `blk_${id}`, steps, status: 'running', rev } as unknown as ExecutionInstance
}

describe('execution store metrics preservation (live-only rollup)', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('a metric-less running-fold event does not blank the last-known step metrics', () => {
    // A step-boundary emit carried the rollup...
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    // ...a later progress-only fold (higher rev) omits it — the backend skips the rollup there.
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder' }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(3)
    expect(store.getInstance('e1')?.rev).toBe(2) // the fold still won (progress/subtasks applied)
  })

  it('a fresh rollup overrides the preserved value', () => {
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder' }])) // fold: preserved
    store.upsert(runWithMetrics('e1', 3, [{ agentKind: 'coder', metrics: { calls: 7 } }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(7)
  })

  it('does not carry metrics across a reshaped step (agentKind mismatch at the index)', () => {
    store.upsert(runWithMetrics('e1', 1, [{ agentKind: 'coder', metrics: { calls: 3 } }]))
    // A different kind at index 0 must not inherit the coder's rollup.
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'reviewer' }]))
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics).toBeUndefined()
  })

  it('preserves metrics through a lagging full refresh that omits them (hydrate)', () => {
    // Establish the workspace first (a fresh-workspace hydrate replaces outright by design).
    store.hydrate([runWithMetrics('e1', 1, [{ agentKind: 'coder' }])], 'ws1')
    store.upsert(runWithMetrics('e1', 2, [{ agentKind: 'coder', metrics: { calls: 5 } }]))
    // A snapshot never carries metrics (never persisted); a same-rev refresh must not blank it.
    store.hydrate([runWithMetrics('e1', 2, [{ agentKind: 'coder' }])], 'ws1')
    const step = store.getInstance('e1')!.steps[0] as unknown as { metrics?: { calls: number } }
    expect(step.metrics?.calls).toBe(5)
  })
})
