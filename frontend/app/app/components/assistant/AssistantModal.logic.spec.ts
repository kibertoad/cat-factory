import { describe, expect, it } from 'vitest'
import { answerFor, revealTarget } from './AssistantModal.logic'

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

describe('answerFor', () => {
  it('puts the chosen candidate in the field the platform named, keeping the rest', () => {
    expect(
      answerFor(
        {
          status: 'needs_input',
          actionId: 'declare-service-dependency',
          reason: 'ambiguous_service',
          field: 'consumer',
          candidates: ['Payments API', 'API Gateway'],
          arguments: { consumer: 'api', provider: 'Ledger', description: 'reads balances' },
        },
        'Payments API',
      ),
    ).toEqual({
      actionId: 'declare-service-dependency',
      arguments: {
        consumer: 'Payments API',
        provider: 'Ledger',
        description: 'reads balances',
      },
    })
  })

  it('answers a field the failed turn never resolved a value for', () => {
    // The ambiguous-tracker case: `source` is absent from the arguments precisely because the
    // request never named one, and the answer is what supplies it.
    expect(
      answerFor(
        {
          status: 'needs_input',
          actionId: 'create-task-from-issue',
          reason: 'ambiguous_issue_source',
          field: 'source',
          candidates: ['jira', 'linear'],
          arguments: { issueUrl: 'PROJ-12' },
        },
        'jira',
      ).arguments,
    ).toEqual({ issueUrl: 'PROJ-12', source: 'jira' })
  })
})
