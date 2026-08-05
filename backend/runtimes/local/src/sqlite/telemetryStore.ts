import type { DatabaseSync } from 'node:sqlite'
import {
  LLM_WARNING_FINISH_REASONS,
  escapeLikePattern,
  type AgentContextIndexQuery,
  type AgentContextRunPageQuery,
  type AgentContextSnapshot,
  type AgentContextSnapshotIndex,
  type AgentContextSnapshotRepository,
  type AgentSearchQuery,
  type AgentSearchQueryPageQuery,
  type AgentSearchQueryRepository,
  type AgentToolCall,
  type AgentToolCallCounts,
  type AgentToolCallPageQuery,
  type AgentToolCallRepository,
  type AgentToolCallTrajectoryQuery,
  type LlmCallBodyWindow,
  type LlmCallMetric,
  type LlmCallMetricPage,
  type LlmCallMetricRepository,
  type LlmCallMetricSummary,
  type LlmCallOutcomeFilter,
  type LlmCallPageQuery,
  type LlmCallRunPageQuery,
  type LlmPromptChainTip,
  type ProvisioningLogQuery,
  type ProvisioningLogRecord,
  type ProvisioningLogRepository,
  type SubscriptionQuotaCycleRecord,
  type SubscriptionQuotaCycleRepository,
  type SubscriptionQuotaScope,
  type SubscriptionQuotaWindowKind,
  type ToolCallOutcome,
} from '@cat-factory/kernel'
import { type SubscriptionVendor, subscriptionVendorSchema } from '@cat-factory/contracts'
import { decodeEnum } from '@cat-factory/server'
import { openSqliteDb } from './db.js'
import {
  type LocalTelemetryIngestReader,
  SqliteTelemetryIngestReader,
} from './telemetryIngestReader.js'
import {
  TELEMETRY_COVERAGE_SCHEMA,
  type LocalTelemetryCoverage,
  SqliteTelemetryCoverage,
} from './telemetryCoverage.js'
import {
  type MetricRow,
  type SearchQueryRow,
  type ToolCallRow,
  type SnapshotRow,
  rowToMetric,
  rowToQuery,
  rowToToolCall,
  rowToSnapshot,
} from './telemetryRows.js'

// The mothership-mode LOCAL telemetry store (docs/initiatives/mothership-mode.md, PR 5).
//
// Telemetry is the third bucket, distinct from both the remote org/durable state and the local
// CREDENTIALS: it is append-heavy, high-volume and short-retention (product decision 5 —
// "telemetry/logs are local-first"). Routing it through the per-call persistence RPC would put a
// network round trip on the hot path of every LLM call, every dispatch and every provisioning
// attempt — so a mothership-mode node writes it HERE, to a file-based `node:sqlite` database on
// the laptop, and reads it back from the same place.
//
// Before this store existed those repositories resolved to the remote registry, where none of
// their methods is allow-listed: every write came back `unknown_method` (swallowed by the
// best-effort recorders) and every read came back empty. So a mothership-mode developer's
// observability panel, per-step token rollups, web-search log and provisioning "View logs"
// surfaces were all blank, and the board's per-run token counters read zero — the run telemetry
// most worth inspecting silently did not exist.
//
// What is NOT here: `tokenUsageRepository`. The spend ledger looks like telemetry but is the
// org's BUDGET SAFEGUARD — the gate reads its rollups remotely (`totalsSinceFor*`, long
// allow-listed), so a laptop-local ledger would leave every local run invisible to the
// workspace/account/user budget it is supposed to answer to. It stays remote, with `record` now
// allow-listed under a scope rule that pins the row's denormalized account/user to the caller
// (see `REMOTE_PERSISTENCE_METHODS`).
//
// The schema mirrors the D1 telemetry/provisioning databases column-for-column (D1 IS SQLite, so
// `D1LlmCallMetricRepository` et al. are the closest reference) and each repository mirrors its
// `D1*` counterpart's SQL, so a mothership-mode node chains prompt deltas, aggregates per-kind
// rollups and prunes exactly like a Postgres or D1 one. `DatabaseSync` is synchronous, so the
// ports' async methods execute synchronously here.

/** `length` / `content_filter` as a SQL list literal — shared constant, so the two agree. */
const WARNING_REASONS_SQL = LLM_WARNING_FINISH_REASONS.map((r) => `'${r}'`).join(', ')

/**
 * The run's calls with each one's total input and the turns left in ITS conversation after it —
 * the two factors of the carry-cost proxy. Mirrors the D1 store's subquery exactly (same
 * `PARTITION BY agent_kind` conversation boundary, same `(created_at, message_count, id)`
 * ordering, chosen because a proxied row's `turn_index` is NULL by design).
 */
const CARRY_COST_SUBQUERY_SQL = `SELECT
       agent_kind,
       phase,
       provider,
       model,
       prompt_tokens,
       cache_read_tokens,
       cache_write_tokens,
       completion_tokens,
       request_max_tokens,
       finish_reason,
       upstream_ms,
       overhead_ms,
       ok,
       (prompt_tokens + cache_read_tokens + cache_write_tokens) AS input_tokens,
       COUNT(*) OVER (PARTITION BY agent_kind)
         - ROW_NUMBER() OVER (PARTITION BY agent_kind ORDER BY created_at, message_count, id)
         AS turns_after
     FROM llm_call_metrics
     WHERE workspace_id = ? AND execution_id = ?`

// --- the bounded-page helpers, mirroring `D1LlmCallMetricRepository` -------------------------
// D1 IS SQLite, so these are the same SQL shapes; see that file for why each case exists. The
// notes kept here are the ones a reader of THIS file needs to not break it.

