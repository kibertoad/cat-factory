import type {
  GuidedReviewCommentDraft,
  GuidedReviewDraftEdit,
  GuidedReviewDriver,
  GuidedReviewDraftPostOutcome,
  GuidedReviewMessage,
  GuidedReviewMessageOutcome,
  GuidedReviewOverviewOutcome,
  GuidedReviewRefresh,
  GuidedReviewRepository,
  GuidedReviewSession,
  GuidedReviewSessionFilter,
  GuidedReviewStaleJob,
  GuidedReviewThread,
  GuidedReviewThreadSummary,
} from '@cat-factory/kernel'
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  guidedReviewCommentDrafts as drafts,
  guidedReviewMessages as messages,
  guidedReviewSessions as sessions,
  guidedReviewThreads as threads,
} from '../../db/schema.js'

type SessionRow = typeof sessions.$inferSelect
type ThreadRow = typeof threads.$inferSelect
type MessageRow = typeof messages.$inferSelect
type DraftRow = typeof drafts.$inferSelect

const LIVE = ['pending', 'running'] as const
const EDITABLE = ['proposed', 'failed'] as const

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToSession(row: SessionRow): GuidedReviewSession {
  return {
    id: row.id,
    provider: row.provider as GuidedReviewSession['provider'],
    repoId: row.repo_id,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    prTitle: row.pr_title,
    reviewedHeadSha: row.reviewed_head_sha,
    baseRef: row.base_ref,
    createdBy: row.created_by,
    overview: {
      status: row.overview_status as GuidedReviewSession['overview']['status'],
      generation: row.overview_generation,
      content: parseJson(row.overview_content, null),
      failure: parseJson(row.overview_failure, null),
      model: row.overview_model,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToThread(row: ThreadRow): GuidedReviewThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMessage(row: MessageRow): GuidedReviewMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role as GuidedReviewMessage['role'],
    kind: row.kind as GuidedReviewMessage['kind'],
    depth: row.depth as GuidedReviewMessage['depth'],
    content: row.content,
    status: row.status as GuidedReviewMessage['status'],
    citations: parseJson(row.citations, []),
    failure: parseJson(row.failure, null),
    draftReport: parseJson(row.draft_report, null),
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDraft(row: DraftRow): GuidedReviewCommentDraft {
  return {
    id: row.id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    path: row.path,
    line: row.line,
    startLine: row.start_line,
    side: row.side as GuidedReviewCommentDraft['side'],
    body: row.body,
    rationale: row.rationale,
    status: row.status as GuidedReviewCommentDraft['status'],
    postError: row.post_error,
    postedUrl: row.posted_url,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageValues(
  workspaceId: string,
  m: Omit<GuidedReviewMessage, 'seq'>,
  driver: GuidedReviewDriver,
) {
  return {
    driver,
    workspace_id: workspaceId,
    id: m.id,
    thread_id: m.threadId,
    session_id: m.sessionId,
    role: m.role,
    kind: m.kind,
    depth: m.depth,
    content: m.content,
    status: m.status,
    citations: JSON.stringify(m.citations),
    failure: m.failure ? JSON.stringify(m.failure) : null,
    draft_report: m.draftReport ? JSON.stringify(m.draftReport) : null,
    model: m.model,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  }
}

function settledMessageSet(outcome: GuidedReviewMessageOutcome, now: number) {
  const complete = outcome.status === 'complete'
  return {
    status: outcome.status,
    content: complete ? outcome.content : '',
    citations: JSON.stringify(complete ? outcome.citations : []),
    failure: complete ? null : JSON.stringify(outcome.failure),
    draft_report: complete && outcome.draftReport ? JSON.stringify(outcome.draftReport) : null,
    model: outcome.model,
    claimed_at: null,
    updated_at: now,
  }
}

/**
 * Guided PR review sessions over Postgres: the Drizzle mirror of `D1GuidedReviewRepository`
 * (migration 0104). Under READ COMMITTED the one-live-answer rule is the partial unique index
 * `idx_guided_review_messages_live`, targeted by the placeholder insert, so two concurrent
 * questions on one thread resolve to one winner and one `thread_busy`.
 */
export class DrizzleGuidedReviewRepository implements GuidedReviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async openSession(
    workspaceId: string,
    s: GuidedReviewSession,
    driver: GuidedReviewDriver,
  ): Promise<GuidedReviewSession> {
    await this.db
      .insert(sessions)
      .values({
        workspace_id: workspaceId,
        id: s.id,
        provider: s.provider,
        repo_id: s.repoId,
        owner: s.owner,
        repo: s.repo,
        pr_number: s.prNumber,
        pr_title: s.prTitle,
        reviewed_head_sha: s.reviewedHeadSha,
        base_ref: s.baseRef,
        created_by: s.createdBy,
        overview_status: s.overview.status,
        overview_generation: s.overview.generation,
        overview_content: s.overview.content ? JSON.stringify(s.overview.content) : null,
        overview_failure: s.overview.failure ? JSON.stringify(s.overview.failure) : null,
        overview_model: s.overview.model,
        overview_driver: driver,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
      })
      .onConflictDoNothing({
        target: [sessions.workspace_id, sessions.repo_id, sessions.pr_number, sessions.created_by],
      })
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspace_id, workspaceId),
          eq(sessions.repo_id, s.repoId),
          eq(sessions.pr_number, s.prNumber),
          eq(sessions.created_by, s.createdBy),
        ),
      )
      .limit(1)
    if (!rows[0])
      throw new Error(`guided review session for PR #${s.prNumber} vanished after insert`)
    return rowToSession(rows[0])
  }

  async getSession(workspaceId: string, id: string): Promise<GuidedReviewSession | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspace_id, workspaceId), eq(sessions.id, id)))
      .limit(1)
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async listSessions(
    workspaceId: string,
    filter: GuidedReviewSessionFilter,
  ): Promise<GuidedReviewSession[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspace_id, workspaceId),
          filter.repoId === undefined ? undefined : eq(sessions.repo_id, filter.repoId),
          filter.prNumber === undefined ? undefined : eq(sessions.pr_number, filter.prNumber),
          filter.createdBy === undefined ? undefined : eq(sessions.created_by, filter.createdBy),
        ),
      )
      .orderBy(desc(sessions.updated_at), asc(sessions.id))
      .limit(filter.limit ?? 50)
    return rows.map(rowToSession)
  }

  async deleteSession(workspaceId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const table of [drafts, messages, threads]) {
        await tx
          .delete(table)
          .where(and(eq(table.workspace_id, workspaceId), eq(table.session_id, id)))
      }
      await tx
        .delete(sessions)
        .where(and(eq(sessions.workspace_id, workspaceId), eq(sessions.id, id)))
    })
  }

  async restartOverview(
    workspaceId: string,
    id: string,
    expectedGeneration: number,
    refresh: GuidedReviewRefresh,
    driver: GuidedReviewDriver,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({
        overview_driver: driver,
        pr_title: refresh.prTitle,
        reviewed_head_sha: refresh.reviewedHeadSha,
        base_ref: refresh.baseRef,
        overview_status: 'pending',
        overview_generation: sql`${sessions.overview_generation} + 1`,
        overview_content: null,
        overview_failure: null,
        overview_model: null,
        overview_claimed_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(sessions.workspace_id, workspaceId),
          eq(sessions.id, id),
          eq(sessions.overview_generation, expectedGeneration),
        ),
      )
      .returning({ id: sessions.id })
    return rows.length > 0
  }

  async claimOverview(
    workspaceId: string,
    id: string,
    generation: number,
    leaseCutoff: number,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ overview_status: 'running', overview_claimed_at: now, updated_at: now })
      .where(
        and(
          eq(sessions.workspace_id, workspaceId),
          eq(sessions.id, id),
          eq(sessions.overview_generation, generation),
          or(
            eq(sessions.overview_status, 'pending'),
            and(
              eq(sessions.overview_status, 'running'),
              lt(sessions.overview_claimed_at, leaseCutoff),
            ),
          ),
        ),
      )
      .returning({ id: sessions.id })
    return rows.length > 0
  }

  async settleOverview(
    workspaceId: string,
    id: string,
    generation: number,
    outcome: GuidedReviewOverviewOutcome,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({
        overview_status: outcome.status,
        overview_content: outcome.status === 'complete' ? JSON.stringify(outcome.content) : null,
        overview_failure: outcome.status === 'failed' ? JSON.stringify(outcome.failure) : null,
        overview_model: outcome.model,
        overview_claimed_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(sessions.workspace_id, workspaceId),
          eq(sessions.id, id),
          eq(sessions.overview_generation, generation),
          eq(sessions.overview_status, 'running'),
        ),
      )
      .returning({ id: sessions.id })
    return rows.length > 0
  }

  async createThread(workspaceId: string, t: GuidedReviewThread): Promise<void> {
    await this.db.insert(threads).values({
      workspace_id: workspaceId,
      id: t.id,
      session_id: t.sessionId,
      title: t.title,
      created_by: t.createdBy,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    })
  }

  async getThread(workspaceId: string, id: string): Promise<GuidedReviewThread | null> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.workspace_id, workspaceId), eq(threads.id, id)))
      .limit(1)
    return rows[0] ? rowToThread(rows[0]) : null
  }

  async listThreads(workspaceId: string, sessionId: string): Promise<GuidedReviewThreadSummary[]> {
    const rows = await this.db
      .select({ thread: threads, pendingMessageId: messages.id })
      .from(threads)
      .leftJoin(
        messages,
        and(
          eq(messages.workspace_id, threads.workspace_id),
          eq(messages.thread_id, threads.id),
          eq(messages.role, 'assistant'),
          inArray(messages.status, [...LIVE]),
        ),
      )
      .where(and(eq(threads.workspace_id, workspaceId), eq(threads.session_id, sessionId)))
      .orderBy(asc(threads.created_at), asc(threads.id))
    return rows.map((r) => ({ ...rowToThread(r.thread), pendingMessageId: r.pendingMessageId }))
  }

  async appendExchange(
    workspaceId: string,
    question: Omit<GuidedReviewMessage, 'seq'>,
    placeholder: Omit<GuidedReviewMessage, 'seq'>,
    driver: GuidedReviewDriver,
  ): Promise<
    | { ok: true; question: GuidedReviewMessage; placeholder: GuidedReviewMessage }
    | { ok: false; reason: 'thread_busy' }
  > {
    return this.db.transaction(async (tx) => {
      // Lock the thread first. Without it two writers read the same MAX(seq) and the loser trips
      // the seq index (not the conflict target) before the live-answer conflict can resolve.
      await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.workspace_id, workspaceId), eq(threads.id, placeholder.threadId)))
        .for('update')
      const nextSeq = sql<number>`(SELECT COALESCE(MAX(${messages.seq}), 0) + 2
        FROM ${messages}
        WHERE ${messages.workspace_id} = ${workspaceId}
          AND ${messages.thread_id} = ${placeholder.threadId})`
      const [placed] = await tx
        .insert(messages)
        .values({ ...messageValues(workspaceId, placeholder, driver), seq: nextSeq })
        .onConflictDoNothing({
          target: [messages.workspace_id, messages.thread_id],
          // Must mirror idx_guided_review_messages_live exactly.
          where: sql`${messages.role} = 'assistant' AND ${messages.status} IN ('pending', 'running')`,
        })
        .returning()
      if (!placed) return { ok: false, reason: 'thread_busy' } as const
      const [asked] = await tx
        .insert(messages)
        .values({ ...messageValues(workspaceId, question, driver), seq: placed.seq - 1 })
        .returning()
      if (!asked) throw new Error(`guided review question ${question.id} was not stored`)
      return { ok: true, question: rowToMessage(asked), placeholder: rowToMessage(placed) } as const
    })
  }

  async getMessage(workspaceId: string, id: string): Promise<GuidedReviewMessage | null> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspace_id, workspaceId), eq(messages.id, id)))
      .limit(1)
    return rows[0] ? rowToMessage(rows[0]) : null
  }

  async listMessages(workspaceId: string, threadId: string): Promise<GuidedReviewMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspace_id, workspaceId), eq(messages.thread_id, threadId)))
      .orderBy(asc(messages.seq))
    return rows.map(rowToMessage)
  }

  async claimMessage(
    workspaceId: string,
    id: string,
    leaseCutoff: number,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ status: 'running', claimed_at: now, updated_at: now })
      .where(
        and(
          eq(messages.workspace_id, workspaceId),
          eq(messages.id, id),
          eq(messages.role, 'assistant'),
          or(
            eq(messages.status, 'pending'),
            and(eq(messages.status, 'running'), lt(messages.claimed_at, leaseCutoff)),
          ),
        ),
      )
      .returning({ id: messages.id })
    return rows.length > 0
  }

  async settleMessage(
    workspaceId: string,
    id: string,
    outcome: GuidedReviewMessageOutcome,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set(settledMessageSet(outcome, now))
      .where(
        and(
          eq(messages.workspace_id, workspaceId),
          eq(messages.id, id),
          eq(messages.status, 'running'),
        ),
      )
      .returning({ id: messages.id })
    return rows.length > 0
  }

  async settleDrafts(
    workspaceId: string,
    messageId: string,
    proposed: GuidedReviewCommentDraft[],
    outcome: Extract<GuidedReviewMessageOutcome, { status: 'complete' }>,
    now: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const settled = await tx
        .update(messages)
        .set(settledMessageSet(outcome, now))
        .where(
          and(
            eq(messages.workspace_id, workspaceId),
            eq(messages.id, messageId),
            eq(messages.status, 'running'),
          ),
        )
        .returning({ id: messages.id })
      if (settled.length === 0) return false
      if (proposed.length > 0) {
        await tx.insert(drafts).values(
          proposed.map((d) => ({
            workspace_id: workspaceId,
            id: d.id,
            session_id: d.sessionId,
            thread_id: d.threadId,
            message_id: d.messageId,
            path: d.path,
            line: d.line,
            start_line: d.startLine,
            side: d.side,
            body: d.body,
            rationale: d.rationale,
            status: d.status,
            post_error: d.postError,
            posted_url: d.postedUrl,
            rev: d.rev,
            created_at: d.createdAt,
            updated_at: d.updatedAt,
          })),
        )
      }
      return true
    })
  }

  async getDraft(workspaceId: string, id: string): Promise<GuidedReviewCommentDraft | null> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.workspace_id, workspaceId), eq(drafts.id, id)))
      .limit(1)
    return rows[0] ? rowToDraft(rows[0]) : null
  }

  async listDrafts(workspaceId: string, sessionId: string): Promise<GuidedReviewCommentDraft[]> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.workspace_id, workspaceId), eq(drafts.session_id, sessionId)))
      .orderBy(asc(drafts.created_at), asc(drafts.id))
    return rows.map(rowToDraft)
  }

  async editDraft(
    workspaceId: string,
    id: string,
    expectedRev: number,
    edit: GuidedReviewDraftEdit,
    now: number,
  ): Promise<GuidedReviewCommentDraft | null> {
    const current = await this.getDraft(workspaceId, id)
    if (!current || current.rev !== expectedRev) return null
    const rows = await this.db
      .update(drafts)
      .set({
        path: edit.path ?? current.path,
        line: edit.line ?? current.line,
        start_line: edit.startLine === undefined ? current.startLine : edit.startLine,
        side: edit.side ?? current.side,
        body: edit.body ?? current.body,
        status: edit.discard ? 'discarded' : current.status,
        post_error: edit.discard ? null : current.postError,
        rev: sql`${drafts.rev} + 1`,
        updated_at: now,
      })
      .where(
        and(
          eq(drafts.workspace_id, workspaceId),
          eq(drafts.id, id),
          eq(drafts.rev, expectedRev),
          inArray(drafts.status, [...EDITABLE]),
        ),
      )
      .returning()
    return rows[0] ? rowToDraft(rows[0]) : null
  }

  async claimDraftsForPost(
    workspaceId: string,
    sessionId: string,
    ids: string[],
    staleCutoff: number,
    now: number,
  ): Promise<GuidedReviewCommentDraft[]> {
    if (ids.length === 0) return []
    const rows = await this.db
      .update(drafts)
      .set({ status: 'posting', post_error: null, rev: sql`${drafts.rev} + 1`, updated_at: now })
      .where(
        and(
          eq(drafts.workspace_id, workspaceId),
          eq(drafts.session_id, sessionId),
          inArray(drafts.id, ids),
          or(
            inArray(drafts.status, [...EDITABLE]),
            and(eq(drafts.status, 'posting'), lt(drafts.updated_at, staleCutoff)),
          ),
        ),
      )
      .returning()
    return rows.map(rowToDraft)
  }

  async settleDraftPosts(
    workspaceId: string,
    outcomes: GuidedReviewDraftPostOutcome[],
    now: number,
  ): Promise<void> {
    if (outcomes.length === 0) return
    await this.db.transaction(async (tx) => {
      for (const o of outcomes) {
        await tx
          .update(drafts)
          .set({
            status: o.status,
            posted_url: o.status === 'posted' ? o.postedUrl : null,
            post_error: o.status === 'failed' ? o.error : null,
            rev: sql`${drafts.rev} + 1`,
            updated_at: now,
          })
          .where(
            and(
              eq(drafts.workspace_id, workspaceId),
              eq(drafts.id, o.id),
              eq(drafts.status, 'posting'),
            ),
          )
      }
    })
  }

  async listStaleJobs(
    driver: GuidedReviewDriver,
    cutoff: number,
    limit: number,
  ): Promise<GuidedReviewStaleJob[]> {
    const [overviews, answers] = await Promise.all([
      this.db
        .select({
          workspaceId: sessions.workspace_id,
          id: sessions.id,
          generation: sessions.overview_generation,
          at: sessions.updated_at,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.overview_driver, driver),
            inArray(sessions.overview_status, [...LIVE]),
            lt(sessions.updated_at, cutoff),
          ),
        )
        .orderBy(asc(sessions.updated_at))
        .limit(limit),
      this.db
        .select({ workspaceId: messages.workspace_id, id: messages.id, at: messages.updated_at })
        .from(messages)
        .where(
          and(
            eq(messages.driver, driver),
            eq(messages.role, 'assistant'),
            inArray(messages.status, [...LIVE]),
            lt(messages.updated_at, cutoff),
          ),
        )
        .orderBy(asc(messages.updated_at))
        .limit(limit),
    ])
    const jobs: { at: number; job: GuidedReviewStaleJob }[] = [
      ...overviews.map((r) => ({
        at: r.at,
        job: {
          kind: 'overview' as const,
          workspaceId: r.workspaceId,
          sessionId: r.id,
          generation: r.generation,
        },
      })),
      ...answers.map((r) => ({
        at: r.at,
        job: { kind: 'message' as const, workspaceId: r.workspaceId, messageId: r.id },
      })),
    ]
    return jobs
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((j) => j.job)
  }
}
