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
    store.hydrate([
      instance('e1', 'b1', [
        { agentKind: 'coder', decision: { id: 'd1', chosen: null } },
        { agentKind: 'coder', decision: { id: 'd2', chosen: 'yes' } }, // chosen ⇒ excluded
      ]),
      instance('e2', 'b2', [{ agentKind: 'architect', decision: { id: 'd3', chosen: null } }]),
    ])
    expect(store.decisionsByBlock.get('b1')?.map((d) => d.decision.id)).toEqual(['d1'])
    expect(store.decisionsByBlock.get('b2')?.map((d) => d.decision.id)).toEqual(['d3'])
    expect(store.decisionsByBlock.has('missing')).toBe(false)
  })

  it('approvalsByBlock groups pending approvals by block', () => {
    store.hydrate([
      instance('e1', 'b1', [
        { agentKind: 'merger', approval: { id: 'a1', status: 'pending' } },
        { agentKind: 'merger', approval: { id: 'a2', status: 'approved' } }, // not pending ⇒ excluded
      ]),
    ])
    expect(store.approvalsByBlock.get('b1')?.map((a) => a.approval.id)).toEqual(['a1'])
    expect(store.approvalsByBlock.get('b2')).toBeUndefined()
  })
})
