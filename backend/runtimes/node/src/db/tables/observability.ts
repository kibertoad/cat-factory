import { bigint, index, integer, pgSchema, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// The observability schema: the three append-heavy TELEMETRY sinks (one row per model call,
// per dispatched agent context, per web search a container agent performed) plus the two
// deployment-level PROJECTIONS the operator dashboard aggregates (settled gates, and the daily
// run rollup behind the long windows).
//
// Split out of `schema.ts` as a cohesive module (the `tables/` pattern the identity, settings
// and VCS groups already follow) when the platform projections pushed that file over its
// size budget: budgets are split triggers, never numbers to raise. Re-exported from
// `schema.ts`, so every `from '../db/schema.js'` importer is unchanged.

// Telemetry has a very different write profile from the transactional domain
// (append-heavy, high-volume, write-and-rarely-read, short retention), so it lives in
// its own `telemetry` Postgres schema rather than `public`. This is the Node analogue
// of the Cloudflare worker's separate TELEMETRY_DB D1 database. The schema is purely a
// namespace served by the same connection/pool; `migrate()` creates it on boot. The
// `llm_call_metrics` table and `agent_context_snapshots` table live here.
export const telemetry = pgSchema('telemetry')

// LLM observability sink (mirror of D1 migration 0026). One row per proxied
// container-agent model call: full prompt/response, output-limit headroom and the
// transport-vs-execution latency split. Pruned aggressively by retention (the full
// bodies make it heavy); booleans are integer 0/1 to match the SQLite store.
export const llmCallMetrics = telemetry.table(
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
    // WHICH slice of the run spent the call (`agent` / `validation-repair` / … ), stamped by
    // the harness that owns the phase boundary; '' is the unattributed slice, a real group in
    // the rollup rather than a dropped row. `turn_index` is the harness's job-scoped `seq`,
    // NULL where the producing channel has no turn concept (the proxy). Mirrors D1 migration
    // 0004_llm_call_phase_turn. See docs/initiatives/token-burn-instrumentation.md.
    phase: text('phase').notNull().default(''),
    turn_index: integer('turn_index'),
    message_count: integer('message_count').notNull().default(0),
    tool_count: integer('tool_count').notNull().default(0),
    request_max_tokens: integer('request_max_tokens'),
    prompt_tokens: integer('prompt_tokens').notNull().default(0),
    cache_read_tokens: integer('cache_read_tokens').notNull().default(0),
    cache_write_tokens: integer('cache_write_tokens').notNull().default(0),
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
    // The model's reasoning/"thinking" trace on a separate channel, when emitted (a
    // reasoning model can spend its whole output budget here and return empty
    // response_text). Mirrors D1 migration 0002_llm_reasoning_text.
    reasoning_text: text('reasoning_text').notNull().default(''),
  },
  (t) => [
    index('idx_llm_call_metrics_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_llm_call_metrics_created').on(t.created_at),
  ],
)

// The complete, redacted context provided to one container-agent dispatch (per step
// attempt): the fully fragment-composed system + user prompts, the fragment bodies
// folded in, and the full content of the files injected into the container. Captures
// what proxy telemetry can't (the injected `.cat-context/*` files the agent reads via
// tools). JSON-shaped columns are text; pruned on the same retention window as
// llm_call_metrics. Mirrors the D1 agent_context_snapshots table column-for-column.
export const agentContextSnapshots = telemetry.table(
  'agent_context_snapshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    step_index: integer('step_index').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    model: text('model'),
    harness: text('harness'),
    system_prompt: text('system_prompt').notNull().default(''),
    user_prompt: text('user_prompt').notNull().default(''),
    // JSON arrays: [{id, body}] and [{path, title, url, content}].
    fragments: text('fragments').notNull().default('[]'),
    context_files: text('context_files').notNull().default('[]'),
    // Redacted structural bits (repo/branch, webSearch, infra, decisions, revision).
    extras: text('extras').notNull().default('{}'),
  },
  (t) => [
    index('idx_agent_context_snapshots_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_agent_context_snapshots_created').on(t.created_at),
  ],
)

// One web search a container agent performed through the backend search proxy. Recorded
// best-effort (gated by the same LLM_RECORD_PROMPTS + storeAgentContext double switch as
// agent_context_snapshots) and pruned on the same retention window. Mirrors the D1
// agent_search_queries table column-for-column.
export const agentSearchQueries = telemetry.table(
  'agent_search_queries',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id').notNull(),
    agent_kind: text('agent_kind').notNull(),
    // The upstream backend that served the search (`brave` | `searxng`), or null.
    provider: text('provider'),
    query: text('query').notNull().default(''),
    result_count: integer('result_count').notNull().default(0),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('idx_agent_search_queries_execution').on(t.workspace_id, t.execution_id, t.created_at),
    index('idx_agent_search_queries_created').on(t.created_at),
  ],
)

// ---------------------------------------------------------------------------
// Platform-operator observability projections (mirrors D1 migration 0079). Both are read by
// the account-scoped dashboard rollups; see the D1 migration for the full rationale.
// ---------------------------------------------------------------------------

/**
 * One flat row per SETTLED polling gate, so the gate / CI-fixer attempt statistics are an
 * ordinary aggregate over columns rather than a `jsonb_array_elements` expansion of the run's
 * internal `steps[].gate.*` shape. The id is derived by the writer (`<runId>:<stepIndex>:
 * <outcome>`) so a driver replay collapses onto one row.
 */
export const gateOutcomes = pgTable(
  'gate_outcomes',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    execution_id: text('execution_id').notNull(),
    block_id: text('block_id').notNull(),
    gate_kind: text('gate_kind').notNull(),
    helper_kind: text('helper_kind'),
    outcome: text('outcome').notNull(),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(0),
    helper_failures: integer('helper_failures').notNull().default(0),
    duration_ms: bigint('duration_ms', { mode: 'number' }),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    // The rollup's access path: this account's workspaces, settled since T.
    index('idx_gate_outcomes_workspace_created').on(t.workspace_id, t.created_at),
    // The retention prune's access path (a global range delete, not workspace-scoped).
    index('idx_gate_outcomes_created').on(t.created_at),
  ],
)

/**
 * The daily rollup of `agent_runs` behind the dashboard's `30d` / `90d` windows. `failure_kind`
 * carries '' (never NULL) for a non-failed status because it is part of the primary key, and a
 * NULL there would not deduplicate a re-run bucket; the repository maps it back to null at the
 * read boundary. Rewritten in place on each sweep, never appended: the current day's counts are
 * not final, so they must be corrected rather than frozen.
 */
export const platformRunDays = pgTable(
  'platform_run_days',
  {
    workspace_id: text('workspace_id').notNull(),
    day_start: bigint('day_start', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    failure_kind: text('failure_kind').notNull().default(''),
    run_count: integer('run_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.day_start, t.status, t.failure_kind] }),
    // The prune's access path; the account-scoped read rides the primary key's leading columns.
    index('idx_platform_run_days_day').on(t.day_start),
  ],
)
