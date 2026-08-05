import { describe, expect, it, vi } from 'vitest'
import type {
  RequirementReview,
  ReviewReplyAck,
  RequirementReviewItem,
  TrackerCommentEvent,
  TrackerCommentIngestRepository,
  TrackerIssueEvent,
} from '@cat-factory/kernel'
import { TrackerWebhookService, type ReviewReplyGateway } from './TrackerWebhookService.js'
import { renderReviewReplyAck } from '../writeback/reviewReplies.logic.js'

// The runtime-neutral half of tracker-webhook handling. The cross-runtime conformance suite pins
// that both facades WIRE this (receiver → gateway → service → the SPA's own review methods); these
// tests pin what it DECIDES, which has no runtime dimension — most importantly the D6 loop policy
// (a fully-answered review auto-incorporates) that conformance deliberately cannot reach, because
// incorporation calls a real model no test harness has.

const item = (id: string, over: Partial<RequirementReviewItem> = {}): RequirementReviewItem => ({
  id,
  category: 'gap',
  severity: 'high',
  title: `Finding ${id}`,
  detail: 'detail',
  status: 'open',
  reply: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const review = (items: RequirementReviewItem[], over: Partial<RequirementReview> = {}) =>
  ({
    id: 'rrv_1',
    blockId: 'blk_1',
    status: 'ready',
    items,
    model: 'fake:fake',
    incorporatedRequirements: null,
    iteration: 1,
    maxIterations: 3,
    recommendations: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as RequirementReview

/** A gateway whose mutations update an in-memory review, so the service sees its own effects. */
function makeGateway(initial: RequirementReview) {
  let current = initial
  const calls: string[] = []
  const gateway: ReviewReplyGateway = {
    getForBlock: async () => current,
    replyToItem: async (_ws, _reviewId, itemId, reply) => {
      calls.push(`reply:${itemId}`)
      current = {
        ...current,
        items: current.items.map((i) =>
          i.id === itemId ? { ...i, reply, status: 'answered' as const } : i,
        ),
      }
      return current
    },
    setItemStatus: async (_ws, _reviewId, itemId, status) => {
      calls.push(`status:${itemId}:${status}`)
      current = {
        ...current,
        items: current.items.map((i) => (i.id === itemId ? { ...i, status } : i)),
      }
      return current
    },
    incorporate: async () => {
      calls.push('incorporate')
      current = { ...current, status: 'incorporating' }
      return current
    },
    proceed: async () => {
      calls.push('proceed')
      current = { ...current, status: 'incorporated' }
      return current
    },
    resolveExceeded: async (_ws, _blockId, choice) => {
      calls.push(`resolveExceeded:${choice}`)
      return current
    },
  }
  return { gateway, calls, get: () => current }
}

/** An always-granting ingest marker store — claim semantics have their own parity suite. */
function makeMarkers(): TrackerCommentIngestRepository & { claims: number } {
  const store = {
    claims: 0,
    async claim() {
      store.claims += 1
      return true
    },
    async settle() {},
    async get() {
      return null
    },
  }
  return store
}

function makeService(
  gateway: ReviewReplyGateway,
  over: Partial<ConstructorParameters<typeof TrackerWebhookService>[0]> = {},
) {
  return new TrackerWebhookService({
    taskRepository: {
      get: async () => ({ linkedBlockId: 'blk_1' }),
    } as never,
    taskConnectionRepository: {
      getByWorkspace: async () => ({ credentials: {} }),
    } as never,
    reviewGateways: { requirements: gateway },
    commentIngestRepository: makeMarkers(),
    ...over,
  })
}

/**
 * The `postReviewReplyAck` shape, spelled out so `vi.fn` infers three parameters. A bare
 * `async () => {}` infers ZERO, which makes `ack.mock.calls[0][2]` an index into an empty tuple.
 */
const makeAckSpy = async (
  _workspaceId: string,
  _issue: { source: string; externalId: string },
  _ack: ReviewReplyAck,
): Promise<void> => {}

const comment = (body: string, over: Partial<TrackerCommentEvent> = {}): TrackerCommentEvent => ({
  kind: 'comment',
  source: 'jira',
  externalId: 'ENG-1',
  commentId: 'c-1',
  body,
  author: { id: 'u1', handle: 'reporter', email: 'r@acme.test', bot: false },
  ...over,
})

describe('TrackerWebhookService — ticket replies', () => {
  it('auto-incorporates once nothing is left open (the D6 default)', async () => {
    // The property that makes the ticket a COMPLETE surface: a reporter who answered everything
    // should not also have to know to press a button somewhere they have never been.
    const { gateway, calls } = makeGateway(review([item('a'), item('b')]))
    const service = makeService(gateway)
    const outcome = await service.handle(
      'ws1',
      comment(['@cat-factory answer a first', '@cat-factory dismiss b'].join('\n')),
    )
    expect(calls).toEqual(['reply:a', 'status:b:dismissed', 'incorporate'])
    expect(outcome).toEqual({ kind: 'reply', outcome: 'incorporating' })
  })

  it('records answers WITHOUT incorporating while a finding is still open', async () => {
    const { gateway, calls } = makeGateway(review([item('a'), item('b')]))
    const service = makeService(gateway)
    const outcome = await service.handle('ws1', comment('@cat-factory answer a first'))
    expect(calls).toEqual(['reply:a'])
    expect(outcome).toEqual({ kind: 'reply', outcome: 'awaiting' })
  })

  it('reports an unknown finding id rather than applying it somewhere', async () => {
    const { gateway, calls } = makeGateway(review([item('a')]))
    const service = makeService(gateway)
    const ack = vi.fn(makeAckSpy)
    const withAck = makeService(gateway, { issueWriteback: { postReviewReplyAck: ack } })
    await withAck.handle('ws1', comment('@cat-factory answer nope hello'))
    expect(calls).toEqual([])
    expect(ack.mock.calls[0]?.[2]).toMatchObject({
      outcome: 'awaiting',
      answered: [],
      rejected: [{ reason: expect.stringContaining('no finding') }],
    })
    expect(service).toBeDefined()
  })

  it('rejects an empty answer instead of storing one', async () => {
    const { gateway, calls } = makeGateway(review([item('a')]))
    const ack = vi.fn(makeAckSpy)
    await makeService(gateway, { issueWriteback: { postReviewReplyAck: ack } }).handle(
      'ws1',
      comment('@cat-factory answer a'),
    )
    expect(calls).toEqual([])
    expect(ack.mock.calls[0]?.[2]).toMatchObject({
      rejected: [{ reason: 'the answer was empty' }],
    })
  })

  it('scrubs a secret out of an answer before it is persisted', async () => {
    // The answer becomes `item.reply`, which downstream feeds a model and is re-rendered onto a
    // public issue. A token pasted into a ticket must not survive either trip.
    const { gateway } = makeGateway(review([item('a'), item('b')]))
    const service = makeService(gateway)
    await service.handle(
      'ws1',
      comment('@cat-factory answer a use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    )
    const stored = gateway.getForBlock ? await gateway.getForBlock('ws1', 'blk_1') : null
    expect(stored?.items[0]?.reply).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(service).toBeDefined()
  })

  it('maps `proceed` to the ordinary proceed outside the cap, and to the choice at it', async () => {
    const open = makeGateway(review([item('a')]))
    await makeService(open.gateway).handle('ws1', comment('@cat-factory proceed'))
    expect(open.calls).toEqual(['proceed'])

    const capped = makeGateway(review([item('a')], { status: 'exceeded' }))
    await makeService(capped.gateway).handle('ws1', comment('@cat-factory proceed'))
    expect(capped.calls).toEqual(['resolveExceeded:proceed'])
  })

  it('refuses `stop` / `extra-round` outside the iteration cap', async () => {
    // Those two exist only as cap choices; accepting them earlier would let a ticket comment cancel
    // a run that nobody said was stuck.
    const { gateway, calls } = makeGateway(review([item('a')]))
    const ack = vi.fn(makeAckSpy)
    await makeService(gateway, { issueWriteback: { postReviewReplyAck: ack } }).handle(
      'ws1',
      comment('@cat-factory stop'),
    )
    expect(calls).toEqual([])
    expect(ack.mock.calls[0]?.[2]).toMatchObject({
      rejected: [{ reason: expect.stringContaining('iteration budget') }],
    })
  })

  it('applies nothing to a SETTLED review but still says so', async () => {
    const { gateway, calls } = makeGateway(review([item('a')], { status: 'incorporated' }))
    const ack = vi.fn(makeAckSpy)
    const outcome = await makeService(gateway, {
      issueWriteback: { postReviewReplyAck: ack },
    }).handle('ws1', comment('@cat-factory answer a too late'))
    expect(calls).toEqual([])
    expect(outcome).toEqual({ kind: 'reply', outcome: 'settled' })
    expect(ack.mock.calls[0]?.[2]).toMatchObject({ outcome: 'settled' })
  })

  it('drops an unauthorized author SILENTLY — no state change and NO acknowledgement', async () => {
    // Replying would confirm the hook exists and hand an attacker an oracle (D7).
    const { gateway, calls } = makeGateway(review([item('a')]))
    const ack = vi.fn(makeAckSpy)
    const service = makeService(gateway, {
      issueWriteback: { postReviewReplyAck: ack },
      taskConnectionRepository: {
        getByWorkspace: async () => ({ credentials: { webhookReplyAllow: 'alice' } }),
      } as never,
    })
    const outcome = await service.handle('ws1', comment('@cat-factory answer a hi'))
    expect(outcome).toEqual({ kind: 'ignored', reason: 'author_not_allowed' })
    expect(calls).toEqual([])
    expect(ack).not.toHaveBeenCalled()
  })

  it('does not read the projection at all for a comment with no command', async () => {
    // Most comments on a linked issue are ordinary discussion; making each of them cost a database
    // round-trip would tax every conversation for the benefit of the rare command.
    const { gateway } = makeGateway(review([item('a')]))
    const taskGet = vi.fn(async () => ({ linkedBlockId: 'blk_1' }))
    const service = makeService(gateway, { taskRepository: { get: taskGet } as never })
    expect(await service.handle('ws1', comment('just chatting'))).toEqual({
      kind: 'ignored',
      reason: 'no_commands',
    })
    expect(taskGet).not.toHaveBeenCalled()
  })

  it('ignores a command on an issue linked to no block', async () => {
    const { gateway, calls } = makeGateway(review([item('a')]))
    const service = makeService(gateway, {
      taskRepository: { get: async () => ({ linkedBlockId: null }) } as never,
    })
    expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
      kind: 'ignored',
      reason: 'issue_not_linked',
    })
    expect(calls).toEqual([])
  })

  it('applies nothing when the same comment is redelivered (the claim refuses)', async () => {
    const { gateway, calls } = makeGateway(review([item('a'), item('b')]))
    const service = makeService(gateway, {
      commentIngestRepository: {
        claim: async () => false,
        settle: async () => {},
        get: async () => null,
      },
    })
    expect(await service.handle('ws1', comment('@cat-factory answer a hi'))).toEqual({
      kind: 'ignored',
      reason: 'already_ingested',
    })
    expect(calls).toEqual([])
  })

  it('passes replies through entirely when no marker store is wired', async () => {
    // Applying without a claim would re-answer the same finding on every redelivery — the same
    // "pass through rather than act unsafely" stance the question writeback takes.
    const { gateway, calls } = makeGateway(review([item('a')]))
    const service = makeService(gateway, { commentIngestRepository: undefined })
    expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
      kind: 'ignored',
      reason: 'replies_not_wired',
    })
    expect(calls).toEqual([])
  })

  it('settles the marker FAILED and rethrows when applying blows up', async () => {
    // pg-boss / the CF queue retry on a throw, and the `failed` marker is what makes that retry
    // reach the apply again instead of being swallowed as already-ingested.
    const settle = vi.fn(async () => {})
    const { gateway } = makeGateway(review([item('a')]))
    const service = makeService(gateway, {
      reviewGateways: {
        requirements: {
          ...gateway,
          replyToItem: async () => {
            throw new Error('boom at https://tracker.test?token=sk-secret')
          },
        },
      },
      commentIngestRepository: { claim: async () => true, settle, get: async () => null },
    })
    await expect(service.handle('ws1', comment('@cat-factory answer a hi'))).rejects.toThrow('boom')
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' }),
      expect.any(Number),
    )
  })
})

// A block can hold a live review of BOTH subjects — a task re-run under a different pipeline
// leaves the earlier one behind — and both were posted onto the same issue with their own ids, so
// the comment itself is the only thing that says which loop the reporter is in.
describe('TrackerWebhookService — which review a reply reaches', () => {
  /** A clarity-shaped gateway: same lifecycle, its own review id and its own item ids. */
  function makeClarity(items: RequirementReviewItem[], over: Partial<RequirementReview> = {}) {
    return makeGateway(review(items, { id: 'clr_1', ...over }))
  }

  it('drives the clarity review when the comment names one of ITS findings', async () => {
    const requirements = makeGateway(review([item('req_a')]))
    const clarity = makeClarity([item('clri_a')])
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: requirements.gateway, clarity: clarity.gateway },
    })
    const outcome = await service.handle(
      'ws1',
      comment('@cat-factory answer clri_a Chrome 120 on macOS'),
    )
    expect(outcome).toEqual({ kind: 'reply', outcome: 'incorporating' })
    expect(clarity.calls).toEqual(['reply:clri_a', 'incorporate'])
    expect(requirements.calls).toEqual([])
  })

  it('falls back to the review still WAITING when a control verb names no id', async () => {
    // `proceed` is about the loop that stopped the run; a settled review is not it.
    const requirements = makeGateway(review([item('req_a')], { status: 'incorporated' }))
    const clarity = makeClarity([item('clri_a')], { status: 'exceeded' })
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: requirements.gateway, clarity: clarity.gateway },
    })
    expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
      kind: 'reply',
      outcome: 'resolved',
    })
    expect(clarity.calls).toEqual(['resolveExceeded:proceed'])
    expect(requirements.calls).toEqual([])
  })

  it.each(['incorporating', 'reviewing', 'merged'] as const)(
    'skips a review the driver is mid-cycle on (%s) for the one holding a human',
    async (status) => {
      // "Still waiting" is not "not settled": these three are the driver's own transients, and it
      // will leave them on its own. Picking one here would aim the reporter's bare `proceed` at a
      // loop nobody is being asked about, while the review that actually stopped the run — the one
      // whose questions they are answering — keeps waiting.
      const requirements = makeGateway(review([item('req_a')], { status }))
      const clarity = makeClarity([item('clri_a')], { status: 'exceeded' })
      const service = makeService(requirements.gateway, {
        reviewGateways: { requirements: requirements.gateway, clarity: clarity.gateway },
      })
      expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
        kind: 'reply',
        outcome: 'resolved',
      })
      expect(clarity.calls).toEqual(['resolveExceeded:proceed'])
      expect(requirements.calls).toEqual([])
    },
  )

  it('acknowledges the SUBJECT it reached, so the reporter is not told about requirements', async () => {
    const clarity = makeClarity([item('clri_a'), item('clri_b')])
    const ack = vi.fn(makeAckSpy)
    const service = makeService(clarity.gateway, {
      reviewGateways: { clarity: clarity.gateway },
      issueWriteback: { postReviewReplyAck: ack },
    })
    await service.handle('ws1', comment('@cat-factory answer clri_a it crashes on save'))
    expect(ack.mock.calls[0]![2]).toMatchObject({ subject: 'clarity', answered: ['clri_a'] })
  })

  it('ignores a reply when the only wired subject has no review for the block', async () => {
    const requirements = makeGateway(review([item('req_a')]))
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: { ...requirements.gateway, getForBlock: async () => null } },
    })
    expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
      kind: 'ignored',
      reason: 'no_review',
    })
  })

  it('ignores a reply when no subject is wired at all', async () => {
    const requirements = makeGateway(review([item('req_a')]))
    const service = makeService(requirements.gateway, { reviewGateways: {} })
    expect(await service.handle('ws1', comment('@cat-factory proceed'))).toEqual({
      kind: 'ignored',
      reason: 'replies_not_wired',
    })
  })

  it('tells a reporter an id is in the OTHER review, not that it does not exist', async () => {
    // One ticket carries both reviews' question comments, so answering both sets in one comment is
    // the ordinary mistake. Only one review is driven; the other's ids are rejected — and "no
    // finding `clri_a`" would tell the reporter an id they can see on the ticket is not real, where
    // the truth has a remedy they can act on.
    const requirements = makeGateway(review([item('req_a')]))
    const clarity = makeClarity([item('clri_a')])
    const ack = vi.fn(makeAckSpy)
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: requirements.gateway, clarity: clarity.gateway },
      issueWriteback: { postReviewReplyAck: ack },
    })
    await service.handle(
      'ws1',
      comment('@cat-factory answer req_a eur only\n@cat-factory answer clri_a chrome 120'),
    )
    // Declaration order put requirements first, and its own id was answered for real.
    expect(requirements.calls).toEqual(['reply:req_a', 'incorporate'])
    expect(clarity.calls).toEqual([])
    const { rejected } = ack.mock.calls[0]![2]
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toContain('the other review on this ticket')
    expect(rejected[0]!.reason).not.toContain('no finding')
  })

  it('still says "no finding" for an id that exists in NEITHER review', async () => {
    // The distinction has to stay a distinction: a typo is not a cross-review mix-up, and telling
    // a reporter to re-send an invented id in its own comment would be a dead end.
    const requirements = makeGateway(review([item('req_a')]))
    const clarity = makeClarity([item('clri_a')])
    const ack = vi.fn(makeAckSpy)
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: requirements.gateway, clarity: clarity.gateway },
      issueWriteback: { postReviewReplyAck: ack },
    })
    await service.handle('ws1', comment('@cat-factory answer req_typo eur only'))
    const { rejected } = ack.mock.calls[0]![2]
    expect(rejected[0]!.reason).toContain('no finding `req_typo`')
  })

  it('resolves a lone review through the SAME tie-breaks, with no short-circuit', async () => {
    // There used to be a `candidates.length <= 1` fast path, which meant the one-review case and
    // the many-review case were two code paths that could answer differently. Tie-break 1 already
    // handles it (nothing to break a tie between), so the behaviour is asserted here instead: a
    // named id is honoured, and an unknown one is a plain rejection rather than a mis-drive.
    const requirements = makeGateway(review([item('req_a')]))
    const service = makeService(requirements.gateway, {
      reviewGateways: { requirements: requirements.gateway },
    })
    expect(await service.handle('ws1', comment('@cat-factory answer req_a eur only'))).toEqual({
      kind: 'reply',
      outcome: 'incorporating',
    })
    expect(requirements.calls).toEqual(['reply:req_a', 'incorporate'])
  })
})

