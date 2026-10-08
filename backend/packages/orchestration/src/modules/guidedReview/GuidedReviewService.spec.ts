import type {
  GuidedReviewChange,
  GuidedReviewCommentDraft,
  GuidedReviewMessage,
  GuidedReviewSession,
  GuidedReviewThread,
} from '@cat-factory/contracts'
import type {
  GitHubChangedFile,
  GuidedReviewInvestigationHandle,
  GuidedReviewInvestigationRecord,
  GuidedReviewInvestigationUpdate,
  GuidedReviewInvestigator,
  GuidedReviewExchange,
  GuidedReviewJob,
  GuidedReviewMessageOutcome,
  GuidedReviewNewSession,
  GuidedReviewOverviewOutcome,
  GuidedReviewRepository,
  ModelProvider,
  ModelRef,
  RepoFiles,
  RunInitiatorScope,
} from '@cat-factory/kernel'
import { ConflictError, ForbiddenError, ValidationError } from '@cat-factory/kernel'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { GuidedReviewService } from './GuidedReviewService.js'

// The service's WIRING over the real `generateText` tool loop: a scripted model, a fake PR and
// an in-memory store. The store's concurrency contract is the conformance suite's to prove; this
// pins what only the service decides: when work is woken, what the model is handed, and what
// lands on the row for each way a job can end.

const WS = 'ws_1'
const OWNER = 'usr_1'
const HEAD = 'head123'

/**
 * The credential scopes open right now. Each stays open until its callback's promise settles, which
 * is what the facades' AsyncLocalStorage-backed seam amounts to for these sequential tests.
 */
const openScopes: (string | null | undefined)[] = []
const recordingScope = ((scope, fn) => {
  openScopes.push(scope.initiatedBy)
  return Promise.resolve(fn()).finally(() => openScopes.pop())
}) as RunInitiatorScope

type Step = { tool: string; input: Record<string, unknown> } | { text: string } | { throws: string }

