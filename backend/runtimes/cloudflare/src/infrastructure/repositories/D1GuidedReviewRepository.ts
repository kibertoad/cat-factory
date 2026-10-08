import type {
  GuidedReviewCommentDraft,
  GuidedReviewDraftEdit,
  GuidedReviewDriver,
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
  GuidedReviewSessionPage,
  GuidedReviewStaleJob,
  GuidedReviewThread,
  GuidedReviewThreadSummary,
} from '@cat-factory/kernel'
import {
  rowToGuidedReviewDraft as rowToDraft,
  rowToGuidedReviewMessage as rowToMessage,
  rowToGuidedReviewSession as rowToSession,
  rowToGuidedReviewThread as rowToThread,
  type GuidedReviewDraftRow as DraftRow,
  type GuidedReviewMessageRow as MessageRow,
  type GuidedReviewSessionRow as SessionRow,
  type GuidedReviewThreadRow,
} from '@cat-factory/server'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

type ThreadRow = GuidedReviewThreadRow & { pending_message_id: string | null }

const LIVE = `('pending', 'running')`

/**
 * Guided PR review sessions over D1 (migration 0104). Every conditional transition is a single
 * guarded statement or an atomic `batch`, and SQLite serializes writers, so each batch observes
 * one consistent snapshot. The Drizzle mirror reaches the same outcomes under Postgres READ
 * COMMITTED through the same unique indexes.
 */
