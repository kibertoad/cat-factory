import { bigint, doublePrecision, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// Postgres schema mirroring the Cloudflare D1 tables column-for-column (snake_case
// field names = column names) so the shared row<->domain mappers in
// @cat-factory/server work unchanged against either store. JSON-shaped columns are
// `text` (the mappers (de)serialise them), and epoch-ms / GitHub-id columns are
// `bigint({ mode: 'number' })` so they read back as JS numbers.

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  account_id: text('account_id'),
  owner_user_id: bigint('owner_user_id', { mode: 'number' }),
})

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  github_account_login: text('github_account_login'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
})

export const memberships = pgTable(
  'memberships',
  {
    account_id: text('account_id').notNull(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    role: text('role').notNull().default('member'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.user_id] })],
)

export const blocks = pgTable(
  'blocks',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    type: text('type').notNull(),
    description: text('description').notNull().default(''),
    pos_x: doublePrecision('pos_x').notNull().default(0),
    pos_y: doublePrecision('pos_y').notNull().default(0),
    status: text('status').notNull(),
    progress: doublePrecision('progress').notNull().default(0),
    depends_on: text('depends_on').notNull().default('[]'),
    execution_id: text('execution_id'),
    level: text('level').notNull().default('frame'),
    parent_id: text('parent_id'),
    confidence: doublePrecision('confidence'),
    module_name: text('module_name'),
    fragment_ids: text('fragment_ids'),
    model_id: text('model_id'),
    test_target: text('test_target'),
    pull_request: text('pull_request'),
    merge_preset_id: text('merge_preset_id'),
    pipeline_id: text('pipeline_id'),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const pipelines = pgTable(
  'pipelines',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    agent_kinds: text('agent_kinds').notNull().default('[]'),
    gates: text('gates'),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const agentRuns = pgTable(
  'agent_runs',
  {
    workspace_id: text('workspace_id').notNull(),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    block_id: text('block_id'),
    status: text('status').notNull(),
    detail: text('detail').notNull().default('{}'),
    subtasks: text('subtasks'),
    error: text('error'),
    failure: text('failure'),
    workflow_instance_id: text('workflow_instance_id'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.id] })],
)

export const tokenUsage = pgTable('token_usage', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  execution_id: text('execution_id'),
  agent_kind: text('agent_kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  input_tokens: integer('input_tokens').notNull().default(0),
  output_tokens: integer('output_tokens').notNull().default(0),
  cost_estimate: doublePrecision('cost_estimate').notNull().default(0),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
})
