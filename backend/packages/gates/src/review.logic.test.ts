import type { GateStepState, PullRequestReviewSnapshot, ReviewThread } from '@cat-factory/kernel'
import { stubGateContext } from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyHumanReview, isApproved, outstandingThreads } from './review.logic.js'
import { humanReviewGate } from './gates.js'
import { clearGateProviders, wirePullRequestReviewProvider } from './providers.js'

const NOW = 1_000_000_000
const MIN = 60_000

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 't1',
    author: 'reviewer',
    bodyExcerpt: 'please rename this',
    path: 'src/a.ts',
    line: 10,
    isBot: false,
    latestCommentAt: NOW - 60 * MIN,
    ...over,
  }
}

function snapshot(over: Partial<PullRequestReviewSnapshot> = {}): PullRequestReviewSnapshot {
  return {
    headSha: 'sha1',
    requiredApprovingReviewCount: 1,
    assignedReviewers: ['alice'],
    approvals: 0,
    unresolvedThreads: [],
    comments: [],
    ...over,
  }
}

const state = (over: Partial<GateStepState> = {}): Pick<GateStepState, 'lastAddressedCommentAt'> =>
  ({ lastAddressedCommentAt: null, ...over }) as GateStepState

describe('classifyHumanReview', () => {
  it('advances when there is no open PR', () => {
    const v = classifyHumanReview(snapshot({ headSha: null }), state(), {
      graceMinutes: 10,
      now: NOW,
    })
    expect(v.kind).toBe('advance')
  })

  it('advances when approved with no unresolved threads', () => {
    const v = classifyHumanReview(snapshot({ approvals: 1 }), state(), {
      graceMinutes: 10,
      now: NOW,
    })
    expect(v.kind).toBe('advance')
  })

  it('requires GitHub-required approvals, not just one', () => {
    const v = classifyHumanReview(
      snapshot({ approvals: 1, requiredApprovingReviewCount: 2 }),
      state(),
      { graceMinutes: 10, now: NOW },
    )
    expect(v.kind).toBe('wait')
    expect(isApproved(snapshot({ approvals: 2, requiredApprovingReviewCount: 2 }))).toBe(true)
  })

  it('dispatches immediately when approved WITH unresolved threads (no grace)', () => {
    const v = classifyHumanReview(
      snapshot({ approvals: 1, unresolvedThreads: [thread({ latestCommentAt: NOW })] }),
      state(),
      { graceMinutes: 30, now: NOW },
    )
    expect(v.kind).toBe('dispatch')
    if (v.kind === 'dispatch') expect(v.threadIds).toEqual(['t1'])
  })

  it('waits inside the grace window when not approved', () => {
    const v = classifyHumanReview(
      snapshot({ unresolvedThreads: [thread({ latestCommentAt: NOW - 5 * MIN })] }),
      state(),
      { graceMinutes: 10, now: NOW },
    )
    expect(v.kind).toBe('wait')
  })

  it('dispatches after the grace window elapses when not approved', () => {
    const v = classifyHumanReview(
      snapshot({ unresolvedThreads: [thread({ latestCommentAt: NOW - 20 * MIN })] }),
      state(),
      { graceMinutes: 10, now: NOW },
    )
    expect(v.kind).toBe('dispatch')
  })

  it('waits when not approved with nothing outstanding', () => {
    const v = classifyHumanReview(snapshot(), state(), { graceMinutes: 10, now: NOW })
    expect(v.kind).toBe('wait')
  })

  it('excludes bot-authored threads from outstanding (avoids re-fixing the fixer reply)', () => {
    const snap = snapshot({
      approvals: 1,
      unresolvedThreads: [thread({ isBot: true, latestCommentAt: NOW })],
    })
    expect(outstandingThreads(snap)).toHaveLength(0)
    expect(classifyHumanReview(snap, state(), { graceMinutes: 10, now: NOW }).kind).toBe('advance')
  })

  it('treats plain comments newer than the addressed cursor as outstanding', () => {
    const snap = snapshot({
      comments: [{ id: 'c1', author: 'bob', body: 'fix this too', createdAt: NOW, isBot: false }],
    })
    const fresh = classifyHumanReview(snap, state({ lastAddressedCommentAt: null }), {
      graceMinutes: 0,
      now: NOW,
    })
    expect(fresh.kind).toBe('dispatch')
    const addressed = classifyHumanReview(snap, state({ lastAddressedCommentAt: NOW }), {
      graceMinutes: 0,
      now: NOW,
    })
    expect(addressed.kind).toBe('wait')
  })

  it('ignores plain comments once approved (no fixer churn on post-sign-off chatter)', () => {
    // Approved PR + a fresh conversational comment ("thanks!"), no unresolved threads → advance,
    // NOT a pointless fixer round. Only explicit review threads trigger a fix once approved.
    const snap = snapshot({
      approvals: 1,
      comments: [{ id: 'c1', author: 'bob', body: 'thanks!', createdAt: NOW, isBot: false }],
    })
    expect(classifyHumanReview(snap, state(), { graceMinutes: 0, now: NOW }).kind).toBe('advance')
  })
})

