import type {
  GuidedReviewCommentDraft,
  GuidedReviewDraftEdit,
  GuidedReviewDriver,
  GuidedReviewInvestigationRecord,
  GuidedReviewExchange,
  GuidedReviewDraftPostOutcome,
  GuidedReviewMessage,
  GuidedReviewMessageOutcome,
  GuidedReviewNewSession,
  GuidedReviewOverviewOutcome,
  GuidedReviewRefresh,
  GuidedReviewRepository,
  GuidedReviewSession,
  GuidedReviewSessionFilter,
  GuidedReviewStaleJob,
  GuidedReviewThread,
  GuidedReviewThreadSummary,
} from '@cat-factory/kernel'
import {
  decodeGuidedReviewInvestigation,
  rowToGuidedReviewDraft as rowToDraft,
  rowToGuidedReviewMessage as rowToMessage,
  rowToGuidedReviewSession as rowToSession,
  rowToGuidedReviewThread as rowToThread,
} from '@cat-factory/server'
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  guidedReviewCommentDrafts as drafts,
  guidedReviewMessages as messages,
  guidedReviewSessions as sessions,
  guidedReviewThreads as threads,
} from '../../db/schema.js'

const LIVE = ['pending', 'running'] as const
const EDITABLE = ['proposed', 'failed'] as const

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
    s: GuidedReviewNewSession,
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
        overview_status: 'pending',
        overview_generation: 1,
        overview_content: null,
        overview_failure: null,
        overview_model: null,
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
    x: GuidedReviewExchange,
    driver: GuidedReviewDriver,
  ): Promise<
    | { ok: true; question: GuidedReviewMessage; placeholder: GuidedReviewMessage }
    | { ok: false; reason: 'thread_busy' | 'thread_not_found' }
  > {
    return this.db.transaction(async (tx) => {
      // Lock the thread first. Without it two writers read the same MAX(seq) and the loser trips
      // the seq index (not the conflict target) before the live-answer conflict can resolve.
      const locked = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.workspace_id, workspaceId),
            eq(threads.id, x.threadId),
            eq(threads.session_id, x.sessionId),
          ),
        )
        .for('update')
      if (locked.length === 0) return { ok: false, reason: 'thread_not_found' } as const
      const shared = {
        workspace_id: workspaceId,
        thread_id: x.threadId,
        session_id: x.sessionId,
        kind: x.kind,
        depth: x.depth,
        citations: '[]',
        failure: null,
        draft_report: null,
        model: null,
        created_at: x.at,
        updated_at: x.at,
        driver,
      }
      const nextSeq = sql<number>`(SELECT COALESCE(MAX(${messages.seq}), 0) + 2
        FROM ${messages}
        WHERE ${messages.workspace_id} = ${workspaceId}
          AND ${messages.thread_id} = ${x.threadId})`
      const [placed] = await tx
        .insert(messages)
        .values({
          ...shared,
          id: x.placeholderId,
          seq: nextSeq,
          role: 'assistant',
          content: '',
          status: 'pending',
        })
        .onConflictDoNothing({
          target: [messages.workspace_id, messages.thread_id],
          // Must mirror idx_guided_review_messages_live exactly.
          where: sql`${messages.role} = 'assistant' AND ${messages.status} IN ('pending', 'running')`,
        })
        .returning()
      if (!placed) return { ok: false, reason: 'thread_busy' } as const
      const [asked] = await tx
        .insert(messages)
        .values({
          ...shared,
          id: x.questionId,
          seq: placed.seq - 1,
          role: 'user',
          content: x.question,
          status: 'complete',
        })
        .returning()
      if (!asked) throw new Error(`guided review question ${x.questionId} was not stored`)
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

  async recordInvestigation(
    workspaceId: string,
    id: string,
    investigation: GuidedReviewInvestigationRecord,
    now: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ investigation: JSON.stringify(investigation), claimed_at: now, updated_at: now })
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

  async getInvestigation(
    workspaceId: string,
    id: string,
  ): Promise<GuidedReviewInvestigationRecord | null> {
    const rows = await this.db
      .select({ investigation: messages.investigation })
      .from(messages)
      .where(and(eq(messages.workspace_id, workspaceId), eq(messages.id, id)))
      .limit(1)
    return decodeGuidedReviewInvestigation(rows[0]?.investigation ?? null, id)
  }

  async heartbeatMessage(workspaceId: string, id: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ claimed_at: now, updated_at: now })
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
            eq(messages.kind, 'comment-drafts'),
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
            message_id: messageId,
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
    leaseCutoff: number,
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
            and(eq(drafts.status, 'posting'), lt(drafts.updated_at, leaseCutoff)),
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
    const rows = sql.join(
      outcomes.map(
        (o) =>
          sql`(${o.id}::text, ${o.status}::text, ${o.status === 'posted' ? o.postedUrl : null}::text, ${o.status === 'failed' ? o.error : null}::text)`,
      ),
      sql`, `,
    )
    await this.db.execute(sql`
      UPDATE ${drafts} SET
        status = o.status, posted_url = o.posted_url, post_error = o.post_error,
        rev = ${drafts.rev} + 1, updated_at = ${now}
      FROM (VALUES ${rows}) AS o(id, status, posted_url, post_error)
      WHERE ${drafts.workspace_id} = ${workspaceId} AND ${drafts.id} = o.id
        AND ${drafts.status} = 'posting'`)
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
