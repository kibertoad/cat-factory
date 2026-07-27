import { bigint, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// The ISSUE-TRACKER surface's Drizzle tables, split out of `db/schema.ts` along the boundary the
// architecture already draws: the tracker integration is one opt-in concern (a workspace's tracker
// selection + writeback toggles, its per-source connections and the local projection of the issues
// it imported, and the writeback's own bookkeeping), wired as a unit by `container-github-deps.ts`
// and served by `@cat-factory/integrations`' tracker/writeback modules. Keeping those tables in a
// sibling module — re-exported from `db/schema.ts`, so every importer and drizzle-kit see exactly
// the same surface — makes that grouping visible in the file layout and keeps the core schema
// module under its size budget. Same pattern as `./sandbox.js`.

// A workspace's issue-tracker selection (mirror of D1 migration 0029).
export const trackerSettings = pgTable('tracker_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  tracker: text('tracker'),
  jira_project_key: text('jira_project_key'),
  linear_team_id: text('linear_team_id'),
  // Issue-tracker writeback toggles (0/1): comment on a task's linked issue when its
  // PR opens, and comment + close as resolved when it merges. Per-task overridable.
  writeback_comment_on_pr_open: integer('writeback_comment_on_pr_open').notNull().default(0),
  writeback_resolve_on_merge: integer('writeback_resolve_on_merge').notNull().default(0),
  // Headless clarification loop (mirror of D1 migration 0062): echo a PARKED public-API run's
  // open requirements findings onto the task's linked tracker issue(s). Per-task overridable.
  writeback_questions_on_park: integer('writeback_questions_on_park').notNull().default(0),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Idempotency markers for the question writeback above (mirror of D1 migration 0062): one row
// per (workspace, review, iteration, linked issue). The post runs in the DURABLE driver, whose
// steps replay, so the row is CLAIMED before the comment is attempted — otherwise every replay
// of a parked gate step would re-post the same findings. A `failed` row is re-claimable (retry
// a tracker outage); `posted` is terminal for that iteration.
export const reviewQuestionPosts = pgTable(
  'review_question_posts',
  {
    workspace_id: text('workspace_id').notNull(),
    review_id: text('review_id').notNull(),
    iteration: integer('iteration').notNull(),
    issue_ref: text('issue_ref').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.review_id, t.iteration, t.issue_ref] })],
)

// Task-source integration (mirror of D1 migration 0014): a workspace's connections
// to external issue trackers (Jira) and local projections of the issues it imported.
// `credentials` is an encrypted JSON bag (AES-256-GCM envelope), never sent on the
// wire. At most one live connection per (workspace, source); a `deleted_at` tombstone
// lets a workspace disconnect/reconnect.
export const taskConnections = pgTable(
  'task_connections',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    credentials: text('credentials').notNull(),
    label: text('label').notNull().default(''),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.source] })],
)

// Per-workspace task-source toggle (mirrors D1 migration 0008). No row ⇒ the
// default (enabled), so a source is offered as soon as it's available; an
// `enabled: false` row is an explicit opt-out. Replaces the TASK_SOURCES env gate.
export const taskSourceSettings = pgTable(
  'task_source_settings',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    // Integer 0/1 to match the D1 (SQLite) store, per this file's boolean convention.
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.source] })],
)

export const tasks = pgTable(
  'tasks',
  {
    workspace_id: text('workspace_id').notNull(),
    source: text('source').notNull(),
    external_id: text('external_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    status: text('status').notNull().default(''),
    type: text('type').notNull().default(''),
    assignee: text('assignee'),
    priority: text('priority'),
    labels: text('labels').notNull().default('[]'),
    description: text('description').notNull().default(''),
    comments: text('comments').notNull().default('[]'),
    excerpt: text('excerpt').notNull().default(''),
    linked_block_id: text('linked_block_id'),
    synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.source, t.external_id] }),
    index('idx_tasks_block').on(t.workspace_id, t.linked_block_id),
  ],
)
