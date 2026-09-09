import { describe, expect, it } from 'vitest'
import { answerFor, assistantSurface, revealTarget, submitGate } from './AssistantModal.logic'

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

describe('assistantSurface', () => {
  // The modal mounts only while the open flag is set, so its very first render happens with the
  // capability unread. That render may not be the prompt box: an unread capability has no examples
  // to list and nothing to submit against, and a box is a promise of both.
  it('waits rather than offering a box while the read has not answered', () => {
    expect(assistantSurface('unread', false)).toBe('reading')
    expect(assistantSurface('reading', false)).toBe('reading')
  })

  it('separates a FAILED read from a deployment that wired no model', () => {
    // Retrying is the answer to one and changes nothing about the other, so they cannot share a
    // state: `available` is false in both cases and says nothing about which one this is.
    expect(assistantSurface('failed', false)).toBe('unreadable')
    expect(assistantSurface('read', false)).toBe('unwired')
  })

  it('offers the box only once a read says a model is wired', () => {
    expect(assistantSurface('read', true)).toBe('ready')
  })

  it('never lets a stale availability outlive a failed re-read', () => {
    // The store drops the capability when a read fails, but the surface must refuse on its own
    // too: an `available` left over from the previous read would otherwise re-offer the box.
    expect(assistantSurface('failed', true)).toBe('unreadable')
  })
})

describe('submitGate', () => {
  it('sends a typed request', () => {
    expect(submitGate('the checkout service depends on payments', false, 2000)).toEqual({
      state: 'ready',
    })
  })

  it('names an empty box, whitespace included, as empty rather than ready', () => {
    expect(submitGate(' \t\n ', false, 2000)).toEqual({ state: 'empty' })
  })

  it('reports a turn in flight as running, not as a request with something wrong with it', () => {
    expect(submitGate('add https://example.test/acme/payments as a service', true, 2000)).toEqual({
      state: 'running',
    })
  })

  it('refuses an over-long request with both numbers, so the reason can be stated', () => {
    expect(submitGate('x'.repeat(2043), false, 2000)).toEqual({
      state: 'too_long',
      length: 2043,
      limit: 2000,
    })
  })

  it('measures the length the WIRE caps, which is the trimmed text', () => {
    // The schema trims before it counts, so a prompt padded to just over the cap is acceptable
    // and refusing it would be this surface inventing a limit the backend does not hold to.
    const padded = `  ${'x'.repeat(2000)}  `
    expect(submitGate(padded, false, 2000)).toEqual({ state: 'ready' })
  })
})