/** The metadata columns a bounded page selects, plus each body's full `length()`. */
const PAGE_METADATA_COLUMNS = `id, workspace_id, execution_id, agent_kind, provider, model,
  created_at, streaming, phase, turn_index, message_count, tool_count, request_max_tokens,
  prompt_tokens,
  cache_read_tokens, cache_write_tokens, completion_tokens, total_tokens, finish_reason, upstream_ms,
  overhead_ms, total_ms, ok, http_status, error_message, prompt_prefix_count,
  length(prompt_text)    AS prompt_chars,
  length(response_text)  AS response_chars,
  length(reasoning_text) AS reasoning_chars`

/**
 * The three body columns windowed to `bodyChars` from `offsetChars`. The cases are NOT
 * interchangeable: a huge sentinel length makes SQLite return an EMPTY string (so "everything"
 * selects the columns raw), and a 0 budget selects a literal `''` so a sweep reads no body bytes
 * at all. `substr` is 1-based and counts code points, matching the wire contract's offsets.
 */
function bodyColumns(bodyChars: number | undefined, offsetChars = 0): string {
  if (bodyChars !== undefined && bodyChars <= 0) {
    return `'' AS prompt_text, '' AS response_text, '' AS reasoning_text`
  }
  if (bodyChars === undefined && offsetChars <= 0) {
    return `prompt_text, response_text, reasoning_text`
  }
  if (bodyChars === undefined) {
    return `substr(prompt_text, ?)    AS prompt_text,
            substr(response_text, ?)  AS response_text,
            substr(reasoning_text, ?) AS reasoning_text`
  }
  return `substr(prompt_text, ?, ?)    AS prompt_text,
          substr(response_text, ?, ?)  AS response_text,
          substr(reasoning_text, ?, ?) AS reasoning_text`
}

/** The window binds `bodyColumns` needs, in the order its placeholders appear. */
function bodyBinds(bodyChars: number | undefined, offsetChars = 0): number[] {
  if (bodyChars !== undefined && bodyChars <= 0) return []
  if (bodyChars === undefined && offsetChars <= 0) return []
  const from = Math.max(0, offsetChars) + 1
  if (bodyChars === undefined) return [from, from, from]
  return [from, bodyChars, from, bodyChars, from, bodyChars]
}

/**
 * The per-body first-match columns a SEARCHED page adds: the 0-based code-point offset of the
 * term in each body, or NULL where it does not occur. `instr` counts characters like `substr`,
 * so the offset feeds a point read's window directly.
 */
const MATCH_COLUMNS = `,
  nullif(instr(lower(prompt_text), ?), 0) - 1    AS prompt_match,
  nullif(instr(lower(response_text), ?), 0) - 1  AS response_match,
  nullif(instr(lower(reasoning_text), ?), 0) - 1 AS reasoning_match`

/** The lowered-term binds {@link MATCH_COLUMNS} needs (SQLite's `LIKE` folds ASCII only). */
function matchBinds(contains: string): string[] {
  const lowered = contains.toLowerCase()
  return [lowered, lowered, lowered]
}

/** The SQL predicate for one outcome class, or null for "no narrowing". Mirrors `classifyCall`. */
function outcomeClause(outcome: LlmCallOutcomeFilter | undefined): string | null {
  if (outcome === 'error') return 'ok = 0'
  if (outcome === 'warning') return `ok = 1 AND finish_reason IN (${WARNING_REASONS_SQL})`
  if (outcome === 'ok') {
    return `ok = 1 AND (finish_reason IS NULL OR finish_reason NOT IN (${WARNING_REASONS_SQL}))`
  }
  return null
}

interface PageRow extends Omit<MetricRow, 'prompt_hash'> {
  prompt_chars: number
  response_chars: number
  reasoning_chars: number
  prompt_match?: number | null
  response_match?: number | null
  reasoning_match?: number | null
}

/** Attach a searched row's per-body match offset; a plain page's slices carry none. */
function withMatch(
  slice: { text: string; totalChars: number },
  match: number | null | undefined,
): LlmCallMetricPage['prompt'] {
  return match === undefined ? slice : { ...slice, matchOffset: match }
}

