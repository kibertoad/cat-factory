import type {
  CatFactoryClient,
  PublicClarityDecision,
  PublicDecision,
  PublicDecisionList,
  PublicFollowUpItem,
  PublicFollowUpsDecision,
  PublicReviewFinding,
} from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import {
  answerDecisions,
  clarityCapReached,
  isActionable,
  unexpectedDecision,
} from './decisions.js'

// This module decides what an UNATTENDED pass is allowed to settle, so both of its failure modes
// are silent: answering something a person was meant to answer still ends the run `done`, and
// answering something already in flight races the driver while the suite records having answered
// the gate. Neither shows up as a red test anywhere else, which is why the rules are pinned here
// against a recording client rather than exercised only against a live deployment.

type Call = { method: string; args: readonly unknown[] }

/** Records every call and answers with an empty list, which is all the answering path reads. */
function recordingClient(): { client: CatFactoryClient; calls: Call[] } {
  const calls: Call[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(emptyList())
    }
  const decisions = {
    answerFollowUp: record('answerFollowUp'),
    dismissFollowUp: record('dismissFollowUp'),
    replyToClarityFinding: record('replyToClarityFinding'),
    incorporateClarity: record('incorporateClarity'),
    proceedClarity: record('proceedClarity'),
  }
  return { client: { decisions } as unknown as CatFactoryClient, calls }
}

function emptyList(): PublicDecisionList {
  return { decisions: [], unanswerable: [] } as unknown as PublicDecisionList
}

function list(...decisions: PublicDecision[]): PublicDecisionList {
  return { decisions, unanswerable: [] } as unknown as PublicDecisionList
}

function finding(itemId: string, status: PublicReviewFinding['status']): PublicReviewFinding {
  return {
    itemId,
    category: 'question',
    severity: 'high',
    title: 'which page is first',
    detail: 'is the first page 0 or 1',
    status,
    reply: null,
  }
}

function clarity(
  status: PublicClarityDecision['status'],
  findings: PublicReviewFinding[] = [],
): PublicClarityDecision {
  return {
    kind: 'clarity-review',
    reviewId: 'rev_1',
    taskId: 'blk_1',
    status,
    iteration: 1,
    maxIterations: 3,
    findings,
    clarifiedReport: null,
  }
}

function item(
  itemId: string,
  kind: PublicFollowUpItem['kind'],
  status: PublicFollowUpItem['status'],
): PublicFollowUpItem {
  return {
    itemId,
    kind,
    status,
    title: 'share the pagination helper',
    detail: 'the pagination helper could be shared',
    answer: null,
    sendBackDropped: false,
    suggestedAction: null,
    ticketExternalId: null,
    ticketUrl: null,
  }
}

function followUps(...items: PublicFollowUpItem[]): PublicFollowUpsDecision {
  return { kind: 'follow-ups', items, loops: 1, maxLoops: 2, stepIndex: 3, stepKind: 'coder' }
}

const OPTIONS = { runId: 'run_1', steer: 'I only know what I saw in the browser.' }

const answer = (client: CatFactoryClient, decisions: PublicDecisionList) =>
  answerDecisions({ client, ...OPTIONS }, decisions)

describe('isActionable', () => {
  it('withholds a clarity review the driver is still working on', () => {
    // The whole finding this module was rewritten around. `incorporating` and `reviewing` stay
    // LISTED so a poller can see answers in flight, and reading "listed" as "answer me" waives
    // the gate one poll after answering it, mid-incorporation, with the run still ending `done`.
    for (const status of ['incorporating', 'reviewing', 'merged', 'incorporated'] as const) {
      expect(isActionable(clarity(status, [finding('itm_1', 'open')])), status).toBe(false)
    }
  })

  it('claims a clarity review that has stopped on a human, open findings or not', () => {
    expect(isActionable(clarity('ready'))).toBe(true)
    expect(isActionable(clarity('exceeded'))).toBe(true)
  })

  it('withholds a follow-up set whose every item is settled', () => {
    expect(isActionable(followUps(item('itm_1', 'follow_up', 'dismissed')))).toBe(false)
  })

  it('claims every kind the suite REFUSES, so the refusal fires instead of being waited out', () => {
    // A kind with no designed answer must reach the refusal immediately. Treating it as "not for
    // me" would sit on it until the run's whole budget expired and then report a timeout, hiding
    // the unexpected park that is the actual finding.
    expect(isActionable({ kind: 'pr-review' } as unknown as PublicDecision)).toBe(true)
  })
})

