// Answering, driven directly against a recording invoker.
//
// The end-to-end spec proves the same flow through real workerd and a real Cap'n Web client; this
// file exists for the cases that are about the FLOW's judgement rather than the transport: which
// park it picks, when it refuses to pick, and which of the three outcomes it reports. Those are
// hard to vary end to end (each needs its own scripted run) and trivial to vary here.

import { describe, expect, it } from 'vitest'
import { answerCard, type DecisionListShape } from '../src/approvals'
import { GatekeeperError } from '../src/errors'
import type { ApprovalCard } from '../src/state'

const CARD: ApprovalCard = {
  cardId: 'ntf_1',
  runId: 'exec_9',
  taskId: 'blk_4',
  type: 'decision_required',
  disposition: 'decision',
  title: 'A step needs approval',
  body: '…',
  raisedAt: 1,
  resolvedAt: null,
  resolution: null,
}

function gate(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'approval-gate',
    approvalId: 'ap_1',
    status: 'pending',
    exceeded: false,
    recordedApprovals: 0,
    requiredApprovals: 1,
    ...overrides,
  }
}

function list(overrides: Partial<DecisionListShape> = {}): DecisionListShape {
  return { parked: true, status: 'blocked', decisions: [], unanswerable: [], ...overrides }
}

/** An invoker that answers `before` to the read and `after` to the action, recording both. */
function scripted(before: DecisionListShape, after: DecisionListShape = before) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const invoke = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    return name === 'decisions_list' ? before : after
  }
  return { calls, invoke }
}

describe('picking the park to answer', () => {
  it('answers the one park holding the run', async () => {
    const { calls, invoke } = scripted(list({ decisions: [gate()] }), list({ parked: false }))
    const outcome = await answerCard(CARD, { action: 'approve' }, invoke)

    expect(outcome).toMatchObject({ status: 'answered', kind: 'approval-gate', action: 'approve' })
    expect(calls.map((call) => call.name)).toEqual(['decisions_list', 'decisions_approve_step'])
    expect(calls[1]?.args).toMatchObject({ runId: 'exec_9', approvalId: 'ap_1' })
  })

  // The platform lists parks in a SHAPE order, not a priority order, so answering the first would
  // settle whichever the projection happened to build first. A run genuinely can hold two: a
  // follow-up triage accrues while a later step's gate is open.
  it('refuses to guess when the run holds two parks, naming both', async () => {
    const both = list({
      decisions: [{ kind: 'follow-ups', items: [{ status: 'pending' }] }, gate()],
    })
    const { invoke } = scripted(both)
    await expect(answerCard(CARD, { action: 'approve' }, invoke)).rejects.toThrow(
      /parked on 2 decisions/,
    )
  })

  it('answers the named park when the caller disambiguates', async () => {
    const both = list({
      decisions: [{ kind: 'follow-ups', items: [{ status: 'pending' }] }, gate()],
    })
    const { calls, invoke } = scripted(both, list({ parked: false }))
    const outcome = await answerCard(CARD, { action: 'approve', kind: 'approval-gate' }, invoke)
    expect(outcome.status).toBe('answered')
    expect(calls[1]?.name).toBe('decisions_approve_step')
  })

  it('refuses a kind the run does not hold, naming what it does', async () => {
    const { invoke } = scripted(list({ decisions: [gate()] }))
    await expect(answerCard(CARD, { action: 'choose', kind: 'fork' }, invoke)).rejects.toThrow(
      /no pending 'fork' decision.*'approval-gate'/s,
    )
  })

  it('refuses a verb the park does not take, naming the ones it does', async () => {
    const { invoke } = scripted(list({ decisions: [gate()] }))
    await expect(answerCard(CARD, { action: 'choose' }, invoke)).rejects.toThrow(
      /does not take 'choose'.*'approve'/s,
    )
  })
})

