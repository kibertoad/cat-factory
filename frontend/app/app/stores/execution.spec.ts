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
      new Set(['b1', 'b2']),
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
      new Set(['b1']),
    )
    expect(store.approvalsByBlock.get('b1')?.map((a) => a.approval.id)).toEqual(['a1'])
    expect(store.approvalsByBlock.get('b2')).toBeUndefined()
  })
})

/** Run fixture for the reconcile tests — `rev`/`status` are what hydrate/upsert compare. */
function run(id: string, blockId: string, rev: number, status: string): ExecutionInstance {
  return { id, blockId, rev, status, steps: [] } as unknown as ExecutionInstance
}

describe('execution store snapshot/live-event reconciliation', () => {
  let store: ReturnType<typeof useExecutionStore>
  beforeEach(() => {
    store = useExecutionStore()
  })

  it('hydrate keeps a run a newer live event already advanced (REGRESS guard)', () => {
    // Live event lands while a (stale) snapshot fetch is in flight…
    store.upsert(run('e1', 'b1', 5, 'failed'))
    // …then the older snapshot resolves. It must not revert the run to `running`.
    store.hydrate([run('e1', 'b1', 3, 'running')], new Set(['b1']))
    expect(store.getInstance('e1')?.status).toBe('failed')
  })

  it('hydrate takes the snapshot version when it is at least as new', () => {
    store.upsert(run('e1', 'b1', 3, 'running'))
    store.hydrate([run('e1', 'b1', 6, 'done')], new Set(['b1']))
    expect(store.getInstance('e1')?.status).toBe('done')
  })

  it('hydrate preserves a live-added run the older snapshot never saw (DROP guard)', () => {
    store.upsert(run('e-new', 'b1', 1, 'running'))
    store.hydrate([], new Set(['b1']))
    expect(store.getInstance('e-new')?.status).toBe('running')
  })

  it("hydrate discards a previous board's runs on a workspace switch", () => {
    store.upsert(run('e-old', 'b-other-board', 1, 'running'))
    store.hydrate([run('e1', 'b1', 1, 'running')], new Set(['b1']))
    expect(store.getInstance('e-old')).toBeUndefined()
    expect(store.getInstance('e1')).toBeDefined()
  })

  it('upsert never regresses a run below its cached rev', () => {
    store.upsert(run('e1', 'b1', 5, 'failed'))
    store.upsert(run('e1', 'b1', 4, 'running')) // stale/out-of-order event
    expect(store.getInstance('e1')?.status).toBe('failed')
    store.upsert(run('e1', 'b1', 6, 'done'))
    expect(store.getInstance('e1')?.status).toBe('done')
  })
})