function rowToPage(row: PageRow): LlmCallMetricPage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    streaming: row.streaming === 1,
    phase: row.phase,
    turnIndex: row.turn_index,
    messageCount: row.message_count,
    toolCount: row.tool_count,
    requestMaxTokens: row.request_max_tokens,
    promptTokens: row.prompt_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    finishReason: row.finish_reason,
    upstreamMs: row.upstream_ms,
    overheadMs: row.overhead_ms,
    totalMs: row.total_ms,
    ok: row.ok === 1,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    promptPrefixCount: row.prompt_prefix_count,
    prompt: withMatch(
      { text: row.prompt_text, totalChars: row.prompt_chars ?? 0 },
      row.prompt_match,
    ),
    response: withMatch(
      { text: row.response_text, totalChars: row.response_chars ?? 0 },
      row.response_match,
    ),
    reasoning: withMatch(
      { text: row.reasoning_text, totalChars: row.reasoning_chars ?? 0 },
      row.reasoning_match,
    ),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_call_metrics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_id TEXT,
  agent_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  streaming INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  request_max_tokens INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  upstream_ms INTEGER NOT NULL DEFAULT 0,
  overhead_ms INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  error_message TEXT,
  prompt_text TEXT NOT NULL DEFAULT '',
  prompt_prefix_count INTEGER NOT NULL DEFAULT 0,
  prompt_hash TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  reasoning_text TEXT NOT NULL DEFAULT '',
  -- The phase/turn axes, mirroring D1 telemetry migration 0004 including its nullability: phase
  -- defaults to '' so an older harness image's rows are a REAL rollup group rather than dropped,
  -- and turn_index stays NULLABLE because the proxy path has no job-scoped counter -- a 0 there
  -- would read as "the first turn" and sort every proxied call to the front of its phase.
  phase TEXT NOT NULL DEFAULT '',
  turn_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_call_metrics_execution
  ON llm_call_metrics (workspace_id, execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_call_metrics_created ON llm_call_metrics (created_at);

CREATE TABLE IF NOT EXISTS agent_context_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  model TEXT,
  harness TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  user_prompt TEXT NOT NULL DEFAULT '',
  fragments TEXT NOT NULL DEFAULT '[]',
  context_files TEXT NOT NULL DEFAULT '[]',
  extras TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_context_snapshots_execution
  ON agent_context_snapshots (workspace_id, execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_context_snapshots_created
  ON agent_context_snapshots (created_at);

CREATE TABLE IF NOT EXISTS agent_search_queries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  provider TEXT,
  query TEXT NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_search_queries_execution
  ON agent_search_queries (workspace_id, execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_search_queries_created
  ON agent_search_queries (created_at);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  bodies TEXT NOT NULL DEFAULT 'withheld',
  args TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  args_dropped INTEGER NOT NULL DEFAULT 0,
  result_dropped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_trajectory
  ON agent_tool_calls (workspace_id, execution_id, started_at, seq);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_execution
  ON agent_tool_calls (workspace_id, execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_job
  ON agent_tool_calls (workspace_id, execution_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_created
  ON agent_tool_calls (created_at);

CREATE TABLE IF NOT EXISTS provisioning_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subsystem TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  provider_id TEXT,
  block_id TEXT,
  execution_id TEXT,
  outcome TEXT NOT NULL,
  error TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provisioning_log_workspace
  ON provisioning_log (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_provisioning_log_execution
  ON provisioning_log (workspace_id, execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_provisioning_log_created ON provisioning_log (created_at);

CREATE TABLE IF NOT EXISTS subscription_quota_cycles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, scope_id, vendor, window_kind)
);
CREATE INDEX IF NOT EXISTS idx_subscription_quota_cycles_window
  ON subscription_quota_cycles (window_started_at);

-- Per-run high-water mark for the UPSTREAM telemetry ingest (docs/initiatives/mothership-mode.md,
-- PR 5): which runs have already been uploaded to the mothership, and up to which capture time.
-- Local-only bookkeeping -- it never leaves the laptop and has no mothership counterpart.
CREATE TABLE IF NOT EXISTS telemetry_ingest_state (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  -- The newest captured row (across the run-scoped sinks) this run was ingested through.
  -- A later row moves the run's newest-write time past this and makes it a candidate again, which
  -- is what covers a RESUMED run: the upload is idempotent by row id, so re-offering the
  -- already-ingested prefix costs bandwidth and nothing else.
  ingested_through INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, execution_id)
);
${TELEMETRY_COVERAGE_SCHEMA}
`

/** The per-call LLM telemetry sink — the local-sqlite mirror of `D1LlmCallMetricRepository`. */
class SqliteLlmCallMetricRepository implements LlmCallMetricRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly coverage: LocalTelemetryCoverage,
  ) {}

  async record(metric: LlmCallMetric): Promise<void> {
    this.insert(metric)
  }

  private insert(metric: LlmCallMetric): void {
    // First write wins, and ONLY a duplicate id is ignored — `ON CONFLICT(id) DO NOTHING`, never
    // `INSERT OR IGNORE` (which would also swallow a NOT NULL/CHECK violation and silently drop a
    // malformed metric here while the other runtimes throw). The harness-call recorder deliberately
    // re-offers a deterministic id (live drain, terminal list, durable-driver replay), so ignoring
    // the repeat is what makes those paths idempotent; overwriting would invalidate the row's
    // stored prompt DELTA, which is only meaningful against the tip that preceded its FIRST write.
    this.db
      .prepare(
        `INSERT INTO llm_call_metrics
           (id, workspace_id, execution_id, agent_kind, provider, model, created_at,
            streaming, message_count, tool_count, request_max_tokens,
            prompt_tokens, cache_read_tokens, cache_write_tokens, completion_tokens,
            total_tokens, finish_reason,
            upstream_ms, overhead_ms, total_ms, ok, http_status, error_message,
            prompt_text, prompt_prefix_count, prompt_hash, response_text, reasoning_text,
            phase, turn_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        metric.id,
        metric.workspaceId,
        metric.executionId,
        metric.agentKind,
        metric.provider,
        metric.model,
        metric.createdAt,
        metric.streaming ? 1 : 0,
        metric.messageCount,
        metric.toolCount,
        metric.requestMaxTokens,
        metric.promptTokens,
        metric.cacheReadTokens,
        metric.cacheWriteTokens,
        metric.completionTokens,
        metric.totalTokens,
        metric.finishReason,
        metric.upstreamMs,
        metric.overheadMs,
        metric.totalMs,
        metric.ok ? 1 : 0,
        metric.httpStatus,
        metric.errorMessage,
        metric.promptText,
        metric.promptPrefixCount,
        metric.promptHash,
        metric.responseText,
        metric.reasoningText,
        metric.phase,
        metric.turnIndex,
      )
  }

  async recordMany(metrics: LlmCallMetric[]): Promise<void> {
    // `DatabaseSync` is synchronous and single-process, so the loop below is one uninterrupted
    // append rather than N round trips — this is the local mirror of the other runtimes' batch
    // insert, not the N+1 the rule forbids. Wrapped in a transaction so a partially applied
    // batch can't leave the run's rows interleaved with a concurrent writer's.
    //
    // The loop calls the SYNCHRONOUS `insert`, never `await this.record(...)`: an await inside the
    // transaction yields the microtask queue, which is exactly what "uninterrupted" rules out — a
    // concurrent recorder's insert would land inside this BEGIN and be rolled back with it, and a
    // re-entrant `recordMany` would fail on a nested BEGIN. Same shape as the snapshot and
    // search-query repos below.
    if (metrics.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const metric of metrics) this.insert(metric)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null> {
    // `message_count > 0` skips rows that can never BE a tip: a subagent call carries no
    // re-sendable prompt chain, and those interleave with the parent's now that harness telemetry
    // streams live — treating one as the tip makes every following parent call unchainable.
    // message_count breaks a same-millisecond createdAt tie; id is the last resort.
    const row = this.db
      .prepare(
        `SELECT message_count, prompt_hash FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ? AND agent_kind = ? AND message_count > 0
         ORDER BY created_at DESC, message_count DESC, id DESC
         LIMIT 1`,
      )
      .get(workspaceId, executionId, agentKind) as unknown as
      | { message_count: number; prompt_hash: string }
      | undefined
    return row ? { messageCount: row.message_count, promptHash: row.prompt_hash } : null
  }

  async listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
    agentKind?: string,
  ): Promise<LlmCallMetric[]> {
    // Newest first; `LIMIT -1` means "no limit" in SQLite, so an omitted cap reads all.
    const rows = this.db
      .prepare(
        `SELECT * FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ?
           AND (? IS NULL OR agent_kind = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        workspaceId,
        executionId,
        agentKind ?? null,
        agentKind ?? null,
        limit ?? -1,
      ) as unknown as MetricRow[]
    return rows.map(rowToMetric)
  }

  async listRunPage(workspaceId: string, query: LlmCallRunPageQuery): Promise<LlmCallMetric[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.agentKind != null) {
      clauses.push('agent_kind = ?')
      binds.push(query.agentKind)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY, for the same reason `listPage`'s is composite.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    // `SELECT *` — the bodies WHOLE, unlike `listPage`, which returns slices plus their lengths.
    const rows = this.db
      .prepare(
        `SELECT * FROM llm_call_metrics
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as MetricRow[]
    return rows.map(rowToMetric)
  }

  async listPage(workspaceId: string, query: LlmCallPageQuery): Promise<LlmCallMetricPage[]> {
    const ascending = query.order === 'oldest'
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    // The SELECT-list binds come FIRST (slices, then match offsets), ahead of every WHERE
    // placeholder.
    const binds: (string | number | null)[] = [
      ...bodyBinds(query.bodyChars),
      ...(query.contains != null ? matchBinds(query.contains) : []),
      workspaceId,
      query.executionId,
    ]
    if (query.agentKind != null) {
      clauses.push('agent_kind = ?')
      binds.push(query.agentKind)
    }
    // `!= null`, not a truthiness check: '' is the unattributed slice and a legitimate filter.
    if (query.phase != null) {
      clauses.push('phase = ?')
      binds.push(query.phase)
    }
    const outcome = outcomeClause(query.outcome)
    if (outcome) clauses.push(`(${outcome})`)
    if (query.contains != null) {
      // The shared escaper makes `%`/`_` in the term literal; SQLite has no default escape
      // character, so `ESCAPE '\'` is mandatory here (unlike Postgres).
      const pattern = `%${escapeLikePattern(query.contains)}%`
      clauses.push(
        `(prompt_text LIKE ? ESCAPE '\\' OR response_text LIKE ? ESCAPE '\\' OR reasoning_text LIKE ? ESCAPE '\\')`,
      )
      binds.push(pattern, pattern, pattern)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY: calls are recorded off the response path, so a
      // burst genuinely shares a millisecond and a `created_at`-only bound would drop the ties.
      const cmp = ascending ? '>' : '<'
      clauses.push(`(created_at ${cmp} ? OR (created_at = ? AND id ${cmp} ?))`)
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const direction = ascending ? 'ASC' : 'DESC'
    const rows = this.db
      .prepare(
        `SELECT ${PAGE_METADATA_COLUMNS}, ${bodyColumns(query.bodyChars)}${
          query.contains != null ? MATCH_COLUMNS : ''
        }
         FROM llm_call_metrics
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ${direction}, id ${direction}
         LIMIT ?`,
      )
      .all(...binds) as unknown as PageRow[]
    return rows.map(rowToPage)
  }

  async get(
    workspaceId: string,
    id: string,
    body?: LlmCallBodyWindow,
  ): Promise<LlmCallMetricPage | null> {
    const row = this.db
      .prepare(
        `SELECT ${PAGE_METADATA_COLUMNS}, ${bodyColumns(body?.chars, body?.offset ?? 0)}
         FROM llm_call_metrics
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(...bodyBinds(body?.chars, body?.offset ?? 0), workspaceId, id) as unknown as
      | PageRow
      | undefined
    return row ? rowToPage(row) : null
  }

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    // Aggregate-only: selects no prompt/response text, so it stays cheap enough to run on every
    // execution emit (it backs the live board rollups).
    const rows = this.db
      .prepare(
        `SELECT
           agent_kind                                           AS agent_kind,
           phase                                                AS phase,
           provider                                             AS provider,
           model                                                AS model,
           COUNT(*)                                             AS calls,
           COALESCE(SUM(prompt_tokens), 0)                      AS prompt_tokens,
           COALESCE(SUM(cache_read_tokens), 0)                  AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0)                 AS cache_write_tokens,
           COALESCE(SUM(completion_tokens), 0)                  AS completion_tokens,
           COALESCE(MAX(completion_tokens), 0)                  AS peak_completion_tokens,
           MAX(request_max_tokens)                              AS max_output_tokens,
           COALESCE(SUM(CASE WHEN finish_reason = 'length' THEN 1 ELSE 0 END), 0) AS truncated_calls,
           COALESCE(SUM(upstream_ms), 0)                        AS upstream_ms,
           COALESCE(SUM(overhead_ms), 0)                        AS overhead_ms,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
           COALESCE(SUM(CASE WHEN ok = 1 AND finish_reason IN (${WARNING_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS warnings,
           COALESCE(SUM(input_tokens * turns_after), 0)         AS carry_cost_tokens
         FROM (${CARRY_COST_SUBQUERY_SQL})
         GROUP BY agent_kind, phase, provider, model`,
      )
      .all(workspaceId, executionId) as unknown as {
      agent_kind: string
      phase: string
      provider: string
      model: string
      calls: number
      prompt_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
      completion_tokens: number
      peak_completion_tokens: number
      max_output_tokens: number | null
      truncated_calls: number
      upstream_ms: number
      overhead_ms: number
      errors: number
      warnings: number
      carry_cost_tokens: number
    }[]
    return rows.map((r) => ({
      agentKind: r.agent_kind,
      phase: r.phase,
      provider: r.provider,
      model: r.model,
      calls: r.calls,
      promptTokens: r.prompt_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      completionTokens: r.completion_tokens,
      peakCompletionTokens: r.peak_completion_tokens,
      maxOutputTokens: r.max_output_tokens,
      truncatedCalls: r.truncated_calls,
      upstreamMs: r.upstream_ms,
      overheadMs: r.overhead_ms,
      errors: r.errors,
      warnings: r.warnings,
      carryCostTokens: Number(r.carry_cost_tokens),
      // Unpriced at the store: a price table is configuration, not SQL. `priceRollupCells`
      // fills this in at the seam that holds one, and null until then says exactly that.
      costEstimate: null,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Record which runs this delete makes the local store non-authoritative for BEFORE taking
    // the rows — afterwards there is nothing left to tell. See `telemetryCoverage.ts`: a run that
    // straddles the cutoff keeps its newer rows, and a subset answered as though it were the whole
    // run is how a pruned run's token rollup silently reads low.
    this.coverage.markPrunedBefore('llm_call_metrics', epochMs)
    const res = this.db.prepare('DELETE FROM llm_call_metrics WHERE created_at < ?').run(epochMs)
    return Number(res.changes)
  }
}

/** Identity + the four body SIZES a bounded index page selects (never a body). */
interface IndexRow {
  id: string
  agent_kind: string
  step_index: number
  created_at: number
  model: string | null
  harness: string | null
  system_prompt_chars: number
  user_prompt_chars: number
  fragments_chars: number
  context_files_chars: number
}

function rowToIndex(row: IndexRow): AgentContextSnapshotIndex {
  return {
    id: row.id,
    agentKind: row.agent_kind,
    stepIndex: row.step_index,
    createdAt: row.created_at,
    model: row.model,
    harness: row.harness,
    systemPromptChars: row.system_prompt_chars ?? 0,
    userPromptChars: row.user_prompt_chars ?? 0,
    fragmentsChars: row.fragments_chars ?? 0,
    contextFilesChars: row.context_files_chars ?? 0,
  }
}

/** The per-dispatch agent-context sink — the local-sqlite mirror of `D1AgentContextSnapshotRepository`. */
class SqliteAgentContextSnapshotRepository implements AgentContextSnapshotRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly coverage: LocalTelemetryCoverage,
  ) {}

  async record(snapshot: AgentContextSnapshot): Promise<void> {
    this.insert(snapshot, false)
  }

  async recordMany(snapshots: AgentContextSnapshot[]): Promise<void> {
    // Synchronous single-process appends inside one transaction — the local mirror of the other
    // runtimes' batch insert. Duplicate ids are IGNORED here (unlike the single-row `record`),
    // per the port: a batch append has to be retryable.
    if (snapshots.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const snapshot of snapshots) this.insert(snapshot, true)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insert(snapshot: AgentContextSnapshot, ignoreDuplicateId: boolean): void {
    this.db
      .prepare(
        `INSERT INTO agent_context_snapshots
           (id, workspace_id, execution_id, agent_kind, step_index, created_at,
            model, harness, system_prompt, user_prompt, fragments, context_files, extras)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${
           ignoreDuplicateId ? ' ON CONFLICT(id) DO NOTHING' : ''
         }`,
      )
      .run(
        snapshot.id,
        snapshot.workspaceId,
        snapshot.executionId,
        snapshot.agentKind,
        snapshot.stepIndex,
        snapshot.createdAt,
        snapshot.model,
        snapshot.harness,
        snapshot.systemPrompt,
        snapshot.userPrompt,
        JSON.stringify(snapshot.fragments),
        JSON.stringify(snapshot.contextFiles),
        JSON.stringify(snapshot.extras),
      )
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_context_snapshots
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(workspaceId, executionId) as unknown as SnapshotRow[]
    return rows.map(rowToSnapshot)
  }

  async listIndex(
    workspaceId: string,
    query: AgentContextIndexQuery,
  ): Promise<AgentContextSnapshotIndex[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.stepIndex != null) {
      clauses.push('step_index = ?')
      binds.push(query.stepIndex)
    }
    if (query.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    // Sizes only — the four body-bearing columns are MEASURED, never selected, so listing a
    // run's dispatches costs no body bytes even though a single snapshot can be megabytes.
    const rows = this.db
      .prepare(
        `SELECT id, agent_kind, step_index, created_at, model, harness,
                length(system_prompt) AS system_prompt_chars,
                length(user_prompt)   AS user_prompt_chars,
                length(fragments)     AS fragments_chars,
                length(context_files) AS context_files_chars
         FROM agent_context_snapshots
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as IndexRow[]
    return rows.map(rowToIndex)
  }

  async listRunPage(
    workspaceId: string,
    query: AgentContextRunPageQuery,
  ): Promise<AgentContextSnapshot[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.stepIndex != null) {
      clauses.push('step_index = ?')
      binds.push(query.stepIndex)
    }
    if (query.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    // Same predicate, ordering and keyset as `listIndex` — bodies included. Keeping the two in
    // step is what lets a caller page the index and then page the rows and see the same run.
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_context_snapshots
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as SnapshotRow[]
    return rows.map(rowToSnapshot)
  }

  async get(workspaceId: string, id: string): Promise<AgentContextSnapshot | null> {
    const row = this.db
      .prepare('SELECT * FROM agent_context_snapshots WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id) as unknown as SnapshotRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_context_snapshots WHERE workspace_id = ? AND execution_id = ?',
      )
      .get(workspaceId, executionId) as unknown as { n: number } | undefined
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Record which runs this delete makes the local store non-authoritative for BEFORE taking
    // the rows — afterwards there is nothing left to tell. See `telemetryCoverage.ts`: a run that
    // straddles the cutoff keeps its newer rows, and a subset answered as though it were the whole
    // run is how a pruned run's token rollup silently reads low.
    this.coverage.markPrunedBefore('agent_context_snapshots', epochMs)
    const res = this.db
      .prepare('DELETE FROM agent_context_snapshots WHERE created_at < ?')
      .run(epochMs)
    return Number(res.changes)
  }
}

/** The performed-web-search sink — the local-sqlite mirror of `D1AgentSearchQueryRepository`. */
class SqliteAgentSearchQueryRepository implements AgentSearchQueryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly coverage: LocalTelemetryCoverage,
  ) {}

  async record(query: AgentSearchQuery): Promise<void> {
    this.insert(query, false)
  }

  async recordMany(queries: AgentSearchQuery[]): Promise<void> {
    // See the snapshot repo's note: one transaction, duplicate ids ignored so the batch append
    // stays retryable.
    if (queries.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const query of queries) this.insert(query, true)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insert(query: AgentSearchQuery, ignoreDuplicateId: boolean): void {
    this.db
      .prepare(
        `INSERT INTO agent_search_queries
           (id, workspace_id, execution_id, agent_kind, provider, query, result_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)${ignoreDuplicateId ? ' ON CONFLICT(id) DO NOTHING' : ''}`,
      )
      .run(
        query.id,
        query.workspaceId,
        query.executionId,
        query.agentKind,
        query.provider,
        query.query,
        query.resultCount,
        query.createdAt,
      )
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_search_queries
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(workspaceId, executionId) as unknown as SearchQueryRow[]
    return rows.map(rowToQuery)
  }

  async listPage(
    workspaceId: string,
    query: AgentSearchQueryPageQuery,
  ): Promise<AgentSearchQuery[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.cursor) {
      // Composite keyset matching the ORDER BY, so rows sharing a `created_at` millisecond are
      // not skipped between pages.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_search_queries
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as SearchQueryRow[]
    return rows.map(rowToQuery)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_search_queries WHERE workspace_id = ? AND execution_id = ?',
      )
      .get(workspaceId, executionId) as unknown as { n: number } | undefined
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Record which runs this delete makes the local store non-authoritative for BEFORE taking
    // the rows — afterwards there is nothing left to tell. See `telemetryCoverage.ts`: a run that
    // straddles the cutoff keeps its newer rows, and a subset answered as though it were the whole
    // run is how a pruned run's token rollup silently reads low.
    this.coverage.markPrunedBefore('agent_search_queries', epochMs)
    const res = this.db
      .prepare('DELETE FROM agent_search_queries WHERE created_at < ?')
      .run(epochMs)
    return Number(res.changes)
  }
}

/**
 * The stored `ok` value an outcome filter selects. The column is an INTEGER flag (SQLite has no
 * boolean), so the mapping is stated once rather than spelled at each call site, where inverting
 * it returns a plausible-looking page of exactly the wrong rows.
 */
function okFlagFor(outcome: ToolCallOutcome): number {
  return outcome === 'ok' ? 1 : 0
}

/** The tool-call trajectory — the local-sqlite mirror of `D1AgentToolCallRepository`. */
class SqliteAgentToolCallRepository implements AgentToolCallRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly coverage: LocalTelemetryCoverage,
  ) {}

  async recordMany(calls: AgentToolCall[]): Promise<void> {
    // One transaction, duplicate ids ignored so the batch append stays retryable: a call's id
    // derives from `(jobId, seq)`, so a re-offered row is byte-identical to the stored one.
    if (calls.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const call of calls) this.insert(call)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insert(call: AgentToolCall): void {
    this.db
      .prepare(
        `INSERT INTO agent_tool_calls
           (id, workspace_id, execution_id, agent_kind, job_id, seq, tool, started_at, ended_at,
            ok, bodies, args, result, args_dropped, result_dropped, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        call.id,
        call.workspaceId,
        call.executionId,
        call.agentKind,
        call.jobId,
        call.seq,
        call.tool,
        call.startedAt,
        call.endedAt,
        call.ok ? 1 : 0,
        call.bodies,
        call.args,
        call.result,
        call.argsDropped,
        call.resultDropped,
        call.createdAt,
      )
  }

  async listByExecution(
    workspaceId: string,
    query: AgentToolCallTrajectoryQuery,
  ): Promise<AgentToolCall[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.jobId) {
      clauses.push('job_id = ?')
      binds.push(query.jobId)
    }
    // Narrowed IN SQL, before the limit takes the oldest end: filtered afterwards, a run whose
    // failures sit past the prefix would report none at all.
    if (query.outcome) {
      clauses.push('ok = ?')
      binds.push(okFlagFor(query.outcome))
    }
    binds.push(query.limit)
    const rows = this.db
      .prepare(
        // Trajectory order, mirroring the D1 repo: the call's own start, `seq` breaking a
        // shared millisecond, `id` making it total. A job id is a string and would sort a
        // run's dispatches alphabetically.
        `SELECT * FROM agent_tool_calls
         WHERE ${clauses.join(' AND ')}
         ORDER BY started_at ASC, seq ASC, id ASC
         LIMIT ?`,
      )
      .all(...binds) as unknown as ToolCallRow[]
    return rows.map(rowToToolCall)
  }

  async listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: (string | number)[] = [workspaceId, query.executionId]
    if (query.jobId) {
      clauses.push('job_id = ?')
      binds.push(query.jobId)
    }
    if (query.outcome) {
      clauses.push('ok = ?')
      binds.push(okFlagFor(query.outcome))
    }
    if (query.cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_tool_calls
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as ToolCallRow[]
    return rows.map(rowToToolCall)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<AgentToolCallCounts> {
    // Total and failures in ONE pass, mirroring the D1 and Drizzle repos: separate reads could
    // land either side of a drain and report more failures than calls.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
           FROM agent_tool_calls WHERE workspace_id = ? AND execution_id = ?`,
      )
      .get(workspaceId, executionId) as unknown as { n: number; failed: number | null } | undefined
    // `SUM` over no rows is NULL: read as 0, the same fact the 0 total already states.
    return { total: row?.n ?? 0, failed: row?.failed ?? 0 }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Mark coverage BEFORE taking the rows — see the sibling sinks: a pruned subset answered as
    // though it were the whole run is how a trajectory silently reads as a shorter one.
    this.coverage.markPrunedBefore('agent_tool_calls', epochMs)
    const res = this.db.prepare('DELETE FROM agent_tool_calls WHERE created_at < ?').run(epochMs)
    return Number(res.changes)
  }
}

interface ProvisioningLogRow {
  id: string
  workspace_id: string
  subsystem: string
  operation: string
  target_id: string | null
  provider_id: string | null
  block_id: string | null
  execution_id: string | null
  outcome: string
  error: string | null
  detail: string | null
  created_at: number
}

/** The provisioning event log — the local-sqlite mirror of `D1ProvisioningLogRepository`. */
class SqliteProvisioningLogRepository implements ProvisioningLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  async append(record: ProvisioningLogRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO provisioning_log
           (id, workspace_id, subsystem, operation, target_id, provider_id, block_id,
            execution_id, outcome, error, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.subsystem,
        record.operation,
        record.targetId,
        record.providerId,
        record.blockId,
        record.executionId,
        record.outcome,
        record.error,
        record.detail,
        record.createdAt,
      )
  }

  async list(
    workspaceId: string,
    query: ProvisioningLogQuery = {},
  ): Promise<ProvisioningLogRecord[]> {
    const clauses = ['workspace_id = ?']
    const binds: (string | number)[] = [workspaceId]
    if (query.subsystem) {
      clauses.push('subsystem = ?')
      binds.push(query.subsystem)
    }
    if (query.executionId) {
      clauses.push('execution_id = ?')
      binds.push(query.executionId)
    }
    if (query.targetId) {
      clauses.push('target_id = ?')
      binds.push(query.targetId)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY: provisioning attempts are appended in bursts,
      // so a `created_at`-only bound would silently drop rows sharing a millisecond.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    // Newest first; `LIMIT -1` means "no limit" in SQLite, so an omitted cap reads all.
    binds.push(query.limit ?? -1)
    const rows = this.db
      .prepare(
        `SELECT * FROM provisioning_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...binds) as unknown as ProvisioningLogRow[]
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      subsystem: row.subsystem as ProvisioningLogRecord['subsystem'],
      operation: row.operation as ProvisioningLogRecord['operation'],
      targetId: row.target_id,
      providerId: row.provider_id,
      blockId: row.block_id,
      executionId: row.execution_id,
      outcome: row.outcome as ProvisioningLogRecord['outcome'],
      error: row.error,
      detail: row.detail,
      createdAt: row.created_at,
    }))
  }

  async countByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<{ total: number; failures: number }> {
    // Total + failures in ONE aggregate pass over the run's slice (see the port).
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END), 0) AS failures
         FROM provisioning_log
         WHERE workspace_id = ? AND execution_id = ?`,
      )
      .get(workspaceId, executionId) as unknown as { total: number; failures: number } | undefined
    return { total: row?.total ?? 0, failures: row?.failures ?? 0 }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const res = this.db.prepare('DELETE FROM provisioning_log WHERE created_at < ?').run(epochMs)
    return Number(res.changes)
  }
}

interface QuotaCycleRow {
  id: string
  scope: string
  scope_id: string
  vendor: string
  window_kind: string
  window_started_at: number
  input_tokens: number
  output_tokens: number
  request_count: number
  updated_at: number
}

/**
 * The modeled subscription quota-cycle counters — the local-sqlite mirror of
 * `D1SubscriptionQuotaCycleRepository`. Local by construction as well as by policy: in mothership
 * mode BOTH scopes a cycle can key on live on the laptop (a `pooled` cycle's scopeId is a
 * `provider_subscription_tokens` row in the local credential store, and a `user` cycle counts a
 * personal subscription kept there too), so remoting the counters would split a cycle from the
 * credential it models.
 */
class SqliteSubscriptionQuotaCycleRepository implements SubscriptionQuotaCycleRepository {
  constructor(private readonly db: DatabaseSync) {}

  async recordUsage(
    key: {
      id: string
      scope: SubscriptionQuotaScope
      scopeId: string
      vendor: SubscriptionVendor
      windowKind: SubscriptionQuotaWindowKind
    },
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // Windowed UPSERT: INSERT anchors a fresh window at `at`; ON CONFLICT accumulates when the
    // existing window is still active (`at - window_started_at < windowMs`) or resets it to `at`
    // otherwise. SQLite evaluates every SET right-hand side against the row's PRE-update values,
    // so referencing `window_started_at` in the counter branches is safe even though the first SET
    // reassigns it (identical to the D1 repo).
    const active = '(? - window_started_at < ?)'
    this.db
      .prepare(
        `INSERT INTO subscription_quota_cycles
          (id, scope, scope_id, vendor, window_kind, window_started_at,
           input_tokens, output_tokens, request_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (scope, scope_id, vendor, window_kind) DO UPDATE SET
           window_started_at = CASE WHEN ${active} THEN window_started_at ELSE ? END,
           input_tokens      = CASE WHEN ${active} THEN input_tokens  ELSE 0 END + ?,
           output_tokens     = CASE WHEN ${active} THEN output_tokens ELSE 0 END + ?,
           request_count     = CASE WHEN ${active} THEN request_count ELSE 0 END + 1,
           updated_at        = ?`,
      )
      .run(
        // INSERT values
        key.id,
        key.scope,
        key.scopeId,
        key.vendor,
        key.windowKind,
        at,
        usage.inputTokens,
        usage.outputTokens,
        at,
        // UPDATE branches
        at,
        windowMs,
        at,
        at,
        windowMs,
        usage.inputTokens,
        at,
        windowMs,
        usage.outputTokens,
        at,
        windowMs,
        at,
      )
  }

  async listByScopeVendor(
    scope: SubscriptionQuotaScope,
    scopeId: string,
    vendor: SubscriptionVendor,
  ): Promise<SubscriptionQuotaCycleRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM subscription_quota_cycles
          WHERE scope = ? AND scope_id = ? AND vendor = ?`,
      )
      .all(scope, scopeId, vendor) as unknown as QuotaCycleRow[]
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope as SubscriptionQuotaScope,
      scopeId: row.scope_id,
      vendor: decodeEnum(subscriptionVendorSchema, row.vendor, {
        table: 'subscription_quota_cycles',
        column: 'vendor',
        id: row.id,
      }),
      windowKind: row.window_kind as SubscriptionQuotaWindowKind,
      windowStartedAt: row.window_started_at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      requestCount: row.request_count,
      updatedAt: row.updated_at,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const res = this.db
      .prepare('DELETE FROM subscription_quota_cycles WHERE window_started_at < ?')
      .run(epochMs)
    return Number(res.changes)
  }
}

/**
 * The telemetry repositories a mothership-mode node serves LOCALLY, keyed by the name the engine
 * (and the remote registry) addresses them by. `composeMothership` layers this map over the remote
 * repository registry, so every consumer — the recorders, the observability read endpoints, the
 * board's per-step rollups and the retention sweep — resolves the local store with no per-consumer
 * wiring.
 */
export interface LocalTelemetryRepositories {
  llmCallMetricRepository: LlmCallMetricRepository
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  agentSearchQueryRepository: AgentSearchQueryRepository
  agentToolCallRepository: AgentToolCallRepository
  provisioningLogRepository: ProvisioningLogRepository
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
}

/**
 * The local telemetry repositories plus the two laptop-side collaborators over the same tables —
 * the ingest reader (the sync UP) and the coverage record (what makes the read-through DOWN able
 * to tell a complete local answer from a pruned subset) — and a handle to close the db.
 */
export interface LocalTelemetryStore extends LocalTelemetryRepositories {
  ingestReader: LocalTelemetryIngestReader
  coverage: LocalTelemetryCoverage
  close(): void
}

/**
 * Open the local telemetry store at `path` (a file under the developer's config dir, or
 * `:memory:` in tests). Holds ONLY high-volume run telemetry — never a credential, never org
 * state — and is pruned to the deployment's retention window by the local retention sweep.
 */
export function createLocalTelemetryStore(path: string): LocalTelemetryStore {
  const db = openSqliteDb(path, SCHEMA)
  // Shared by the run-scoped sinks: each records what its own prune took, and the
  // read-through asks the one record whether a run's local answer is still the whole of it.
  const coverage = new SqliteTelemetryCoverage(db)
  return {
    llmCallMetricRepository: new SqliteLlmCallMetricRepository(db, coverage),
    agentContextSnapshotRepository: new SqliteAgentContextSnapshotRepository(db, coverage),
    agentSearchQueryRepository: new SqliteAgentSearchQueryRepository(db, coverage),
    agentToolCallRepository: new SqliteAgentToolCallRepository(db, coverage),
    provisioningLogRepository: new SqliteProvisioningLogRepository(db),
    subscriptionQuotaCycleRepository: new SqliteSubscriptionQuotaCycleRepository(db),
    ingestReader: new SqliteTelemetryIngestReader(db),
    coverage,
    close: () => db.close(),
  }
}