describe('the three outcomes', () => {
  // The trap the platform documents: an approve under an unmet quorum returns 200, records a vote,
  // and leaves the run parked. What decides the outcome is the RUN's state after, never the
  // action's own status code.
  it('reports an approval short of quorum as recorded, in the run’s own numbers', async () => {
    const before = list({ decisions: [gate({ requiredApprovals: 2 })] })
    const after = list({ decisions: [gate({ requiredApprovals: 2, recordedApprovals: 1 })] })
    const { invoke } = scripted(before, after)

    expect(await answerCard(CARD, { action: 'approve' }, invoke)).toMatchObject({
      status: 'recorded',
      detail: '1 of 2 approvals recorded; the gate still needs the rest.',
    })
  })

  // A reply is recorded and folded in by a later incorporation, so the review still holds the run.
  // Reporting that as `answered` would have the card settled with the loop still waiting.
  it('reports a recorded reply on an iterative review as recorded', async () => {
    const review = {
      kind: 'requirements-review',
      status: 'ready',
      iteration: 2,
      maxIterations: 3,
      findings: [],
    }
    const { calls, invoke } = scripted(list({ decisions: [review] }))
    const outcome = await answerCard(
      CARD,
      { action: 'reply', itemId: 'ri_1', reply: 'Postgres.' },
      invoke,
    )

    expect(outcome).toMatchObject({ status: 'recorded', kind: 'requirements-review' })
    expect(calls[1]).toMatchObject({
      name: 'decisions_reply_to_finding',
      args: { runId: 'exec_9', itemId: 'ri_1', body: { reply: 'Postgres.' } },
    })
  })

  it('quotes the run’s own unanswerable wait when nothing is answerable', async () => {
    const { invoke } = scripted(
      list({
        parked: false,
        status: 'done',
        unanswerable: [{ reason: 'human_wait_gate', detail: 'A reviewer has to approve the PR.' }],
      }),
    )
    expect(await answerCard(CARD, { action: 'approve' }, invoke)).toMatchObject({
      status: 'stale',
      detail: 'human_wait_gate: A reviewer has to approve the PR.',
    })
  })

  // A deployment ahead of this package parks on something it cannot model. "The run moved on" and
  // "I do not know this park" send an operator to opposite places, so they are different sentences.
  it('distinguishes a park it cannot model from a run that moved on', async () => {
    const unknown = scripted(list({ decisions: [{ kind: 'quantum-review', status: 'pending' }] }))
    await expect(answerCard(CARD, { action: 'approve' }, unknown.invoke)).resolves.toMatchObject({
      status: 'stale',
      detail: expect.stringContaining("parked on 'quantum-review'"),
    })

    const moved = scripted(list({ parked: false, status: 'done' }))
    await expect(answerCard(CARD, { action: 'approve' }, moved.invoke)).resolves.toMatchObject({
      detail: expect.stringContaining('holds no parked decision'),
    })
  })

  // A gate the SPA answered while the card sat in the inbox is PRESENT in the list and settled.
  // Answering the first entry of a matching kind would post against a decision that is over.
  it('does not answer a settled entry of an answerable kind', async () => {
    const { calls, invoke } = scripted(list({ decisions: [gate({ status: 'approved' })] }))
    expect((await answerCard(CARD, { action: 'approve' }, invoke)).status).toBe('stale')
    expect(calls.map((call) => call.name)).toEqual(['decisions_list'])
  })
})

describe('what the flow never does', () => {
  // `invoke` carries the policy check, so the answer flow gets no privilege of its own: a tier
  // that was not granted the operation is refused on the way through, unchanged.
  it('lets a refusal from the granted-binding check through unaltered', async () => {
    const invoke = async (name: string) => {
      if (name === 'decisions_list') return list({ decisions: [gate()] })
      throw new GatekeeperError('binding_not_granted', "Tier 'operator' does not grant it.")
    }
    await expect(answerCard(CARD, { action: 'approve' }, invoke)).rejects.toThrow(/does not grant/)
  })
})
