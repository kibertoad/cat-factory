import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// Postgres schema mirroring the Cloudflare D1 tables column-for-column (snake_case
// field names = column names) so the shared row<->domain mappers in
// @cat-factory/server work unchanged against either store. JSON-shaped columns are
// `text` (the mappers (de)serialise them), and epoch-ms / GitHub-id columns are
// `bigint({ mode: 'number' })` so they read back as JS numbers. The indexes mirror
// the D1 migrations 1:1 so query plans (and the unique personal-account constraint)
// match across stores.

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    account_id: text('account_id'),
    owner_user_id: bigint('owner_user_id', { mode: 'number' }),
  },
  // listVisible filters by owner_user_id (legacy) and account_id (membership scope).
  (t) => [
    index('idx_workspaces_owner').on(t.owner_user_id),
    index('idx_workspaces_account').on(t.account_id),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    github_account_login: text('github_account_login'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  // Enforce one personal account per GitHub login (a correctness constraint, not just
  // a lookup index) — the partial unique index `findPersonalByLogin` relies on.
  (t) => [
    uniqueIndex('idx_accounts_personal')
      .on(t.github_account_login)
      .where(sql`type = 'personal'`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    account_id: text('account_id').notNull(),
    user_id: bigint('user_id', { mode: 'number' }).notNull(),
    role: text('role').notNull().default('member'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.user_id] }),
    index('idx_memberships_user').on(t.user_id),
  ],
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
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    index('idx_blocks_parent').on(t.workspace_id, t.parent_id),
  ],
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
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.id] }),
    // listByWorkspace filters by workspace_id and orders by created_at.
    index('idx_agent_runs_workspace').on(t.workspace_id, t.created_at),
    index('idx_agent_runs_status_lease').on(t.status, t.updated_at),
    index('idx_agent_runs_block').on(t.workspace_id, t.block_id),
  ],
)

export const tokenUsage = pgTable(
  'token_usage',
  {
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
  },
  (t) => [index('idx_token_usage_created').on(t.created_at)],
)

// LLM observability sink (mirror of D1 migration 0026). One row per proxied
// container-agent model call: full prompt/response, output-limit headroom and the
// transport-vs-execution latency split. Pruned aggressively by retention (the full
// bodies make it heavy); booleans are integer 0/1 to match the SQLite store.
export const llmCallMetrics = pgTable(
  'llm_call_metrics',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id'),
    agent_kind: text('agent_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    streaming: integer('streaming').notNull().default(0),
    message_count: integer('message_count').notNull().default(0),
    tool_count: integer('tool_count').notNull().default(0),
    request_max_tokens: integer('request_max_tokens'),
    prompt_tokens: integer('prompt_tokens').notNull().default(0),
    completion_tokens: integer('completion_tokens').notNull().default(0),
    total_tokens: integer('total_tokens').notNull().default(0),
    finish_reason: text('finish_reason'),
    upstream_ms: integer('upstream_ms').notNull().default(0),
    overhead_ms: integer('overhead_ms').notNull().default(0),
    total_ms: integer('total_ms').notNull().default(0),
    ok: integer('ok').notNull().default(1),
    http_status: integer('http_status'),
    error_message: text('error_message'),
    // prompt_text is stored as a DELTA (only the messages this call appended beyond
    // prompt_prefix_count); the full prompt is rebuilt on export. See D1 migration 0027.
    prompt_text: text('prompt_text').notNull().default(''),
    prompt_prefix_count: integer('prompt_prefix_count').notNull().default(0),
    prompt_hash: text('prompt_hash').notNull().default(''),
    response_text: text('response_text').notNull().default(''),
  },
  (t) => [
    index('idx_llm_call_metrics_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_llm_call_metrics_created').on(t.created_at),
  ],
)