describe('answerDecisions', () => {
  it('answers a `ready` review by replying to each open finding and folding them in', async () => {
    const { client, calls } = recordingClient()
    const answered = await answer(
      client,
      list(clarity('ready', [finding('itm_1', 'open'), finding('itm_2', 'dismissed')])),
    )

    expect(calls.map((call) => call.method)).toEqual([
      'replyToClarityFinding',
      'incorporateClarity',
    ])
    expect(calls[0]?.args[1]).toBe('itm_1')
    expect(answered[0]?.actions).toHaveLength(2)
  })

  it('never touches a review it does not own, even beside one it does', async () => {
    // The race in its narrowest form: the incorporation the suite just asked for is in flight and
    // a follow-up set is answerable in the same list. Answering the second must not push the first.
    const { client, calls } = recordingClient()
    await answer(
      client,
      list(
        clarity('incorporating', [finding('itm_1', 'answered')]),
        followUps(item('itm_9', 'follow_up', 'pending')),
      ),
    )
    expect(calls.map((call) => call.method)).toEqual(['dismissFollowUp'])
  })

  it('proceeds only on a `ready` review with nothing outstanding', async () => {
    const { client, calls } = recordingClient()
    await answer(client, list(clarity('ready')))
    expect(calls.map((call) => call.method)).toEqual(['proceedClarity'])
  })

  it('refuses a review parked at its iteration cap rather than choosing for a person', async () => {
    // `exceeded` parks on a human like `ready` does, and the choice (another round, proceed on the
    // last report, stop and reset) is exactly the kind this module exists not to make unattended.
    const { client, calls } = recordingClient()
    await expect(
      answer(client, list(clarity('exceeded', [finding('itm_1', 'open')]))),
    ).rejects.toThrow(/resolve-exceeded/)
    expect(calls).toEqual([])
  })

  it('dismisses a follow-up, answers a question, and leaves settled items alone', async () => {
    const { client, calls } = recordingClient()
    await answer(
      client,
      list(
        followUps(
          item('itm_1', 'follow_up', 'pending'),
          item('itm_2', 'question', 'pending'),
          item('itm_3', 'follow_up', 'dismissed'),
        ),
      ),
    )
    expect(calls.map((call) => `${call.method} ${String(call.args[1])}`)).toEqual([
      'dismissFollowUp itm_1',
      'answerFollowUp itm_2',
    ])
  })

  it('refuses a kind it was not designed for, without answering anything else first', async () => {
    const { client, calls } = recordingClient()
    const unplanned = { kind: 'fork', stepKind: 'coder' } as unknown as PublicDecision
    await expect(
      answer(client, list(unplanned, followUps(item('itm_1', 'follow_up', 'pending')))),
    ).rejects.toThrow(/'fork'/)
    expect(calls).toEqual([])
  })
})

describe('unexpectedDecision', () => {
  it('names the kind and the step that raised it', () => {
    // The message an operator reads when a pipeline changes shape under the suite. Without the
    // step it sends them to the SPA to find out what the run already knew.
    const message = unexpectedDecision({
      kind: 'judge',
      stepKind: 'reviewer',
    } as unknown as PublicDecision)
    expect(message).toContain("'judge'")
    expect(message).toContain("'reviewer'")
  })
})

describe('clarityCapReached', () => {
  it('names the budget it exhausted and every way a person can settle it', () => {
    // Stopping is only useful if the message says what the three choices are: the operator reading
    // it is being asked to make the call the suite refused to make for them.
    const message = clarityCapReached(clarity('exceeded'))
    expect(message).toContain('3 reviewer pass(es)')
    expect(message).toContain('resolve-exceeded')
    expect(message).toContain('stop and reset')
  })
})
