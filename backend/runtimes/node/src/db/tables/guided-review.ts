import { sql } from 'drizzle-orm'
import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// Guided PR review sessions (docs/initiatives/guided-pr-review.md), mirroring the Cloudflare D1
// tables (migration 0104) column-for-column and index-for-index.

export const guidedReviewSessions = pgTable(
  'guided_review_sessions',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    provider: text('provider').notNull(),
    repo_id: text('repo_id').notNull(),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    pr_number: integer('pr_number').notNull(),
    pr_title: text('pr_title').notNull(),
    reviewed_head_sha: text('reviewed_head_sha').notNull(),
    base_ref: text('base_ref').notNull(),
    created_by: text('created_by').notNull(),
    overview_status: text('overview_status').notNull(),
    overview_generation: integer('overview_generation').notNull(),
    overview_content: text('overview_content'),
    overview_failure: text('overview_failure'),
    overview_model: text('overview_model'),
    overview_claimed_at: bigint('overview_claimed_at', { mode: 'number' }),
    overview_driver: text('overview_driver').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    uniqueIndex('idx_guided_review_sessions_pr').on(
      t.workspace_id,
      t.repo_id,
      t.pr_number,
      t.created_by,
    ),
    index('idx_guided_review_sessions_stale').on(
      t.overview_driver,
      t.overview_status,
      t.updated_at,
    ),
  ],
)

export const guidedReviewThreads = pgTable(
  'guided_review_threads',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    session_id: text('session_id').notNull(),
    title: text('title').notNull(),
    created_by: text('created_by').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_guided_review_threads_session').on(t.workspace_id, t.session_id),
  ],
)

export const guidedReviewMessages = pgTable(
  'guided_review_messages',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    thread_id: text('thread_id').notNull(),
    session_id: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    kind: text('kind').notNull(),
    depth: text('depth').notNull(),
    content: text('content').notNull(),
    status: text('status').notNull(),
    citations: text('citations').notNull().default('[]'),
    failure: text('failure'),
    draft_report: text('draft_report'),
    investigation: text('investigation'),
    model: text('model'),
    claimed_at: bigint('claimed_at', { mode: 'number' }),
    driver: text('driver').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    uniqueIndex('idx_guided_review_messages_seq').on(t.workspace_id, t.thread_id, t.seq),
    // A thread waits on at most one answer at a time; a second question is refused as thread_busy.
    uniqueIndex('idx_guided_review_messages_live')
      .on(t.workspace_id, t.thread_id)
      .where(sql`${t.role} = 'assistant' AND ${t.status} IN ('pending', 'running')`),
    index('idx_guided_review_messages_stale').on(t.driver, t.status, t.updated_at),
  ],
)

export const guidedReviewCommentDrafts = pgTable(
  'guided_review_comment_drafts',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    session_id: text('session_id').notNull(),
    thread_id: text('thread_id').notNull(),
    message_id: text('message_id').notNull(),
    path: text('path').notNull(),
    line: integer('line').notNull(),
    start_line: integer('start_line'),
    side: text('side').notNull(),
    body: text('body').notNull(),
    rationale: text('rationale').notNull(),
    status: text('status').notNull(),
    post_error: text('post_error'),
    posted_url: text('posted_url'),
    rev: integer('rev').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_guided_review_comment_drafts_session').on(t.workspace_id, t.session_id),
  ],
)