function scriptedProvider(steps: Step[]): { provider: ModelProvider; calls: () => number } {
  let n = 0
  const provider: ModelProvider = {
    resolve(_ref: ModelRef) {
      return new MockLanguageModelV3({
        doGenerate: async () => {
          const step = steps[n++] ?? { text: '{}' }
          if ('throws' in step) throw new Error(step.throws)
          const content =
            'tool' in step
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: `call-${n}`,
                    toolName: step.tool,
                    input: JSON.stringify(step.input),
                  },
                ]
              : [{ type: 'text' as const, text: step.text }]
          return {
            content,
            finishReason: {
              unified: 'tool' in step ? ('tool-calls' as const) : ('stop' as const),
              raw: 'stop',
            },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
  return { provider, calls: () => n }
}

/** A single-writer store with the port's conditional semantics. */
class InMemoryGuidedReviewRepository implements GuidedReviewRepository {
  sessions = new Map<string, GuidedReviewSession>()
  threads = new Map<string, GuidedReviewThread>()
  messages = new Map<string, GuidedReviewMessage>()
  drafts = new Map<string, GuidedReviewCommentDraft>()
  claims = new Map<string, number>()
  investigations = new Map<string, GuidedReviewInvestigationRecord>()

  async recordInvestigation(
    _ws: string,
    id: string,
    record: GuidedReviewInvestigationRecord,
    now: number,
  ) {
    const m = this.messages.get(id)
    if (m?.status !== 'running') return false
    this.investigations.set(id, record)
    this.claims.set(`m:${id}`, now)
    m.updatedAt = now
    return true
  }
  async getInvestigation(_ws: string, id: string) {
    return this.investigations.get(id) ?? null
  }
  async heartbeatMessage(_ws: string, id: string, now: number) {
    const m = this.messages.get(id)
    if (m?.status !== 'running') return false
    this.claims.set(`m:${id}`, now)
    m.updatedAt = now
    return true
  }

  async openSession(_ws: string, s: GuidedReviewNewSession) {
    const existing = [...this.sessions.values()].find(
      (x) => x.repoId === s.repoId && x.prNumber === s.prNumber && x.createdBy === s.createdBy,
    )
    if (existing) return existing
    const session: GuidedReviewSession = {
      ...s,
      overview: { status: 'pending', generation: 1, content: null, failure: null, model: null },
    }
    this.sessions.set(s.id, structuredClone(session))
    return session
  }
  async getSession(_ws: string, id: string) {
    return this.sessions.get(id) ?? null
  }
  async listSessions() {
    return [...this.sessions.values()]
  }
  async deleteSession(_ws: string, id: string) {
    this.sessions.delete(id)
  }
  async restartOverview(
    _ws: string,
    id: string,
    expected: number,
    refresh: { prTitle: string; reviewedHeadSha: string; baseRef: string },
  ) {
    const s = this.sessions.get(id)
    if (!s || s.overview.generation !== expected) return false
    Object.assign(s, refresh)
    s.overview = {
      status: 'pending',
      generation: expected + 1,
      content: null,
      failure: null,
      model: null,
    }
    return true
  }
  async claimOverview(_ws: string, id: string, generation: number, cutoff: number, now: number) {
    const s = this.sessions.get(id)
    const key = `o:${id}`
    if (!s || s.overview.generation !== generation) return false
    const live =
      s.overview.status === 'pending' ||
      (s.overview.status === 'running' && (this.claims.get(key) ?? 0) < cutoff)
    if (!live) return false
    s.overview.status = 'running'
    this.claims.set(key, now)
    return true
  }
  async settleOverview(
    _ws: string,
    id: string,
    generation: number,
    o: GuidedReviewOverviewOutcome,
  ) {
    const s = this.sessions.get(id)
    if (!s || s.overview.generation !== generation || s.overview.status !== 'running') return false
    s.overview =
      o.status === 'complete'
        ? { status: 'complete', generation, content: o.content, failure: null, model: o.model }
        : { status: 'failed', generation, content: null, failure: o.failure, model: o.model }
    return true
  }
  async createThread(_ws: string, t: GuidedReviewThread) {
    this.threads.set(t.id, t)
  }
  async getThread(_ws: string, id: string) {
    return this.threads.get(id) ?? null
  }
  async listThreads(_ws: string, sessionId: string) {
    return [...this.threads.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((t) => ({ ...t, pendingMessageId: this.live(t.id)?.id ?? null }))
  }
  private live(threadId: string) {
    return [...this.messages.values()].find(
      (m) =>
        m.threadId === threadId &&
        m.role === 'assistant' &&
        (m.status === 'pending' || m.status === 'running'),
    )
  }
  async appendExchange(_ws: string, e: GuidedReviewExchange) {
    if (this.threads.get(e.threadId)?.sessionId !== e.sessionId) {
      return { ok: false as const, reason: 'thread_not_found' as const }
    }
    if (this.live(e.threadId)) return { ok: false as const, reason: 'thread_busy' as const }
    const seq = [...this.messages.values()].filter((m) => m.threadId === e.threadId).length
    const base = {
      threadId: e.threadId,
      sessionId: e.sessionId,
      kind: e.kind,
      depth: e.depth,
      citations: [],
      failure: null,
      draftReport: null,
      model: null,
      createdAt: e.at,
      updatedAt: e.at,
    }
    const question: GuidedReviewMessage = {
      ...base,
      id: e.questionId,
      seq: seq + 1,
      role: 'user',
      content: e.question,
      status: 'complete',
    }
    const placeholder: GuidedReviewMessage = {
      ...base,
      id: e.placeholderId,
      seq: seq + 2,
      role: 'assistant',
      content: '',
      status: 'pending',
    }
    this.messages.set(question.id, question)
    this.messages.set(placeholder.id, placeholder)
    return { ok: true as const, question, placeholder }
  }
  async getMessage(_ws: string, id: string) {
    return this.messages.get(id) ?? null
  }
  async listMessages(_ws: string, threadId: string) {
    return [...this.messages.values()]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.seq - b.seq)
  }
  async claimMessage(_ws: string, id: string, cutoff: number, now: number) {
    const m = this.messages.get(id)
    const key = `m:${id}`
    if (!m) return false
    const live =
      m.status === 'pending' || (m.status === 'running' && (this.claims.get(key) ?? 0) < cutoff)
    if (!live) return false
    m.status = 'running'
    this.claims.set(key, now)
    return true
  }
  async settleMessage(_ws: string, id: string, o: GuidedReviewMessageOutcome) {
    const m = this.messages.get(id)
    if (!m || m.status !== 'running') return false
    if (o.status === 'complete') {
      Object.assign(m, {
        status: 'complete',
        content: o.content,
        citations: o.citations,
        draftReport: o.draftReport,
        model: o.model,
      })
    } else {
      Object.assign(m, { status: 'failed', failure: o.failure, model: o.model })
    }
    return true
  }
  async settleDrafts(
    ws: string,
    messageId: string,
    drafts: GuidedReviewCommentDraft[],
    o: Extract<GuidedReviewMessageOutcome, { status: 'complete' }>,
  ) {
    if (!(await this.settleMessage(ws, messageId, o))) return false
    for (const d of drafts) this.drafts.set(d.id, d)
    return true
  }
  async getDraft(_ws: string, id: string) {
    return this.drafts.get(id) ?? null
  }
  async listDrafts(_ws: string, sessionId: string) {
    return [...this.drafts.values()].filter((d) => d.sessionId === sessionId)
  }
  async editDraft(
    _ws: string,
    id: string,
    rev: number,
    edit: Partial<GuidedReviewCommentDraft> & { discard?: boolean },
  ) {
    const d = this.drafts.get(id)
    if (!d || d.rev !== rev || !['proposed', 'failed'].includes(d.status)) return null
    const { discard, ...fields } = edit
    Object.assign(d, fields, { rev: d.rev + 1 }, discard ? { status: 'discarded' } : {})
    return d
  }
  async claimDraftsForPost(_ws: string, sessionId: string, ids: string[]) {
    const claimed = ids
      .map((id) => this.drafts.get(id))
      .filter((d): d is GuidedReviewCommentDraft => !!d && d.sessionId === sessionId)
      .filter((d) => d.status === 'proposed' || d.status === 'failed')
    for (const d of claimed) d.status = 'posting'
    return claimed.map((d) => ({ ...d }))
  }
  async settleDraftPosts(
    _ws: string,
    outcomes: { id: string; status: 'posted' | 'failed'; error?: string }[],
  ) {
    for (const o of outcomes) {
      const d = this.drafts.get(o.id)
      if (d?.status !== 'posting') continue
      d.status = o.status
      d.postError = o.status === 'failed' ? (o.error ?? null) : null
    }
  }
  async listStaleJobs(_driver: string, cutoff: number) {
    return [...this.messages.values()]
      .filter((m) => m.role === 'assistant' && m.status === 'pending' && m.updatedAt < cutoff)
      .map((m) => ({ kind: 'message' as const, workspaceId: WS, messageId: m.id }))
  }
}

const PATCH = '@@ -1,2 +1,3 @@\n context\n-old\n+retry()\n+retry()'
const FILES: GitHubChangedFile[] = [
  {
    path: 'src/pay.ts',
    previousPath: null,
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: PATCH,
  },
]

interface HostState {
  head: string
  posted: { path: string; line: number; body: string }[]
  /** Summary comments the host published. */
  summaries: string[]
  /** Comment indexes the host refuses. */
  refuse: Set<number>
}

function fakeRepo(reads: (string | undefined)[], host: HostState): RepoFiles {
  return {
    async createReview(
      _n: number,
      input: { body?: string; comments: { path: string; line: number; body: string }[] },
    ) {
      if (input.body) host.summaries.push(input.body)
      return {
        comments: input.comments.map((c, i) => {
          if (host.refuse.has(i)) return { posted: false, error: 'line is not part of the diff' }
          host.posted.push(c)
          return { posted: true }
        }),
        bodyPosted: input.body ? true : null,
      }
    },
    async getPullRequest() {
      return { title: 'Add retries', headSha: host.head, baseRef: 'main' }
    },
    async listChangedFiles() {
      return FILES
    },
    async getPullRequestBody() {
      return 'Retries payment calls.'
    },
    async getFile(path: string, gitRef?: string) {
      reads.push(`${path}@${gitRef} as ${openScopes.at(-1) ?? 'nobody'}`)
      return { content: 'retry()\nretry()', sha: 's' }
    },
    async listDirectory() {
      return []
    },
  } as unknown as RepoFiles
}

/** An investigator answering with a scripted sequence of poll updates. */
function fakeInvestigator(updates: GuidedReviewInvestigationUpdate[]) {
  const started: string[] = []
  const stopped: string[] = []
  const investigator: GuidedReviewInvestigator & { failStart?: string } = {
    supports: async () => true,
    async start(request) {
      if (investigator.failStart) throw new Error(investigator.failStart)
      started.push(request.jobId)
      return {
        workspaceId: request.workspaceId,
        jobId: request.jobId,
        initiatedBy: request.initiatedBy,
        dispatch: { model: 'fake:deep' },
      }
    },
    poll: async (_handle: GuidedReviewInvestigationHandle) =>
      updates.shift() ?? { state: 'running' },
    async stop(handle) {
      stopped.push(handle.jobId)
    },
  }
  return { investigator, started, stopped }
}

function setup(
  steps: Step[],
  opts: { overBudget?: boolean; investigator?: GuidedReviewInvestigator } = {},
) {
  const repository = new InMemoryGuidedReviewRepository()
  const woken: GuidedReviewJob[] = []
  const changes: GuidedReviewChange[] = []
  const reads: (string | undefined)[] = []
  const host: HostState = { head: HEAD, posted: [], summaries: [], refuse: new Set() }
  const { provider, calls } = scriptedProvider(steps)
  let id = 0
  let now = 1_000
  const service = new GuidedReviewService({
    repository,
    runner: { start: async (_ws, job) => void woken.push(job) },
    driver: 'deployment',
    resolveRepoFilesForCoords: async () => ({
      repo: fakeRepo(reads, host),
      baseBranch: 'main',
      repoId: '42',
      owner: 'acme',
      name: 'shop',
      provider: 'github',
    }),
    runInitiatorScope: recordingScope,
    modelProvider: provider,
    modelRef: { provider: 'fake', model: 'fake' } as ModelRef,
    isOverBudget: async () => opts.overBudget ?? false,
    idGenerator: { next: (prefix: string) => `${prefix}_${++id}` },
    clock: { now: () => now },
    events: { guidedReviewChanged: async (_ws, change) => void changes.push(change) },
    ...(opts.investigator ? { investigator: opts.investigator } : {}),
  })
  return {
    service,
    repository,
    woken,
    reads,
    calls,
    changes,
    host,
    advance: (ms: number) => (now += ms),
    push: (headSha: string) => (host.head = headSha),
  }
}

const OVERVIEW_JSON = JSON.stringify({
  summary: 'Adds retries to payment calls.',
  intent: 'Survive flaky providers.',
  meaningfulChanges: [{ title: 'Retry loop', detail: 'Wraps the call.', paths: ['src/pay.ts'] }],
  consequences: [],
  risks: [{ title: 'Unbounded', detail: 'No cap.', severity: 'high', paths: ['src/pay.ts'] }],
  focusAreas: [],
  suggestedQuestions: ['Is the retry bounded?'],
})

describe('GuidedReviewService', () => {
  it('opens a session, wakes its overview, and lands the overview the tool loop produced', async () => {
    const { service, repository, woken, reads } = setup([
      { tool: 'read_file', input: { path: 'src/pay.ts' } },
      { text: OVERVIEW_JSON },
    ])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    expect(session).toMatchObject({
      reviewedHeadSha: HEAD,
      baseRef: 'main',
      prTitle: 'Add retries',
    })
    expect(woken).toEqual([{ kind: 'overview', sessionId: session.id, generation: 1 }])

    await service.runJob(WS, woken[0]!)
    const stored = repository.sessions.get(session.id)!
    expect(stored.overview.status).toBe('complete')
    expect(stored.overview.content?.suggestedQuestions).toEqual([
      { id: expect.stringMatching(/^grq_/), question: 'Is the retry bounded?' },
    ])
    // The tool read the PR at the commit under review, as the reviewer who opened the session.
    expect(reads).toEqual([`src/pay.ts@${HEAD} as ${OWNER}`])

    // Reopening the same PR returns the same session and wakes nothing new.
    await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    expect(woken).toHaveLength(1)
  })

  it('answers a question once even when the job is delivered twice', async () => {
    const answer = JSON.stringify({
      answer: 'No: `retry()` runs twice with no cap.',
      citations: [{ path: 'src/pay.ts', startLine: 2, endLine: 3, side: 'RIGHT' }],
    })
    const { service, repository, woken, calls } = setup([{ text: answer }])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Is the retry bounded?' },
    })
    expect(thread.title).toBe('Is the retry bounded?')
    const job = woken.find((j) => j.kind === 'message')!

    await Promise.all([service.runJob(WS, job), service.runJob(WS, job)])
    expect(calls()).toBe(1)
    const [question, reply] = await repository.listMessages(WS, thread.id)
    expect(question).toMatchObject({ role: 'user', seq: 1 })
    expect(reply).toMatchObject({
      role: 'assistant',
      seq: 2,
      status: 'complete',
      content: 'No: `retry()` runs twice with no cap.',
      citations: [{ path: 'src/pay.ts', startLine: 2, endLine: 3, side: 'RIGHT' }],
    })
  })

  it('refuses a second question on a busy thread and leaves other threads free', async () => {
    const { service } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const busy = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'First?' },
    })
    await expect(
      service.ask(WS, OWNER, session.id, busy.thread.id, { content: 'Second?' }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      details: { reason: 'thread_busy' },
    })
    const other = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Elsewhere?' },
    })
    expect(other.messages).toHaveLength(2)
  })

  it('keeps drafts the diff can carry and reports the ones it cannot', async () => {
    const drafts = JSON.stringify({
      comments: [
        {
          path: 'src/pay.ts',
          line: 3,
          side: 'RIGHT',
          body: 'Bound these retries.',
          rationale: 'Thread found no cap.',
        },
        { path: 'src/pay.ts', line: 90, side: 'RIGHT', body: 'Elsewhere.', rationale: 'r' },
      ],
    })
    const { service, repository, woken, changes } = setup([{ text: drafts }])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread } = await service.openThread(WS, OWNER, session.id, {})
    const { placeholder } = await service.requestDrafts(
      WS,
      OWNER,
      session.id,
      thread.id,
      'Draft comments.',
    )
    await service.runJob(WS, woken.at(-1)!)

    expect(await repository.listDrafts(WS, session.id)).toEqual([
      expect.objectContaining({
        path: 'src/pay.ts',
        line: 3,
        side: 'RIGHT',
        status: 'proposed',
        rev: 1,
        messageId: placeholder.id,
      }),
    ])
    expect(repository.messages.get(placeholder.id)?.draftReport).toEqual({
      proposed: 2,
      dropped: [{ path: 'src/pay.ts', line: 90, side: 'RIGHT', reason: 'outside_diff' }],
    })
    expect(changes.at(-1)).toEqual({ sessionId: session.id, scope: 'drafts', threadId: thread.id })
  })

  it.each([
    ['budget_exhausted', [] as Step[], { overBudget: true }],
    ['unreadable_reply', [{ text: 'I think it is fine.' }], {}],
    ['generation_failed', [{ throws: 'provider 500' }], {}],
  ])('settles a failed answer with reason %s', async (reason, steps, opts) => {
    const { service, repository, woken } = setup(steps, opts)
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Why?' },
    })
    await service.runJob(
      WS,
      woken.find((j) => j.kind === 'message')!,
    )
    const reply = (await repository.listMessages(WS, thread.id))[1]!
    expect(reply.status).toBe('failed')
    expect(reply.failure?.reason).toBe(reason)
  })

  it('reports a deep question as unavailable without calling the model', async () => {
    const { service, repository, woken, calls } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Run the tests?', depth: 'deep' },
    })
    await service.runJob(
      WS,
      woken.find((j) => j.kind === 'message')!,
    )
    expect((await repository.listMessages(WS, thread.id))[1]?.failure).toEqual({
      reason: 'depth_unavailable',
      detail: null,
    })
    expect(calls()).toBe(0)
  })

  it('pushes a change after each write lands, naming the thread a client should refetch', async () => {
    const answer = JSON.stringify({ answer: 'Yes.', citations: [] })
    const { service, woken, changes } = setup([{ text: OVERVIEW_JSON }, { text: answer }])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    await service.runJob(WS, woken[0]!)
    const { thread } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Ok?' },
    })
    await service.runJob(WS, woken.at(-1)!)
    expect(changes).toEqual([
      { sessionId: session.id, scope: 'session' },
      { sessionId: session.id, scope: 'session' },
      { sessionId: session.id, scope: 'thread', threadId: thread.id },
      { sessionId: session.id, scope: 'thread', threadId: thread.id },
    ])
  })

  it('refuses a thread addressed through another session', async () => {
    const { service } = setup([])
    const first = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const second = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 8 })
    const { thread } = await service.openThread(WS, OWNER, first.id, {})
    await expect(service.getThread(WS, second.id, thread.id)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  describe('comment drafts', () => {
    const DRAFTS = JSON.stringify({
      comments: [
        {
          path: 'src/pay.ts',
          line: 3,
          side: 'RIGHT',
          body: 'Bound these retries. Closes #12',
          rationale: 'r',
        },
        { path: 'src/pay.ts', line: 2, side: 'RIGHT', body: 'Log the attempt.', rationale: 'r' },
      ],
    })

    async function drafted() {
      const ctx = setup([{ text: DRAFTS }])
      const session = await ctx.service.open(WS, OWNER, {
        owner: 'acme',
        repo: 'shop',
        prNumber: 7,
      })
      const { thread } = await ctx.service.openThread(WS, OWNER, session.id, {})
      await ctx.service.requestDrafts(WS, OWNER, session.id, thread.id, '')
      await ctx.service.runJob(WS, ctx.woken.at(-1)!)
      const drafts = await ctx.repository.listDrafts(WS, session.id)
      return { ...ctx, session, drafts }
    }

    it('refuses an edit from a stale revision and one that moves a draft out of the diff', async () => {
      const { service, session, drafts } = await drafted()
      const [first] = drafts
      const edited = await service.editDraft(WS, OWNER, session.id, first!.id, {
        rev: 1,
        body: 'Cap the retries at three.',
      })
      expect(edited).toMatchObject({ rev: 2, body: 'Cap the retries at three.' })
      await expect(
        service.editDraft(WS, OWNER, session.id, first!.id, { rev: 1, body: 'stale' }),
      ).rejects.toMatchObject({ details: { reason: 'draft_conflict' } })
      await expect(
        service.editDraft(WS, OWNER, session.id, first!.id, { rev: 2, line: 90 }),
      ).rejects.toMatchObject({ details: { reason: 'draft_anchor_outside_diff' } })
      // A discard is terminal, so it cannot carry an unchecked anchor along with it.
      await expect(
        service.editDraft(WS, OWNER, session.id, first!.id, { rev: 2, discard: true, line: 90 }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('posts each draft once, through the host boundary, and records a partial post per draft', async () => {
      const { service, session, drafts, host, changes } = await drafted()
      host.refuse.add(1)
      const ids = drafts.map((d) => d.id)
      const result = await service.postDrafts(WS, OWNER, session.id, { draftIds: ids })
      expect(result).toMatchObject({ posted: 1, failed: 1, skipped: [] })
      expect(result.drafts.map((d) => d.status)).toEqual(['posted', 'failed'])
      // A closing keyword in model text must not close an issue on the host.
      expect(host.posted).toHaveLength(1)
      expect(host.posted[0]!.body).not.toMatch(/Closes #12/)
      expect(changes.at(-1)).toEqual({ sessionId: session.id, scope: 'session' })

      host.refuse.clear()
      const again = await service.postDrafts(WS, OWNER, session.id, { draftIds: ids })
      expect(again).toMatchObject({ posted: 1, failed: 0, skipped: [ids[0]] })
      expect(host.posted).toHaveLength(2)
    })

    it('publishes the summary once, so an identical retry after a complete post posts nothing', async () => {
      const { service, session, drafts, host } = await drafted()
      const input = { draftIds: drafts.map((d) => d.id), summary: 'Two notes on the retries.' }
      const first = await service.postDrafts(WS, OWNER, session.id, input)
      expect(first.summary).toEqual({ posted: true, error: null })
      const again = await service.postDrafts(WS, OWNER, session.id, input)
      expect(again).toMatchObject({ posted: 0, summary: { posted: null, error: null } })
      expect(host.summaries).toHaveLength(1)
      expect(host.posted).toHaveLength(2)
    })

    it('refuses to move a draft once the pull request has moved past the reviewed commit', async () => {
      const { service, session, drafts, host } = await drafted()
      host.head = 'newer'
      await expect(
        service.editDraft(WS, OWNER, session.id, drafts[0]!.id, { rev: 1, line: 2 }),
      ).rejects.toMatchObject({ details: { reason: 'session_stale' } })
      // A body edit does not depend on the diff, so it still lands.
      await expect(
        service.editDraft(WS, OWNER, session.id, drafts[0]!.id, { rev: 1, body: 'Reworded.' }),
      ).resolves.toMatchObject({ rev: 2 })
    })

    it('refuses to post once the pull request has moved past the reviewed commit', async () => {
      const { service, session, drafts, host } = await drafted()
      host.head = 'newer'
      await expect(
        service.postDrafts(WS, OWNER, session.id, { draftIds: [drafts[0]!.id] }),
      ).rejects.toMatchObject({ details: { reason: 'session_stale' } })
      expect(host.posted).toEqual([])
    })
  })

  it('fails an answer as head_moved once the PR moves past the reviewed commit', async () => {
    const { service, repository, woken, calls, push } = setup([{ text: '{"answer":"Fine."}' }])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Why?' },
    })
    push('head456')
    await service.runJob(
      WS,
      woken.find((j) => j.kind === 'message')!,
    )
    expect((await repository.listMessages(WS, thread.id))[1]?.failure).toEqual({
      reason: 'head_moved',
      detail: 'head456',
    })
    expect(calls()).toBe(0)
  })

  it('refuses an empty first question without leaving an empty thread behind', async () => {
    const { service, repository } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    await expect(
      service.openThread(WS, OWNER, session.id, { question: { content: '   ' } }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(repository.threads.size).toBe(0)
  })

  it('lets only the session owner change it', async () => {
    const { service } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    await expect(service.openThread(WS, 'usr_other', session.id, {})).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('settles an abandoned job as failed so its thread is free again, and leaves a settled one alone', async () => {
    const { service, repository } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    const { thread, messages } = await service.openThread(WS, OWNER, session.id, {
      question: { content: 'Stuck?' },
    })
    const placeholder = messages[1]!
    // A driver claimed it and then kept failing.
    await repository.claimMessage(WS, placeholder.id, 0, 1_000)
    await service.abandonJob(WS, { kind: 'message', messageId: placeholder.id }, 'gave up')
    expect(repository.messages.get(placeholder.id)).toMatchObject({
      status: 'failed',
      failure: { reason: 'generation_failed', detail: 'gave up' },
    })
    expect((await repository.listThreads(WS, session.id))[0]?.pendingMessageId).toBeNull()

    await service.abandonJob(WS, { kind: 'message', messageId: placeholder.id }, 'again')
    expect(repository.messages.get(placeholder.id)?.failure?.detail).toBe('gave up')
    expect(thread.id).toBe(placeholder.threadId)
  })

  it('re-wakes work no claim settled within the lease', async () => {
    const { service, woken, advance } = setup([])
    const session = await service.open(WS, OWNER, { owner: 'acme', repo: 'shop', prNumber: 7 })
    await service.openThread(WS, OWNER, session.id, { question: { content: 'Lost?' } })
    const before = woken.length
    expect(await service.redriveStale()).toBe(0)
    advance(11 * 60_000)
    expect(await service.redriveStale()).toBe(1)
    expect(woken.slice(before)).toEqual([
      { kind: 'message', messageId: expect.stringMatching(/^grm_/) },
    ])
  })
})

describe('deep answers', () => {
  async function askDeep(investigator: GuidedReviewInvestigator) {
    const ctx = setup([], { investigator })
    const session = await ctx.service.open(WS, OWNER, {
      owner: 'acme',
      repo: 'shop',
      prNumber: 7,
    })
    const { thread } = await ctx.service.openThread(WS, OWNER, session.id, {
      question: { content: 'Do the tests cover the retry cap?', depth: 'deep' },
    })
    const job = ctx.woken.find((j) => j.kind === 'message')!
    const reply = () => ctx.repository.listMessages(WS, thread.id).then((m) => m[1]!)
    return { ...ctx, job, reply }
  }

  it('dispatches once, polls while it works, and lands the answer the container reported', async () => {
    const fake = fakeInvestigator([
      { state: 'running' },
      {
        state: 'done',
        model: 'fake:deep',
        report: {
          answer: 'No: `pay.spec.ts` never exceeds two attempts.',
          citations: [{ path: 'src/pay.spec.ts', startLine: 4, endLine: 9, side: 'RIGHT' }],
        },
      },
    ])
    const { service, job, reply } = await askDeep(fake.investigator)
    const [first, second] = await Promise.all([service.runJob(WS, job), service.runJob(WS, job)])
    expect(fake.started).toHaveLength(1)
    expect([first, second]).toContainEqual({ done: false, pollAfterMs: 15_000 })

    expect(await service.runJob(WS, job)).toEqual({ done: false, pollAfterMs: 15_000 })
    expect((await reply()).status).toBe('running')
    expect(await service.runJob(WS, job)).toEqual({ done: true })
    expect(await reply()).toMatchObject({
      status: 'complete',
      content: 'No: `pay.spec.ts` never exceeds two attempts.',
      model: 'fake:deep',
    })
    expect(fake.stopped).toEqual([])
  })

  it('stops a container that outlives its time budget and reports why', async () => {
    const fake = fakeInvestigator([])
    const { service, job, reply, advance } = await askDeep(fake.investigator)
    await service.runJob(WS, job)
    advance(46 * 60_000)
    expect(await service.runJob(WS, job)).toEqual({ done: true })
    expect(fake.stopped).toHaveLength(1)
    expect((await reply()).failure?.reason).toBe('generation_failed')
  })

  it('settles a dispatch that could not start, and releases a container nobody will read', async () => {
    const failing = fakeInvestigator([])
    failing.investigator.failStart = 'no runner'
    const first = await askDeep(failing.investigator)
    await first.service.runJob(WS, first.job)
    expect((await first.reply()).failure).toEqual({
      reason: 'generation_failed',
      detail: 'no runner',
    })

    const fake = fakeInvestigator([])
    const { service, job, reply } = await askDeep(fake.investigator)
    await service.runJob(WS, job)
    await service.abandonJob(WS, job, 'gave up')
    expect((await reply()).status).toBe('failed')
    expect(fake.stopped).toHaveLength(1)
    expect(await service.runJob(WS, job)).toEqual({ done: true })
  })
})
