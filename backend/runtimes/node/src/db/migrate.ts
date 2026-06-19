import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client.js'

// Idempotent schema bootstrap for the core tables (matching ./schema.ts). Kept as
// hand-written `CREATE TABLE IF NOT EXISTS` so the Node service can self-provision a
// fresh Postgres on first boot and tests get a clean schema with zero tooling. A
// drizzle-kit migration lineage can replace this when migrations need to evolve.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     account_id TEXT,
     owner_user_id BIGINT
   )`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     name TEXT NOT NULL,
     github_account_login TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memberships (
     account_id TEXT NOT NULL,
     user_id BIGINT NOT NULL,
     role TEXT NOT NULL DEFAULT 'member',
     created_at BIGINT NOT NULL,
     PRIMARY KEY (account_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id)`,
  `CREATE TABLE IF NOT EXISTS blocks (
     workspace_id TEXT NOT NULL,
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     type TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     pos_x DOUBLE PRECISION NOT NULL DEFAULT 0,
     pos_y DOUBLE PRECISION NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     progress DOUBLE PRECISION NOT NULL DEFAULT 0,
     depends_on TEXT NOT NULL DEFAULT '[]',
     execution_id TEXT,
     level TEXT NOT NULL DEFAULT 'frame',
     parent_id TEXT,
     confidence DOUBLE PRECISION,
     module_name TEXT,
     fragment_ids TEXT,
     model_id TEXT,
     test_target TEXT,
     pull_request TEXT,
     merge_preset_id TEXT,
     pipeline_id TEXT,
     PRIMARY KEY (workspace_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks (workspace_id, parent_id)`,
  `CREATE TABLE IF NOT EXISTS pipelines (
     workspace_id TEXT NOT NULL,
     id TEXT NOT NULL,
     name TEXT NOT NULL,
     agent_kinds TEXT NOT NULL DEFAULT '[]',
     gates TEXT,
     PRIMARY KEY (workspace_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
     workspace_id TEXT NOT NULL,
     id TEXT NOT NULL,
     kind TEXT NOT NULL,
     block_id TEXT,
     status TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '{}',
     subtasks TEXT,
     error TEXT,
     failure TEXT,
     workflow_instance_id TEXT,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (workspace_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_status_lease ON agent_runs (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_block ON agent_runs (workspace_id, block_id)`,
  `CREATE TABLE IF NOT EXISTS token_usage (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     execution_id TEXT,
     agent_kind TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_estimate DOUBLE PRECISION NOT NULL DEFAULT 0,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at)`,
]

/** Create the core tables if they don't exist. Safe to call on every boot. */
export async function migrate(db: DrizzleDb): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement))
  }
}
