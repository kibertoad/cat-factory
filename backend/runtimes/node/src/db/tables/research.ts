import { bigint, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// Research persistence. Mirrors D1 migration 0115.

/** Account-published research definitions, immutable per version. */
export const researchDefinitions = pgTable(
  'research_definitions',
  {
    account_id: text('account_id').notNull(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.key, t.version] })],
)

/** What each research project pins, and its findings sequence. */
export const researchProjects = pgTable('research_projects', {
  project_id: text('project_id').primaryKey(),
  definition_key: text('definition_key').notNull(),
  definition_version: integer('definition_version').notNull(),
  definition_hash: text('definition_hash').notNull(),
  inputs: text('inputs').notNull(),
  next_seq: integer('next_seq').notNull().default(1),
})

/** The findings sequence number each research task claimed when it first started. */
export const researchTaskSeqs = pgTable(
  'research_task_seqs',
  {
    task_id: text('task_id').primaryKey(),
    project_id: text('project_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [uniqueIndex('idx_research_task_seqs_seq').on(t.project_id, t.seq)],
)

/** Findings revisions, written once each. Exactly one of the two body columns is set. */
export const findingsRevisions = pgTable(
  'findings_revisions',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    task_id: text('task_id').notNull(),
    seq: integer('seq').notNull(),
    mode: text('mode').notNull(),
    definition_key: text('definition_key').notNull(),
    definition_version: integer('definition_version').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    body_inline: text('body_inline'),
    body_artifact_id: text('body_artifact_id'),
    body_bytes: integer('body_bytes').notNull(),
  },
  (t) => [uniqueIndex('idx_findings_revisions_seq').on(t.project_id, t.seq)],
)

/** The findings-storage policy tiers: account, workspace and project. */
export const findingsStoragePolicies = pgTable(
  'findings_storage_policies',
  {
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    policy: text('policy').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_kind, t.owner_id] })],
)
