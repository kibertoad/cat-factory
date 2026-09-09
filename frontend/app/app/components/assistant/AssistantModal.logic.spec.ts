import { describe, expect, it } from 'vitest'
import { revealTarget } from './AssistantModal.logic'

describe('revealTarget', () => {
  it('reveals the CONSUMER of a declared dependency, the frame the edge was written onto', () => {
    expect(
      revealTarget({
        actionId: 'declare-service-dependency',
        consumer: { blockId: 'f1', title: 'Checkout' },
        provider: { blockId: 'f2', title: 'Payments' },
        created: true,
      }),
    ).toBe('f1')
  })

  it('reveals the new service frame', () => {
    expect(
      revealTarget({
        actionId: 'add-service-from-repo',
        service: { blockId: 'f3', title: 'payments' },
        repo: { owner: 'acme', name: 'payments', directory: null },
        created: true,
      }),
    ).toBe('f3')
  })

  it('reveals the task, not the service it landed in', () => {
    expect(
      revealTarget({
        actionId: 'create-task-from-issue',
        task: { blockId: 't1', title: 'Card charges time out' },
        service: { blockId: 'f2', title: 'Payments' },
        issue: { source: 'github', externalId: 'acme/payments#12', url: 'https://example.test' },
      }),
    ).toBe('t1')
  })
})