describe('humanReviewGate', () => {
  afterEach(() => clearGateProviders())

  it('is a pass-through until a provider is wired', () => {
    expect(humanReviewGate(stubGateContext()).wired()).toBe(false)
  })

  it('maps dispatch to a fail probe and stashes the threads to resolve', async () => {
    wirePullRequestReviewProvider({
      getReview: async () =>
        snapshot({
          approvals: 1,
          unresolvedThreads: [thread({ threadId: 'T9', latestCommentAt: 0 })],
        }),
      resolveThreads: async () => {},
    })
    const gate = humanReviewGate(stubGateContext({ clock: { now: () => NOW } }))
    expect(gate.wired()).toBe(true)
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1 } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    expect(probe.status).toBe('fail')
    expect(gs.pendingThreadIds).toEqual(['T9'])
  })

  it('onHelperComplete resolves the stashed threads and clears them', async () => {
    const resolved: string[] = []
    wirePullRequestReviewProvider({
      getReview: async () => snapshot(),
      resolveThreads: async (_ws, _b, ids) => {
        resolved.push(...ids)
      },
    })
    const gate = humanReviewGate(stubGateContext())
    const step = {
      agentKind: 'human-review',
      gate: { phase: 'working', attempts: 1, maxAttempts: 1, pendingThreadIds: ['T9'] },
    } as unknown as Parameters<NonNullable<typeof gate.onHelperComplete>>[0]['step']
    await gate.onHelperComplete!({
      workspaceId: 'ws',
      instance: {} as never,
      block: { id: 'b' } as never,
      step,
      result: { state: 'done', result: { output: 'fixed' } },
    })
    expect(resolved).toEqual(['T9'])
    expect(step.gate?.pendingThreadIds).toBeNull()
  })

  it('reconciles a bot-latest unresolved thread (resolve-only) so it cannot linger forever', async () => {
    // A thread the fixer replied to but whose resolve lagged shows up unresolved + bot-latest.
    // The probe must re-attempt the resolve with an EMPTY reply (resolve only, no duplicate
    // comment), independent of any per-step stash.
    const calls: { ids: string[]; reply: string }[] = []
    wirePullRequestReviewProvider({
      getReview: async () =>
        snapshot({
          approvals: 1,
          unresolvedThreads: [thread({ threadId: 'T7', isBot: true, latestCommentAt: NOW })],
        }),
      resolveThreads: async (_ws, _b, ids, reply) => {
        calls.push({ ids, reply })
      },
    })
    const gate = humanReviewGate(stubGateContext({ clock: { now: () => NOW } }))
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1 } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    // Bot-latest thread is excluded from outstanding, so with approval the gate advances…
    expect(probe.status).toBe('pass')
    // …but the reconcile still resolved it, with an empty reply (resolve-only).
    expect(calls).toEqual([{ ids: ['T7'], reply: '' }])
  })

  it('keeps waiting (never fails the run) when the provider read throws', async () => {
    // A transient GitHub error on a poll must not fail the indefinitely-waiting gate.
    wirePullRequestReviewProvider({
      getReview: async () => {
        throw new Error('502 from GitHub')
      },
      resolveThreads: async () => {},
    })
    const gate = humanReviewGate(stubGateContext({ clock: { now: () => NOW } }))
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1, headSha: 'sha1' } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    expect(probe.status).toBe('pending')
    expect(probe.headSha).toBe('sha1')
  })
})
