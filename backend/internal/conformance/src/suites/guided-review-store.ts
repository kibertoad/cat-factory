import type {
  GuidedReviewClaim,
  GuidedReviewDraftProposal,
  GuidedReviewExchange,
  GuidedReviewMessage,
  GuidedReviewNewSession,
  GuidedReviewRepository,
} from '@cat-factory/kernel'
import { GUIDED_REVIEW_LIST_MAX } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

const LEASE = 60_000
const HOST = 'deployment'

function session(over: Partial<GuidedReviewNewSession> = {}): GuidedReviewNewSession {
  return {
    id: 'grs_1',
    provider: 'github',
    repoId: '42',
    owner: 'acme',
    repo: 'shop',
    prNumber: 7,
    prTitle: 'Add checkout',
    reviewedHeadSha: 'head1',
    baseRef: 'base1',
    createdBy: 'usr_1',
    createdByKind: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function exchange(
  n: number,
  threadId: string,
  kind: GuidedReviewMessage['kind'] = 'answer',
): GuidedReviewExchange {
  return {
    sessionId: 'grs_1',
    threadId,
    kind,
    depth: 'inline',
    questionId: `q${n}`,
    question: 'Why?',
    placeholderId: `a${n}`,
    at: 10,
  }
}

function draft(
  id: string,
  over: Partial<GuidedReviewDraftProposal> = {},
): GuidedReviewDraftProposal {
  return {
    id,
    path: 'src/checkout.ts',
    line: 12,
    startLine: null,
    side: 'RIGHT',
    body: 'This retries without a bound.',
    rationale: 'The thread established the retry loop is unbounded.',
    ...over,
  }
}

function won(claim: GuidedReviewClaim | null): GuidedReviewClaim {
  if (!claim) throw new Error('expected the claim to be won')
  return claim
}

const answered = {
  status: 'complete' as const,
  content: 'Because of the retry loop.',
  citations: [{ path: 'src/checkout.ts', startLine: 10, endLine: 14, side: 'RIGHT' as const }],
  draftReport: null,
  model: 'fake:fake',
}

/**
 * The guided-review store's concurrency contract, asserted at the repository layer: one session
 * per creator per PR, one live answer per thread, claims a second driver cannot take, and a
 * superseded overview generation that cannot land. Each rests on a unique index or a guarded
 * update, and only real D1 and real Postgres can show both behave the same.
 */
export function defineGuidedReviewStoreConformance(harness: ConformanceHarness): void {
  describe('guided PR review store', () => {
    async function seeded(): Promise<{ repo: GuidedReviewRepository; ws: string }> {
      const app = harness.makeApp()
      const repo = app.guidedReviewRepository()
      const { workspace } = await app.createWorkspace()
      await repo.openSession(workspace.id, session(), HOST)
      for (const id of ['grt_1', 'grt_2']) {
        await repo.createThread(workspace.id, {
          id,
          sessionId: 'grs_1',
          title: id,
          createdBy: 'usr_1',
          createdAt: id === 'grt_1' ? 2 : 3,
          updatedAt: 2,
        })
      }
      return { repo, ws: workspace.id }
    }

    // The store tests above go around the HTTP app, so they cannot see a facade that forgot to
    // wire the module: every guided-review route would answer 503 there.
    it('is wired on this facade: an empty workspace lists no sessions', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const res = await app.call<unknown[]>('GET', `/workspaces/${workspace.id}/guided-reviews`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('converges two concurrent opens of the same PR on one session', async () => {
      const app = harness.makeApp()
      const repo = app.guidedReviewRepository()
      const { workspace } = await app.createWorkspace()
      const [a, b] = await Promise.all([
        repo.openSession(workspace.id, session({ id: 'grs_a' }), HOST),
        repo.openSession(workspace.id, session({ id: 'grs_b' }), HOST),
      ])
      expect(a.id).toBe(b.id)
      // The store queues generation 1 itself, so the opened overview is always claimable.
      expect(a.overview).toEqual({
        status: 'pending',
        generation: 1,
        content: null,
        failure: null,
        model: null,
      })
      expect(await repo.claimOverview(workspace.id, a.id, 1, 0, 100)).toEqual({ claimedAt: 100 })
      expect(await repo.listSessions(workspace.id, { repoId: '42', prNumber: 7 })).toHaveLength(1)
      // Another creator gets a session of their own.
      const other = await repo.openSession(
        workspace.id,
        session({ id: 'grs_c', createdBy: 'usr_2' }),
        HOST,
      )
      expect(other.id).toBe('grs_c')
    })

    it('keeps who owns a session, a person or an API key', async () => {
      const app = harness.makeApp()
      const repo = app.guidedReviewRepository()
      const { workspace } = await app.createWorkspace()
      await repo.openSession(workspace.id, session(), HOST)
      await repo.openSession(
        workspace.id,
        session({ id: 'grs_k', createdBy: 'pak_1', createdByKind: 'api-key' }),
        HOST,
      )
      expect(await repo.getSession(workspace.id, 'grs_1')).toMatchObject({
        createdBy: 'usr_1',
        createdByKind: 'user',
      })
      expect(await repo.getSession(workspace.id, 'grs_k')).toMatchObject({
        createdBy: 'pak_1',
        createdByKind: 'api-key',
      })
    })

    it('pages sessions newest created first, ties broken by id, with no row twice or skipped', async () => {
      const app = harness.makeApp()
      const repo = app.guidedReviewRepository()
      const { workspace } = await app.createWorkspace()
      // Two share a millisecond, and the oldest was updated last: neither may move a page edge.
      const seeds = [
        session({ id: 'grs_a', prNumber: 1, createdAt: 10, updatedAt: 99 }),
        session({ id: 'grs_b', prNumber: 2, createdAt: 20, updatedAt: 20 }),
        session({ id: 'grs_c', prNumber: 3, createdAt: 20, updatedAt: 20 }),
        session({ id: 'grs_d', prNumber: 4, createdAt: 30, updatedAt: 30 }),
        session({ id: 'grs_e', prNumber: 5, createdAt: 40, updatedAt: 40, createdBy: 'usr_2' }),
      ]
      for (const s of seeds) await repo.openSession(workspace.id, s, HOST)

      const seen: string[] = []
      let cursor: { createdAt: number; id: string } | undefined
      for (;;) {
        const page = await repo.pageSessions(
          workspace.id,
          { createdBy: 'usr_1' },
          { limit: 2, ...(cursor ? { cursor } : {}) },
        )
        seen.push(...page.map((s) => s.id))
        const last = page.at(-1)
        if (page.length < 2 || !last) break
        cursor = { createdAt: last.createdAt, id: last.id }
      }
      expect(seen).toEqual(['grs_d', 'grs_c', 'grs_b', 'grs_a'])
    })

    it('admits one live answer per thread and leaves other threads free', async () => {
      const { repo, ws } = await seeded()
      const [first, second, elsewhere] = await Promise.all([
        repo.appendExchange(ws, exchange(1, 'grt_1'), HOST),
        repo.appendExchange(ws, exchange(2, 'grt_1'), HOST),
        repo.appendExchange(ws, exchange(3, 'grt_2'), HOST),
      ])
      const outcomes = [first, second].map((r) => r.ok)
      expect(outcomes.sort()).toEqual([false, true])
      expect(elsewhere.ok).toBe(true)
      const busy = [first, second].find((r) => !r.ok)
      expect(busy).toEqual({ ok: false, reason: 'thread_busy' })

      const stored = await repo.listMessages(ws, 'grt_1')
      expect(stored.map((m) => [m.role, m.seq])).toEqual([
        ['user', 1],
        ['assistant', 2],
      ])
      const threads = await repo.listThreads(ws, 'grs_1')
      expect(threads.map((t) => t.id)).toEqual(['grt_1', 'grt_2'])
      expect(threads.every((t) => t.pendingMessageId !== null)).toBe(true)
    })

    it('refuses an exchange on a thread that is missing or belongs to another session', async () => {
      const { repo, ws } = await seeded()
      await repo.openSession(ws, session({ id: 'grs_2', prNumber: 8 }), HOST)
      expect(await repo.appendExchange(ws, exchange(1, 'grt_missing'), HOST)).toEqual({
        ok: false,
        reason: 'thread_not_found',
      })
      expect(
        await repo.appendExchange(ws, { ...exchange(2, 'grt_1'), sessionId: 'grs_2' }, HOST),
      ).toEqual({ ok: false, reason: 'thread_not_found' })
      expect(await repo.listMessages(ws, 'grt_missing')).toEqual([])
      expect(await repo.listMessages(ws, 'grt_1')).toEqual([])
    })

    it('claims an answer once, re-claims it past the lease, and frees the thread on settle', async () => {
      const { repo, ws } = await seeded()
      await repo.appendExchange(ws, exchange(1, 'grt_1'), HOST)

      const lapsed = won(await repo.claimMessage(ws, 'a1', 0, 100))
      expect(await repo.claimMessage(ws, 'a1', 100, 150)).toBeNull()
      const live = won(await repo.claimMessage(ws, 'a1', 100 + 1, 100 + LEASE))

      // The driver whose lease lapsed cannot land over the one that took the message over.
      expect(await repo.settleMessage(ws, 'a1', answered, 190, lapsed)).toBe(false)
      expect(await repo.settleMessage(ws, 'a1', answered, 200, live)).toBe(true)
      expect(await repo.settleMessage(ws, 'a1', answered, 201, live)).toBe(false)
      const settled = await repo.getMessage(ws, 'a1')
      expect(settled?.status).toBe('complete')
      expect(settled?.citations).toEqual(answered.citations)

      const next = await repo.appendExchange(ws, exchange(2, 'grt_1'), HOST)
      expect(next.ok && [next.question.seq, next.placeholder.seq]).toEqual([3, 4])
      expect((await repo.listThreads(ws, 'grs_1'))[0]?.pendingMessageId).toBe('a2')
    })

    it('records the container dispatch of a deep answer and keeps its claim fresh', async () => {
      const { repo, ws } = await seeded()
      await repo.appendExchange(ws, exchange(1, 'grt_1'), HOST)
      const investigation = {
        dispatchedAt: 120,
        dispatch: { model: 'anthropic:claude', subscriptionTokenId: 'tok_1' },
      }
      // Only a running message takes a dispatch: a pending one has no claimer yet.
      expect(await repo.recordInvestigation(ws, 'a1', investigation, 120, { claimedAt: 0 })).toBe(
        null,
      )
      const claim = won(await repo.claimMessage(ws, 'a1', 0, 100))
      // A starter whose claim was taken over cannot record its dispatch.
      expect(await repo.recordInvestigation(ws, 'a1', investigation, 120, { claimedAt: 99 })).toBe(
        null,
      )
      const recorded = won(await repo.recordInvestigation(ws, 'a1', investigation, 120, claim))
      expect(await repo.getInvestigation(ws, 'a1')).toEqual(investigation)

      // A heartbeat keeps a live poll out of the stale scan and hands the poller a fresh claim.
      const beat = won(await repo.heartbeatMessage(ws, 'a1', 5_000))
      const stale = await repo.listStaleJobs(HOST, 4_000, 10_000)
      expect(stale.filter((j) => j.workspaceId === ws && j.kind === 'message')).toEqual([])

      const failed = {
        status: 'failed' as const,
        failure: { reason: 'generation_failed' as const, detail: null },
        model: null,
      }
      // The claim a heartbeat superseded no longer lands.
      expect(await repo.settleMessage(ws, 'a1', failed, 6_000, recorded)).toBe(false)
      expect(await repo.settleMessage(ws, 'a1', failed, 6_000, beat)).toBe(true)
      expect(await repo.heartbeatMessage(ws, 'a1', 7_000)).toBeNull()
      // The record outlives the settle, so a late poll can still release the container.
      expect(await repo.getInvestigation(ws, 'a1')).toEqual(investigation)
    })

    it('never lets a superseded overview generation land', async () => {
      const { repo, ws } = await seeded()
      const superseded = won(await repo.claimOverview(ws, 'grs_1', 1, 0, 100))
      const refresh = { prTitle: 'Add checkout v2', reviewedHeadSha: 'head2', baseRef: 'base1' }
      expect(await repo.restartOverview(ws, 'grs_1', 1, refresh, HOST, 110)).toBe(true)
      expect(await repo.restartOverview(ws, 'grs_1', 1, refresh, HOST, 111)).toBe(false)

      const failed = {
        status: 'failed' as const,
        failure: { reason: 'generation_failed' as const, detail: 'late' },
        model: null,
      }
      expect(await repo.settleOverview(ws, 'grs_1', 1, failed, 120, superseded)).toBe(false)
      const lapsed = won(await repo.claimOverview(ws, 'grs_1', 2, 0, 130))
      const live = won(await repo.claimOverview(ws, 'grs_1', 2, 131, 135))

      const content = {
        summary: 's',
        intent: 'i',
        meaningfulChanges: [],
        consequences: [],
        risks: [],
        focusAreas: [],
        suggestedQuestions: [{ id: 'sq1', question: 'What breaks?' }],
      }
      const done = { status: 'complete' as const, content, model: 'fake:fake' }
      expect(await repo.settleOverview(ws, 'grs_1', 2, done, 140, lapsed)).toBe(false)
      expect(await repo.settleOverview(ws, 'grs_1', 2, done, 140, live)).toBe(true)
      const stored = await repo.getSession(ws, 'grs_1')
      expect(stored?.reviewedHeadSha).toBe('head2')
      expect(stored?.overview).toEqual({
        status: 'complete',
        generation: 2,
        content,
        failure: null,
        model: 'fake:fake',
      })
    })

    it('lands drafts with their message, guards edits by rev and claims each draft for one post', async () => {
      const { repo, ws } = await seeded()
      await repo.appendExchange(ws, exchange(1, 'grt_1', 'comment-drafts'), HOST)
      const claim = won(await repo.claimMessage(ws, 'a1', 0, 100))
      const outcome = {
        status: 'complete' as const,
        content: '',
        citations: [],
        draftReport: {
          proposed: 4,
          dropped: [
            { path: 'README.md', line: 3, side: 'RIGHT' as const, reason: 'not_in_pr' as const },
          ],
        },
        model: 'fake:fake',
      }
      const proposed = [draft('d1'), draft('d2'), draft('d3')]
      // An answer message cannot carry drafts.
      await repo.appendExchange(ws, exchange(2, 'grt_2'), HOST)
      const answerClaim = won(await repo.claimMessage(ws, 'a2', 0, 100))
      expect(await repo.settleDrafts(ws, 'a2', [draft('d0')], outcome, 150, answerClaim)).toBe(
        false,
      )
      expect(await repo.settleDrafts(ws, 'a1', proposed, outcome, 150, claim)).toBe(true)
      expect(await repo.settleDrafts(ws, 'a1', [draft('d4')], outcome, 151, claim)).toBe(false)
      // The store owns everything but the proposal: the message's session and thread, `proposed`
      // at rev 1, stamped at the settle.
      expect(await repo.listDrafts(ws, 'grs_1')).toEqual(
        proposed.map((d) =>
          expect.objectContaining({
            ...d,
            sessionId: 'grs_1',
            threadId: 'grt_1',
            messageId: 'a1',
            status: 'proposed',
            postError: null,
            postedUrl: null,
            rev: 1,
            createdAt: 150,
            updatedAt: 150,
          }),
        ),
      )
      expect(await repo.getMessage(ws, 'a1')).toMatchObject({
        status: 'complete',
        draftReport: outcome.draftReport,
        failure: null,
      })

      const edited = await repo.editDraft(
        ws,
        'd1',
        1,
        { body: 'Bound the retries.', line: 13 },
        160,
      )
      expect(edited).toMatchObject({ body: 'Bound the retries.', line: 13, rev: 2 })
      expect(await repo.editDraft(ws, 'd1', 1, { body: 'stale' }, 161)).toBeNull()
      expect(await repo.editDraft(ws, 'd3', 1, { discard: true }, 162)).toMatchObject({
        status: 'discarded',
      })

      const [a, b] = await Promise.all([
        repo.claimDraftsForPost(ws, 'grs_1', ['d1', 'd2', 'd3'], 0, 170),
        repo.claimDraftsForPost(ws, 'grs_1', ['d1', 'd2', 'd3'], 0, 170),
      ])
      const claimed = [...a, ...b].map((d) => d.id).sort()
      expect(claimed).toEqual(['d1', 'd2'])
      // A live posting claim holds; one past its lease is re-claimable, so a dead poster
      // cannot strand a draft in `posting`.
      expect(await repo.claimDraftsForPost(ws, 'grs_1', ['d1', 'd2'], 170, 175)).toEqual([])
      const lapsedD2 = [...a, ...b].find((d) => d.id === 'd2')!
      const d1 = [...a, ...b].find((d) => d.id === 'd1')!
      const [liveD2] = await repo.claimDraftsForPost(ws, 'grs_1', ['d2'], 171, 176)
      expect(liveD2?.id).toBe('d2')

      // The poster whose lease lapsed cannot record over the one that re-claimed d2.
      expect(
        await repo.settleDraftPosts(
          ws,
          [{ id: 'd2', rev: lapsedD2.rev, status: 'posted', postedUrl: 'https://host/c/x' }],
          178,
        ),
      ).toEqual([])
      const recorded = await repo.settleDraftPosts(
        ws,
        [
          { id: 'd1', rev: d1.rev, status: 'posted', postedUrl: 'https://host/c/1' },
          { id: 'd2', rev: liveD2!.rev, status: 'failed', error: 'line is outside the diff' },
        ],
        180,
      )
      expect(recorded.sort()).toEqual(['d1', 'd2'])
      const byId = new Map((await repo.listDrafts(ws, 'grs_1')).map((d) => [d.id, d]))
      expect(byId.get('d1')).toMatchObject({ status: 'posted', postedUrl: 'https://host/c/1' })
      expect(byId.get('d2')).toMatchObject({
        status: 'failed',
        postError: 'line is outside the diff',
      })
      // A posted draft is final; a failed one can be edited and claimed again.
      expect(await repo.editDraft(ws, 'd1', byId.get('d1')!.rev, { body: 'x' }, 190)).toBeNull()
      expect((await repo.claimDraftsForPost(ws, 'grs_1', ['d2'], 0, 200)).map((d) => d.id)).toEqual(
        ['d2'],
      )
    })

    it('refuses an out-of-contract write instead of storing a row no read could decode', async () => {
      const { repo, ws } = await seeded()
      await repo.appendExchange(ws, exchange(1, 'grt_1'), HOST)
      const claim = won(await repo.claimMessage(ws, 'a1', 0, 100))
      const tooMany = Array.from({ length: GUIDED_REVIEW_LIST_MAX + 1 }, () => ({
        path: 'src/checkout.ts',
      }))
      await expect(
        repo.settleMessage(ws, 'a1', { ...answered, citations: tooMany }, 110, claim),
      ).rejects.toThrow(/out of contract/)
      const longFailure = {
        status: 'failed' as const,
        failure: { reason: 'generation_failed' as const, detail: 'x'.repeat(100_000) },
        model: null,
      }
      await expect(repo.settleMessage(ws, 'a1', longFailure, 110, claim)).rejects.toThrow(
        /out of contract/,
      )
      // Nothing was written, so the message still reads and the claim still settles it.
      expect((await repo.listMessages(ws, 'grt_1')).map((m) => m.status)).toEqual([
        'complete',
        'running',
      ])
      expect(await repo.settleMessage(ws, 'a1', answered, 120, claim)).toBe(true)
    })

    it('lists unsettled work older than the cutoff, and deleting a session removes its rows', async () => {
      const { repo, ws } = await seeded()
      await repo.appendExchange(ws, exchange(1, 'grt_1'), HOST)
      // The scan spans every workspace and the store is shared with the other tests, so assert
      // over this workspace's slice only, with a limit no sibling's rows can exhaust.
      const ours = async (cutoff: number) =>
        (await repo.listStaleJobs(HOST, cutoff, 10_000)).filter((j) => j.workspaceId === ws)
      expect(await ours(50)).toEqual([
        { kind: 'overview', workspaceId: ws, sessionId: 'grs_1', generation: 1 },
        { kind: 'message', workspaceId: ws, messageId: 'a1' },
      ])
      expect(await ours(5)).toEqual([
        { kind: 'overview', workspaceId: ws, sessionId: 'grs_1', generation: 1 },
      ])
      // Another host never re-drives this one's work: it would answer with the wrong credentials.
      const elsewhere = await repo.listStaleJobs('node:laptop', 50, 10_000)
      expect(elsewhere.filter((j) => j.workspaceId === ws)).toEqual([])

      await repo.deleteSession(ws, 'grs_1')
      expect(await repo.getSession(ws, 'grs_1')).toBeNull()
      expect(await repo.listThreads(ws, 'grs_1')).toEqual([])
      expect(await repo.listMessages(ws, 'grt_1')).toEqual([])
    })
  })
}