export class D1GuidedReviewRepository implements GuidedReviewRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async openSession(
    workspaceId: string,
    s: GuidedReviewNewSession,
    driver: GuidedReviewDriver,
  ): Promise<GuidedReviewSession> {
    await this.db
      .prepare(
        `INSERT INTO guided_review_sessions
           (workspace_id, id, provider, repo_id, owner, repo, pr_number, pr_title,
            reviewed_head_sha, base_ref, created_by, created_by_kind, overview_status,
            overview_generation, overview_content, overview_failure, overview_model,
            overview_driver, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT (workspace_id, repo_id, pr_number, created_by) DO NOTHING`,
      )
      .bind(
        workspaceId,
        s.id,
        s.provider,
        s.repoId,
        s.owner,
        s.repo,
        s.prNumber,
        s.prTitle,
        s.reviewedHeadSha,
        s.baseRef,
        s.createdBy,
        s.createdByKind,
        driver,
        s.createdAt,
        s.updatedAt,
      )
      .run()
    const row = await this.db
      .prepare(
        `SELECT * FROM guided_review_sessions
           WHERE workspace_id = ? AND repo_id = ? AND pr_number = ? AND created_by = ?`,
      )
      .bind(workspaceId, s.repoId, s.prNumber, s.createdBy)
      .first<SessionRow>()
    if (!row) throw new Error(`guided review session for PR #${s.prNumber} vanished after insert`)
    return rowToSession(row)
  }

  async getSession(workspaceId: string, id: string): Promise<GuidedReviewSession | null> {
    const row = await this.db
      .prepare(`SELECT * FROM guided_review_sessions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<SessionRow>()
    return row ? rowToSession(row) : null
  }

  async listSessions(
    workspaceId: string,
    filter: GuidedReviewSessionFilter,
  ): Promise<GuidedReviewSession[]> {
    const { where, binds } = sessionFilter(workspaceId, filter)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM guided_review_sessions WHERE ${where.join(' AND ')}
           ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .bind(...binds, filter.limit ?? 50)
      .all<SessionRow>()
    return results.map(rowToSession)
  }

  async pageSessions(
    workspaceId: string,
    filter: Omit<GuidedReviewSessionFilter, 'limit'>,
    page: GuidedReviewSessionPage,
  ): Promise<GuidedReviewSession[]> {
    const { where, binds } = sessionFilter(workspaceId, filter)
    if (page.cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id)
    }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM guided_review_sessions WHERE ${where.join(' AND ')}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...binds, page.limit)
      .all<SessionRow>()
    return results.map(rowToSession)
  }

  async deleteSession(workspaceId: string, id: string): Promise<void> {
    const tables = [
      'guided_review_comment_drafts',
      'guided_review_messages',
      'guided_review_threads',
    ] as const
    await this.db.batch([
      ...tables.map((t) =>
        this.db
          .prepare(`DELETE FROM ${t} WHERE workspace_id = ? AND session_id = ?`)
          .bind(workspaceId, id),
      ),
      this.db
        .prepare(`DELETE FROM guided_review_sessions WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, id),
    ])
  }

  async restartOverview(
    workspaceId: string,
    id: string,
    expectedGeneration: number,
    refresh: GuidedReviewRefresh,
    driver: GuidedReviewDriver,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE guided_review_sessions SET
           pr_title = ?, reviewed_head_sha = ?, base_ref = ?, overview_driver = ?,
           overview_status = 'pending', overview_generation = overview_generation + 1,
           overview_content = NULL, overview_failure = NULL, overview_model = NULL,
           overview_claimed_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND overview_generation = ?`,
      )
      .bind(
        refresh.prTitle,
        refresh.reviewedHeadSha,
        refresh.baseRef,
        driver,
        now,
        workspaceId,
        id,
        expectedGeneration,
      )
      .run()
    return result.meta.changes > 0
  }

  async claimOverview(
    workspaceId: string,
    id: string,
    generation: number,
    leaseCutoff: number,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE guided_review_sessions SET
           overview_status = 'running', overview_claimed_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND overview_generation = ?
           AND (overview_status = 'pending'
                OR (overview_status = 'running' AND overview_claimed_at < ?))`,
      )
      .bind(now, now, workspaceId, id, generation, leaseCutoff)
      .run()
    return result.meta.changes > 0
  }

  async settleOverview(
    workspaceId: string,
    id: string,
    generation: number,
    outcome: GuidedReviewOverviewOutcome,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE guided_review_sessions SET
           overview_status = ?, overview_content = ?, overview_failure = ?, overview_model = ?,
           overview_claimed_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND overview_generation = ?
           AND overview_status = 'running'`,
      )
      .bind(
        outcome.status,
        outcome.status === 'complete' ? JSON.stringify(outcome.content) : null,
        outcome.status === 'failed' ? JSON.stringify(outcome.failure) : null,
        outcome.model,
        now,
        workspaceId,
        id,
        generation,
      )
      .run()
    return result.meta.changes > 0
  }

  async createThread(workspaceId: string, t: GuidedReviewThread): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO guided_review_threads
           (workspace_id, id, session_id, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, t.id, t.sessionId, t.title, t.createdBy, t.createdAt, t.updatedAt)
      .run()
  }

  async getThread(workspaceId: string, id: string): Promise<GuidedReviewThread | null> {
    const row = await this.db
      .prepare(`SELECT * FROM guided_review_threads WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ThreadRow>()
    return row ? rowToThread(row) : null
  }

  async listThreads(workspaceId: string, sessionId: string): Promise<GuidedReviewThreadSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.*, m.id AS pending_message_id
           FROM guided_review_threads t
           LEFT JOIN guided_review_messages m
             ON m.workspace_id = t.workspace_id AND m.thread_id = t.id
            AND m.role = 'assistant' AND m.status IN ${LIVE}
          WHERE t.workspace_id = ? AND t.session_id = ?
          ORDER BY t.created_at, t.id`,
      )
      .bind(workspaceId, sessionId)
      .all<ThreadRow>()
    return results.map((row) => ({
      ...rowToThread(row),
      pendingMessageId: row.pending_message_id ?? null,
    }))
  }

  async appendExchange(
    workspaceId: string,
    x: GuidedReviewExchange,
    driver: GuidedReviewDriver,
  ): Promise<
    | { ok: true; question: GuidedReviewMessage; placeholder: GuidedReviewMessage }
    | { ok: false; reason: 'thread_busy' | 'thread_not_found' }
  > {
    // The placeholder goes first, conflict-targeted at the one-live-answer index and inserted
    // only while the thread exists in the session. The question follows only if that placeholder
    // row now exists. Both sit in one serialized batch.
    const columns = `(workspace_id, id, thread_id, session_id, seq, role, kind, depth, content,
                      status, citations, failure, draft_report, model, created_at, updated_at,
                      driver)`
    const placePlaceholder = this.db
      .prepare(
        `INSERT INTO guided_review_messages ${columns}
         SELECT ?1, ?2, ?3, ?4,
                (SELECT COALESCE(MAX(seq), 0) + 2 FROM guided_review_messages
                  WHERE workspace_id = ?1 AND thread_id = ?3),
                'assistant', ?5, ?6, '', 'pending', '[]', NULL, NULL, NULL, ?7, ?7, ?8
         WHERE EXISTS (SELECT 1 FROM guided_review_threads
                        WHERE workspace_id = ?1 AND id = ?3 AND session_id = ?4)
         ON CONFLICT (workspace_id, thread_id)
           WHERE role = 'assistant' AND status IN ${LIVE} DO NOTHING`,
      )
      .bind(workspaceId, x.placeholderId, x.threadId, x.sessionId, x.kind, x.depth, x.at, driver)
    const placeQuestion = this.db
      .prepare(
        `INSERT INTO guided_review_messages ${columns}
         SELECT ?1, ?2, ?3, ?4, p.seq - 1, 'user', ?5, ?6, ?7, 'complete', '[]', NULL, NULL,
                NULL, ?8, ?8, ?9
           FROM guided_review_messages p
          WHERE p.workspace_id = ?1 AND p.id = ?10`,
      )
      .bind(
        workspaceId,
        x.questionId,
        x.threadId,
        x.sessionId,
        x.kind,
        x.depth,
        x.question,
        x.at,
        driver,
        x.placeholderId,
      )
    const [placed] = await this.db.batch([placePlaceholder, placeQuestion])
    if (!placed || placed.meta.changes === 0) {
      const thread = await this.db
        .prepare(
          `SELECT 1 AS found FROM guided_review_threads
             WHERE workspace_id = ? AND id = ? AND session_id = ?`,
        )
        .bind(workspaceId, x.threadId, x.sessionId)
        .first<{ found: number }>()
      return { ok: false, reason: thread ? 'thread_busy' : 'thread_not_found' }
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM guided_review_messages WHERE workspace_id = ? AND id IN (?, ?)`)
      .bind(workspaceId, x.questionId, x.placeholderId)
      .all<MessageRow>()
    const byId = new Map(results.map((r) => [r.id, rowToMessage(r)]))
    const question = byId.get(x.questionId)
    const placeholder = byId.get(x.placeholderId)
    if (!question || !placeholder) {
      throw new Error(`guided review exchange ${x.placeholderId} vanished after insert`)
    }
    return { ok: true, question, placeholder }
  }

  async getMessage(workspaceId: string, id: string): Promise<GuidedReviewMessage | null> {
    const row = await this.db
      .prepare(`SELECT * FROM guided_review_messages WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<MessageRow>()
    return row ? rowToMessage(row) : null
  }

  async listMessages(workspaceId: string, threadId: string): Promise<GuidedReviewMessage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM guided_review_messages WHERE workspace_id = ? AND thread_id = ?
           ORDER BY seq`,
      )
      .bind(workspaceId, threadId)
      .all<MessageRow>()
    return results.map(rowToMessage)
  }

  async claimMessage(
    workspaceId: string,
    id: string,
    leaseCutoff: number,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE guided_review_messages SET status = 'running', claimed_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND role = 'assistant'
           AND (status = 'pending' OR (status = 'running' AND claimed_at < ?))`,
      )
      .bind(now, now, workspaceId, id, leaseCutoff)
      .run()
    return result.meta.changes > 0
  }

  async settleMessage(
    workspaceId: string,
    id: string,
    outcome: GuidedReviewMessageOutcome,
    now: number,
  ): Promise<boolean> {
    const result = await this.settleMessageStatement(workspaceId, id, outcome, now).run()
    return result.meta.changes > 0
  }

  private settleMessageStatement(
    workspaceId: string,
    id: string,
    outcome: GuidedReviewMessageOutcome,
    now: number,
    kind?: GuidedReviewMessage['kind'],
  ): D1PreparedStatement {
    const complete = outcome.status === 'complete'
    return this.db
      .prepare(
        `UPDATE guided_review_messages SET
           status = ?, content = ?, citations = ?, failure = ?, draft_report = ?, model = ?,
           claimed_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'running'
           ${kind ? 'AND kind = ?' : ''}`,
      )
      .bind(
        outcome.status,
        complete ? outcome.content : '',
        JSON.stringify(complete ? outcome.citations : []),
        complete ? null : JSON.stringify(outcome.failure),
        complete && outcome.draftReport ? JSON.stringify(outcome.draftReport) : null,
        outcome.model,
        now,
        workspaceId,
        id,
        ...(kind ? [kind] : []),
      )
  }

  async settleDrafts(
    workspaceId: string,
    messageId: string,
    drafts: GuidedReviewCommentDraft[],
    outcome: Extract<GuidedReviewMessageOutcome, { status: 'complete' }>,
    now: number,
  ): Promise<boolean> {
    // Each draft is inserted only while its message is still a `running` `comment-drafts`
    // message; the message settles last, so either the whole set lands with it or none does.
    const running = `EXISTS (SELECT 1 FROM guided_review_messages
                              WHERE workspace_id = ? AND id = ? AND status = 'running'
                                AND kind = 'comment-drafts')`
    const inserts = drafts.map((d) =>
      this.db
        .prepare(
          `INSERT INTO guided_review_comment_drafts
             (workspace_id, id, session_id, thread_id, message_id, path, line, start_line, side,
              body, rationale, status, post_error, posted_url, rev, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${running}`,
        )
        .bind(
          workspaceId,
          d.id,
          d.sessionId,
          d.threadId,
          messageId,
          d.path,
          d.line,
          d.startLine,
          d.side,
          d.body,
          d.rationale,
          d.status,
          d.postError,
          d.postedUrl,
          d.rev,
          d.createdAt,
          d.updatedAt,
          workspaceId,
          messageId,
        ),
    )
    const results = await this.db.batch([
      ...inserts,
      this.settleMessageStatement(workspaceId, messageId, outcome, now, 'comment-drafts'),
    ])
    return (results.at(-1)?.meta.changes ?? 0) > 0
  }

  async getDraft(workspaceId: string, id: string): Promise<GuidedReviewCommentDraft | null> {
    const row = await this.db
      .prepare(`SELECT * FROM guided_review_comment_drafts WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<DraftRow>()
    return row ? rowToDraft(row) : null
  }

  async listDrafts(workspaceId: string, sessionId: string): Promise<GuidedReviewCommentDraft[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM guided_review_comment_drafts WHERE workspace_id = ? AND session_id = ?
           ORDER BY created_at, id`,
      )
      .bind(workspaceId, sessionId)
      .all<DraftRow>()
    return results.map(rowToDraft)
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
    const row = await this.db
      .prepare(
        `UPDATE guided_review_comment_drafts SET
           path = ?, line = ?, start_line = ?, side = ?, body = ?, status = ?, post_error = ?,
           rev = rev + 1, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND rev = ? AND status IN ('proposed', 'failed')
         RETURNING *`,
      )
      .bind(
        edit.path ?? current.path,
        edit.line ?? current.line,
        edit.startLine === undefined ? current.startLine : edit.startLine,
        edit.side ?? current.side,
        edit.body ?? current.body,
        edit.discard ? 'discarded' : current.status,
        edit.discard ? null : current.postError,
        now,
        workspaceId,
        id,
        expectedRev,
      )
      .first<DraftRow>()
    return row ? rowToDraft(row) : null
  }

  async claimDraftsForPost(
    workspaceId: string,
    sessionId: string,
    ids: string[],
    leaseCutoff: number,
    now: number,
  ): Promise<GuidedReviewCommentDraft[]> {
    const claimed: GuidedReviewCommentDraft[] = []
    for (const chunk of chunkForIn(ids)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `UPDATE guided_review_comment_drafts SET status = 'posting', post_error = NULL,
             rev = rev + 1, updated_at = ?
           WHERE workspace_id = ? AND session_id = ? AND id IN (${placeholders})
             AND (status IN ('proposed', 'failed')
                  OR (status = 'posting' AND updated_at < ?))
           RETURNING *`,
        )
        .bind(now, workspaceId, sessionId, ...chunk, leaseCutoff)
        .all<DraftRow>()
      claimed.push(...results.map(rowToDraft))
    }
    return claimed
  }

  async settleDraftPosts(
    workspaceId: string,
    outcomes: GuidedReviewDraftPostOutcome[],
    now: number,
  ): Promise<void> {
    if (outcomes.length === 0) return
    await this.db.batch(
      outcomes.map((o) =>
        this.db
          .prepare(
            `UPDATE guided_review_comment_drafts SET
               status = ?, posted_url = ?, post_error = ?, rev = rev + 1, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'posting'`,
          )
          .bind(
            o.status,
            o.status === 'posted' ? o.postedUrl : null,
            o.status === 'failed' ? o.error : null,
            now,
            workspaceId,
            o.id,
          ),
      ),
    )
  }

  async listStaleJobs(
    driver: GuidedReviewDriver,
    cutoff: number,
    limit: number,
  ): Promise<GuidedReviewStaleJob[]> {
    const [overviews, messages] = await this.db.batch<Record<string, unknown>>([
      this.db
        .prepare(
          `SELECT workspace_id, id, overview_generation, updated_at FROM guided_review_sessions
             WHERE overview_driver = ? AND overview_status IN ${LIVE} AND updated_at < ?
             ORDER BY updated_at LIMIT ?`,
        )
        .bind(driver, cutoff, limit),
      this.db
        .prepare(
          `SELECT workspace_id, id, updated_at FROM guided_review_messages
             WHERE driver = ? AND role = 'assistant' AND status IN ${LIVE} AND updated_at < ?
             ORDER BY updated_at LIMIT ?`,
        )
        .bind(driver, cutoff, limit),
    ])
    type Stale = { workspace_id: string; id: string; updated_at: number }
    const overviewRows = (overviews?.results ?? []) as (Stale & { overview_generation: number })[]
    const messageRows = (messages?.results ?? []) as Stale[]
    const jobs: { at: number; job: GuidedReviewStaleJob }[] = [
      ...overviewRows.map((r) => ({
        at: r.updated_at,
        job: {
          kind: 'overview' as const,
          workspaceId: r.workspace_id,
          sessionId: r.id,
          generation: r.overview_generation,
        },
      })),
      ...messageRows.map((r) => ({
        at: r.updated_at,
        job: { kind: 'message' as const, workspaceId: r.workspace_id, messageId: r.id },
      })),
    ]
    return jobs
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((j) => j.job)
  }
}

/** The WHERE clause both session lists share: the workspace plus each filter the caller set. */
function sessionFilter(
  workspaceId: string,
  filter: Omit<GuidedReviewSessionFilter, 'limit'>,
): { where: string[]; binds: unknown[] } {
  const where = ['workspace_id = ?']
  const binds: unknown[] = [workspaceId]
  if (filter.repoId !== undefined) {
    where.push('repo_id = ?')
    binds.push(filter.repoId)
  }
  if (filter.prNumber !== undefined) {
    where.push('pr_number = ?')
    binds.push(filter.prNumber)
  }
  if (filter.createdBy !== undefined) {
    where.push('created_by = ?')
    binds.push(filter.createdBy)
  }
  return { where, binds }
}