describe('TrackerWebhookService — ingest safety', () => {
  it('propagates a claim STORE FAILURE instead of reading it as already-ingested', async () => {
    // The failure mode this guards is silent and looks like success: nothing is written, the
    // delivery is acked, `ignored` comes back, and the reporter's answer is gone with no trace.
    // `false` means another delivery owns the ingest; an error means NOTHING is known, and the
    // apply is idempotent precisely so the queue can retry it.
    const { gateway, calls } = makeGateway(review([item('a')]))
    const service = makeService(gateway, {
      commentIngestRepository: {
        claim: async () => {
          throw new Error('store down')
        },
        settle: async () => {},
        get: async () => null,
      },
    })
    await expect(service.handle('ws1', comment('@cat-factory answer a hi'))).rejects.toThrow(
      'store down',
    )
    expect(calls).toEqual([])
  })

  it('never ingests a comment the platform itself authored', async () => {
    // Linear flags no bots and the default allow-list admits any author, so our own ack is an
    // ALLOWED author commenting on an issue we are linked to. Without the marker guard an ack
    // whose text ever began with the trigger would answer itself forever — each ack carries a
    // fresh comment id, so the ingest claim cannot stop it.
    const { gateway, calls } = makeGateway(review([item('a')]))
    const markers = makeMarkers()
    const service = makeService(gateway, { commentIngestRepository: markers })
    const ourOwn = renderReviewReplyAck({
      subject: 'requirements',
      reviewId: 'rrv_1',
      runId: 'run_1',
      outcome: 'awaiting',
      answered: [],
      dismissed: [],
      outstanding: [{ id: 'a', title: 'Finding a', detail: 'd' }],
      rejected: [],
    })
    const outcome = await service.handle(
      'ws1',
      comment(`${ourOwn}\n@cat-factory answer a looped`, {
        source: 'linear',
        author: { id: 'bot-user', handle: 'cat-factory', email: null, bot: false },
      }),
    )
    expect(outcome).toEqual({ kind: 'ignored', reason: 'self_authored' })
    // Not merely un-applied: never even claimed, so it costs no marker row either.
    expect(markers.claims).toBe(0)
    expect(calls).toEqual([])
  })

  it('ignores a bare mention rather than acking it as an unrecognised command', async () => {
    // Tagging the bot in discussion is not a malformed command sheet. Treating it as one consumes
    // a claim and answers a human question with "unrecognised command".
    const { gateway, calls } = makeGateway(review([item('a')]))
    const markers = makeMarkers()
    const ack = vi.fn(makeAckSpy)
    const service = makeService(gateway, {
      commentIngestRepository: markers,
      issueWriteback: { postReviewReplyAck: ack },
    })
    const outcome = await service.handle('ws1', comment('@cat-factory'))
    expect(outcome).toEqual({ kind: 'ignored', reason: 'no_commands' })
    expect(ack).not.toHaveBeenCalled()
    expect(markers.claims).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('TrackerWebhookService — issue events', () => {
  const issue: TrackerIssueEvent = {
    kind: 'issue',
    source: 'jira',
    externalId: 'ENG-9',
    action: 'created',
    title: 'Crash',
    labels: ['bug'],
    issueType: 'Bug',
    board: 'ENG',
    url: null,
  }

  it('fires the intake trigger and reports how many schedules started', async () => {
    const { gateway } = makeGateway(review([item('a')]))
    const triggerIntake = vi.fn(async () => 2)
    const service = makeService(gateway, { triggerIntake })
    expect(await service.handle('ws1', issue)).toEqual({ kind: 'intake', fired: 2 })
    expect(triggerIntake).toHaveBeenCalledWith('ws1', issue)
  })

  it('is a clean no-op when push intake is not wired', async () => {
    // The polling schedule still covers intake, so an unwired facade behaves exactly as before.
    const { gateway } = makeGateway(review([item('a')]))
    expect(await makeService(gateway, { triggerIntake: undefined }).handle('ws1', issue)).toEqual({
      kind: 'ignored',
      reason: 'intake_not_wired',
    })
  })
})
