import { bigint, doublePrecision, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The SETTINGS tables: the rows that hold what a deployment, a workspace or a person has
// CONFIGURED, as opposed to the work itself. One cohesive group — a per-deployment
// singleton (`local_settings`), the per-user budget (`user_settings`), the per-workspace
// runtime policy row (`workspace_settings`, which also carries the custom metadata bag),
// and the per-workspace-per-agent-kind generation knob (`workspace_agent_settings`).
//
// Split out of `../schema.ts` so that module stays inside its size budget, exactly as
// `tables/identity.ts` and `tables/vcs.ts` were; it re-exports everything here, so every
// importer (and drizzle-kit, which follows the re-export) still reaches these through
// `db/schema.js`. Columns mirror the Cloudflare D1 tables one-for-one, per the
// runtime-symmetry rule.
// ---------------------------------------------------------------------------

// Local-mode operational settings — a per-DEPLOYMENT SINGLETON (one developer's machine),
// addressed by a fixed `id` ('local'). `config` is non-secret tuning JSON (warm-pool
// sizing + per-repo checkout reuse) that replaced the `LOCAL_POOL_*` / `HARNESS_*` env
// vars. LOCAL-MODE-ONLY: the warm pool is the local Docker-family runner's differentiator,
// so this table has NO D1 mirror (the symmetry rule's runtime-specific carve-out). A
// missing row means all defaults (pooling off).
export const localSettings = pgTable('local_settings', {
  id: text('id').primaryKey(),
  config: text('config').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const userSettings = pgTable('user_settings', {
  user_id: text('user_id').primaryKey(),
  // The user-tier monthly spend budget (base pricing currency). Null = none.
  spend_monthly_limit: doublePrecision('spend_monthly_limit'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Per-user in-app tutorial progress (mirror of D1 migration 0080). PK is the user id, like
// `user_settings` above. Mirrors the SPA's browser-persisted store so a person's walkthrough
// history follows THEM rather than a browser profile.
//
// The two id lists are JSON arrays rather than a join table: grow-only sets of at most a few dozen
// opaque tour ids, always read and written whole, never joined or aggregated over. `decision` is
// NULL when the launch prompt was never answered, which is a real state distinct from 'declined'.
// The row's ABSENCE is what "Reset progress" restores, so the reset deletes rather than rewriting
// defaults.
export const tutorialProgress = pgTable('tutorial_progress', {
  user_id: text('user_id').primaryKey(),
  decision: text('decision'),
  completed_tour_ids: text('completed_tour_ids').notNull().default('[]'),
  nudged_tour_ids: text('nudged_tour_ids').notNull().default('[]'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Per-workspace, per-agent-kind generation settings (mirror of D1 migration 0071), edited from
// the pipeline builder beside the prompt overrides. The workspace tier of the deployment's
// per-kind output-token ceiling: no row (or a NULL `max_output_tokens`) means inherit the
// routing default. PLAIN, not append-only like `agent_prompt_revisions` — the value is one
// scalar a human typed, so an upsert on the primary key is the right concurrency story and a
// revision log would be ceremony. The composite primary key serves both reads (the dispatch
// path's point read, and the workspace-prefix scan the settings UI does), so there is no
// secondary index to keep in step.
export const workspaceAgentSettings = pgTable(
  'workspace_agent_settings',
  {
    workspace_id: text('workspace_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    max_output_tokens: integer('max_output_tokens'),
    updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.agent_kind] })],
)

// Per-workspace runtime settings (mirror of D1 migration 0004's `workspace_settings`):
// the human-wait escalation threshold + the per-service running-task limit policy. One
// row per workspace; the service lazily seeds DEFAULT_WORKSPACE_SETTINGS on first read.
export const workspaceSettings = pgTable('workspace_settings', {
  workspace_id: text('workspace_id').notNull().primaryKey(),
  waiting_escalation_minutes: integer('waiting_escalation_minutes').notNull().default(120),
  // 'off' | 'shared' | 'per_type'
  task_limit_mode: text('task_limit_mode').notNull().default('off'),
  // The shared cap when task_limit_mode = 'shared'; null otherwise.
  task_limit_shared: integer('task_limit_shared'),
  // JSON object of per-type caps when task_limit_mode = 'per_type'; null otherwise.
  task_limit_per_type: text('task_limit_per_type'),
  // Whether to store the full provided-context snapshot for each container agent
  // (the observability feature). On by default; integer 0/1 to match the SQLite store.
  store_agent_context: integer('store_agent_context').notNull().default(1),
  publish_pr_verification_report: integer('publish_pr_verification_report').notNull().default(1),
  // Retention window (days) for binary artifacts (UI screenshots + reference designs)
  // before the cleanup sweep deletes them. Default 14; mirrors the D1 column.
  artifact_retention_days: integer('artifact_retention_days').notNull().default(14),
  // Per-workspace toggle for the Kaizen agent (post-run grading). On by default; integer
  // 0/1 to match the SQLite store.
  kaizen_enabled: integer('kaizen_enabled').notNull().default(1),
  // LOCAL MODE ONLY toggle (inert on Cloudflare/Node): delegate container agents to the
  // workspace's runner pool instead of the host container runtime. Off by default; integer
  // 0/1 to match the SQLite store.
  delegate_agents_to_runner_pool: integer('delegate_agents_to_runner_pool').notNull().default(0),
  // The PRE-DISPATCH INPUT GATE's mode ('standard'|'advisory'|'off'). `standard` by default: every
  // blocking finding names an input no model could act on either, so the gate can only ever save
  // the call that would have reported the same absence. Mirrors the D1 column.
  input_gate_mode: text('input_gate_mode').notNull().default('standard'),
  // Opt-in review-debt friction on task creation. Mode ('off'|'warn'|'enforce'), off by default;
  // the soft warn threshold (count of tasks in human review, default 3); and the two nullable
  // hard-block triggers (a count and a stuck-age in minutes). Mirrors the D1 columns.
  review_friction_mode: text('review_friction_mode').notNull().default('off'),
  review_friction_warn_count: integer('review_friction_warn_count').notNull().default(3),
  review_friction_block_count: integer('review_friction_block_count'),
  review_friction_block_stuck_minutes: integer('review_friction_block_stuck_minutes'),
  // Per-workspace spend budget (moved out of env). Both nullable; null ⇒ the built-in
  // DEFAULT_SPEND_PRICING base table.
  spend_currency: text('spend_currency'),
  spend_monthly_limit: doublePrecision('spend_monthly_limit'),
  // The default test-environment provisioning mechanism suggested for newly added service
  // frames, plus the custom manifest id a `custom` default pins. Both nullable with NO
  // default: null means the operator has never chosen (which the SPA nags about), and is
  // deliberately distinct from an explicit `infraless`. Mirrors the D1 columns.
  default_provision_type: text('default_provision_type'),
  default_provision_manifest_id: text('default_provision_manifest_id'),
  // Whether a run may authenticate as its INITIATOR's stored personal access token instead of
  // the deployment credential. On by default (the attribution behaviour); off bounds every run
  // to the App installation's scope. Integer 0/1 to match the SQLite store. Mirrors the D1
  // column; see `backend/docs/security-model.md`.
  allow_initiator_pat: integer('allow_initiator_pat').notNull().default(1),
  // The values for the custom metadata FIELDS a deployment declares in its app (read by
  // external-tool URL resolvers). One bounded JSON object per workspace, like
  // `task_limit_per_type`; null ⇒ nothing filled in. Mirrors the D1 column.
  metadata: text('metadata'),
})
