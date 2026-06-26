import type {
  Block,
  GateStepState,
  PullRequestReviewSnapshot,
  RaiseNotificationInput,
  ReviewThread,
} from '@cat-factory/kernel'
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

  it('reconciles ONLY the gate-handed threads whose resolve lagged (resolve-only, retained)', async () => {
    // A thread the gate handed the fixer (in `pendingThreadIds`) but whose onHelperComplete
    // resolve threw stays unresolved. The probe must re-attempt the resolve with an EMPTY reply
    // (resolve only, no duplicate comment), keyed STRICTLY on the handed ids — and retain it
    // while still open so the next poll retries.
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
    const gs = {
      phase: 'checking',
      attempts: 0,
      maxAttempts: 1,
      pendingThreadIds: ['T7'],
    } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    // Bot-latest thread is excluded from outstanding, so with approval the gate advances…
    expect(probe.status).toBe('pass')
    // …but the reconcile still resolved the handed thread, with an empty reply (resolve-only),
    // and retained it (still open in this snapshot) for the next retry.
    expect(calls).toEqual([{ ids: ['T7'], reply: '' }])
    expect(gs.pendingThreadIds).toEqual(['T7'])
  })

  it('never auto-resolves a third-party bot thread the gate did not hand the fixer', async () => {
    // A code-review bot (`coderabbitai[bot]`) leaves its own unresolved thread. It is NOT in the
    // gate's handed set, so the reconcile must leave it strictly alone — silently closing another
    // bot's open thread would hide its feedback. (It's excluded from the HUMAN outstanding set,
    // so an approved PR still advances.)
    const calls: { ids: string[]; reply: string }[] = []
    wirePullRequestReviewProvider({
      getReview: async () =>
        snapshot({
          approvals: 1,
          unresolvedThreads: [
            thread({
              threadId: 'BOT1',
              author: 'coderabbitai[bot]',
              isBot: true,
              latestCommentAt: NOW,
            }),
          ],
        }),
      resolveThreads: async (_ws, _b, ids, reply) => {
        calls.push({ ids, reply })
      },
    })
    const gate = humanReviewGate(stubGateContext({ clock: { now: () => NOW } }))
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1 } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    expect(probe.status).toBe('pass')
    expect(calls).toEqual([]) // no resolve attempted on a thread we never handed the fixer
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

  it('raises the awaiting-approval card with the run executionId so the inbox can deep-link', async () => {
    // The card promises "request a fix here"; the inbox needs `executionId` to open the gate
    // window. The probe has no instance, but the block carries the parked run's id.
    wirePullRequestReviewProvider({
      getReview: async () => snapshot({ approvals: 0 }), // assigned reviewer, not approved → awaiting
      resolveThreads: async () => {},
    })
    const raised: RaiseNotificationInput[] = []
    const gate = humanReviewGate(
      stubGateContext({
        clock: { now: () => NOW },
        getBlock: async () =>
          ({ id: 'b', title: 'Login', executionId: 'ex-1' }) as unknown as Block,
        raiseNotification: async (_ws, input) => void raised.push(input),
      }),
    )
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1 } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    expect(probe.status).toBe('pending')
    expect(raised[0]?.type).toBe('human_review')
    expect(raised[0]?.executionId).toBe('ex-1')
  })

  it('surfaces a card (not a silent wait) when the fixer stalls on an unchanged head', async () => {
    // Outstanding feedback + a prior attempt at the same head sha = the fixer made no progress.
    // The gate backs off (pending) so it does not hot-loop — but it MUST raise a card so the
    // stalled loop is visible to the human instead of waiting forever in silence.
    wirePullRequestReviewProvider({
      getReview: async () =>
        snapshot({ approvals: 1, unresolvedThreads: [thread({ threadId: 'T1' })] }),
      resolveThreads: async () => {},
    })
    const raised: RaiseNotificationInput[] = []
    const gate = humanReviewGate(
      stubGateContext({
        clock: { now: () => NOW },
        getBlock: async () =>
          ({ id: 'b', title: 'Login', executionId: 'ex-1' }) as unknown as Block,
        raiseNotification: async (_ws, input) => void raised.push(input),
      }),
    )
    const gs = {
      phase: 'checking',
      attempts: 1,
      maxAttempts: 10,
      attemptLog: [{ attempt: 1, at: NOW, outcome: 'failed', headSha: 'sha1', summary: 'failed' }],
    } as GateStepState
    const probe = await gate.probe('ws', 'b', gs)
    expect(probe.status).toBe('pending') // backoff: no hot-loop
    expect(raised[0]?.type).toBe('human_review')
    expect(raised[0]?.executionId).toBe('ex-1')
    expect(raised[0]?.body).toMatch(/could not make further progress/)
  })

  it('skips the static branch-protection read once the required count is cached', async () => {
    // The gate caches the required-approving count and passes it back so the provider can skip
    // re-reading branch protection on every poll of an indefinite wait.
    const seen: (number | null | undefined)[] = []
    wirePullRequestReviewProvider({
      getReview: async (_ws, _b, cached) => {
        seen.push(cached)
        return snapshot({ approvals: 0, requiredApprovingReviewCount: 2 })
      },
      resolveThreads: async () => {},
    })
    const gate = humanReviewGate(stubGateContext({ clock: { now: () => NOW } }))
    const gs = { phase: 'checking', attempts: 0, maxAttempts: 1 } as GateStepState
    await gate.probe('ws', 'b', gs)
    expect(gs.requiredApprovingReviewCount).toBe(2) // cached after the first probe
    await gate.probe('ws', 'b', gs)
    expect(seen).toEqual([null, 2]) // first poll reads it; second poll passes the cached value
  })
})
