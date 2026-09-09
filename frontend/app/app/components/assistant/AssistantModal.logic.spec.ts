import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { ASSISTANT_PROMPT_MAX, assistantTurnInputSchema } from '@cat-factory/contracts'
import type { AssistantCapability } from '~/types/domain'
import { answerFor, assistantSurface, revealTarget, submitGate } from './AssistantModal.logic'

/** A capability that answered. The two halves are independent, so each case states both. */
function answered(
  available: boolean,
  actions: AssistantCapability['actions'] = ['declare-service-dependency'],
): AssistantCapability {
  return { available, actions }
}

const WIRED = answered(true)

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
  it('shows the BOX while the read is still in flight, rather than a spinner in its place', () => {
    // The modal is opened from the sidebar and from the command palette, so the hands are already
    // on the keyboard. A box that only mounts once the read lands is not focused yet, and every
    // character typed in the gap is dropped; refusing the SUBMIT is what the unanswered read owes,
    // not withholding the thing being typed into.
    expect(assistantSurface('idle', null)).toBe('prompt')
    expect(assistantSurface('loading', null)).toBe('prompt')
  })

  it('separates a FAILED read from a deployment that wired no model', () => {
    // Retrying is the answer to one and changes nothing about the other, so they cannot share a
    // state: neither one can submit, and that is all they have in common.
    expect(assistantSurface('error', null)).toBe('unreadable')
    expect(assistantSurface('ready', answered(false))).toBe('unwired')
  })

  it('withholds the box from a wired model with an EMPTY catalog', () => {
    // `available` and `actions` are two independent facts and only the pair decides. A model with
    // nothing to route to renders a box over an empty examples list whose every submit is refused
    // with `assistant_no_actions`, which is the surface this exists to stop offering.
    expect(assistantSurface('ready', answered(true, []))).toBe('no_actions')
  })

  it('offers the box once a read says a model is wired and the catalog has something in it', () => {
    expect(assistantSurface('ready', WIRED)).toBe('prompt')
  })

  it('keeps the answer it holds while a RE-read is in flight', () => {
    // Re-opening the modal re-reads the capability. Dropping back to a waiting state for a fact
    // already held would replace the box with a spinner on every open, and take the focus and any
    // half-typed request with it.
    expect(assistantSurface('loading', WIRED)).toBe('prompt')
    expect(assistantSurface('loading', answered(false))).toBe('unwired')
  })
})

describe('submitGate', () => {
  const ready = { prompt: 'the checkout service depends on payments', running: false }

  it('sends a typed request against a capability that answered', () => {
    expect(submitGate({ read: 'ready', capability: WIRED, ...ready })).toEqual({ state: 'ready' })
  })

  it('names an empty box, whitespace included, as empty rather than ready', () => {
    expect(
      submitGate({ read: 'ready', capability: WIRED, prompt: ' \t\n ', running: false }),
    ).toEqual({ state: 'empty' })
  })

  it('reports a turn in flight as running, not as a request with something wrong with it', () => {
    expect(submitGate({ read: 'ready', capability: WIRED, ...ready, running: true })).toEqual({
      state: 'running',
    })
  })

  it('states the WAIT while the capability read has not answered', () => {
    // The box is offered during the read, so its Run button is disabled for a reason that is
    // nobody's mistake and clears itself. Left unstated it reads as a button that is broken.
    expect(submitGate({ read: 'loading', capability: null, ...ready })).toEqual({
      state: 'checking',
    })
  })

  it('refuses on a capability that answered it cannot submit, whichever half said so', () => {
    // Unreachable from the modal, which renders no box for these. It is asserted because this is
    // the submit AUTHORITY: a later caller reading only the prompt would submit into a 503.
    expect(submitGate({ read: 'ready', capability: answered(false), ...ready })).toEqual({
      state: 'unavailable',
    })
    expect(submitGate({ read: 'ready', capability: answered(true, []), ...ready })).toEqual({
      state: 'unavailable',
    })
    expect(submitGate({ read: 'error', capability: null, ...ready })).toEqual({
      state: 'unavailable',
    })
  })

  it('refuses an over-long request with both numbers, so the reason can be stated', () => {
    const length = ASSISTANT_PROMPT_MAX + 43
    expect(
      submitGate({ read: 'ready', capability: WIRED, prompt: 'x'.repeat(length), running: false }),
    ).toEqual({ state: 'too_long', length, limit: ASSISTANT_PROMPT_MAX })
  })

  it('measures the length the WIRE caps, which is the trimmed text', () => {
    // The schema trims before it counts, so a prompt padded to just over the cap is acceptable
    // and refusing it would be this surface inventing a limit the backend does not hold to.
    const padded = `  ${'x'.repeat(ASSISTANT_PROMPT_MAX)}  `
    expect(
      submitGate({ read: 'ready', capability: WIRED, prompt: padded, running: false }),
    ).toEqual({ state: 'ready' })
  })

  it('refuses at exactly the length the WIRE SCHEMA refuses at', () => {
    // The one invariant the box's whole reason for stating a number rests on, and the one a test
    // pinning a literal cannot see: both sides are asked here, so a cap moved on either side and
    // not the other fails rather than shipping a box that promises a limit the backend does not
    // hold to (or refuses one it would have taken).
    const accepted = (prompt: string) =>
      v.safeParse(assistantTurnInputSchema, { kind: 'prompt', prompt }).success
    const at = 'x'.repeat(ASSISTANT_PROMPT_MAX)
    const over = 'x'.repeat(ASSISTANT_PROMPT_MAX + 1)

    expect(submitGate({ read: 'ready', capability: WIRED, prompt: at, running: false })).toEqual({
      state: 'ready',
    })
    expect(accepted(at)).toBe(true)
    expect(
      submitGate({ read: 'ready', capability: WIRED, prompt: over, running: false }).state,
    ).toBe('too_long')
    expect(accepted(over)).toBe(false)
  })
})
