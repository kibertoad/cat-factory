import { bigint, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

// What projects of any kind keep. Mirrors D1 migrations 0115 and 0116. Definition specs and outcome bodies
// are opaque JSON; the project kind owns their shape.

/** Account-published project definitions, immutable per version. */
export const projectDefinitions = pgTable(
  'project_definitions',
  {
    account_id: text('account_id').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.kind, t.key, t.version] })],
)

/** The definition version each project pins, with its input values. */
export const projectPins = pgTable('project_pins', {
  project_id: text('project_id').primaryKey(),
  definition_key: text('definition_key').notNull(),
  definition_version: integer('definition_version').notNull(),
  definition_hash: text('definition_hash').notNull(),
  inputs: text('inputs').notNull(),
})

/** Each project's next outcome sequence number. */
export const projectOutcomeSeqs = pgTable('project_outcome_seqs', {
  project_id: text('project_id').primaryKey(),
  next_seq: integer('next_seq').notNull(),
})

/** The outcome sequence number each project task claimed when it first started. */
export const projectTaskSeqs = pgTable(
  'project_task_seqs',
  {
    task_id: text('task_id').primaryKey(),
    project_id: text('project_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [uniqueIndex('idx_project_task_seqs_seq').on(t.project_id, t.seq)],
)

/** Outcome revisions, written once each. Exactly one of the two body columns is set. */
export const projectOutcomes = pgTable(
  'project_outcomes',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    stream: text('stream').notNull(),
    seq: integer('seq').notNull(),
    intent: text('intent').notNull(),
    schema_version: integer('schema_version').notNull(),
    task_id: text('task_id'),
    definition_key: text('definition_key'),
    definition_version: integer('definition_version'),
    artifact_refs: text('artifact_refs').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    body_inline: text('body_inline'),
    body_artifact_id: text('body_artifact_id'),
    body_bytes: integer('body_bytes').notNull(),
  },
  (t) => [uniqueIndex('idx_project_outcomes_seq').on(t.project_id, t.seq)],
)

/** The outcome-storage policy tiers: account, workspace and project. */
export const outcomeStoragePolicies = pgTable(
  'outcome_storage_policies',
  {
    owner_kind: text('owner_kind').notNull(),
    owner_id: text('owner_id').notNull(),
    policy: text('policy').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_kind, t.owner_id] })],
)
