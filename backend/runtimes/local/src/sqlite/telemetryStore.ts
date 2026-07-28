import type { DatabaseSync } from 'node:sqlite'
import {
  LLM_WARNING_FINISH_REASONS,
  type AgentContextFile,
  type AgentContextFragment,
  type AgentContextSnapshot,
  type AgentContextSnapshotRepository,
  type AgentSearchQuery,
  type AgentSearchQueryRepository,
  type LlmCallMetric,
  type LlmCallMetricRepository,
  type LlmCallMetricSummary,
  type LlmPromptChainTip,
  type ProvisioningLogQuery,
  type ProvisioningLogRecord,
  type ProvisioningLogRepository,
  type SubscriptionQuotaCycleRecord,
  type SubscriptionQuotaCycleRepository,
  type SubscriptionQuotaScope,
  type SubscriptionQuotaWindowKind,
} from '@cat-factory/kernel'
import {
  type SubscriptionVendor,
  isWebSearchProvider,
  subscriptionVendorSchema,
} from '@cat-factory/contracts'
import { decodeEnum } from '@cat-factory/server'
import { openSqliteDb } from './db.js'

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
`

interface MetricRow {
  id: string
  workspace_id: string
  execution_id: string | null
  agent_kind: string
  provider: string
  model: string
  created_at: number
  streaming: number
  message_count: number
  tool_count: number
  request_max_tokens: number | null
  prompt_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  completion_tokens: number
  total_tokens: number
  finish_reason: string | null
  upstream_ms: number
  overhead_ms: number
  total_ms: number
  ok: number
  http_status: number | null
  error_message: string | null
  prompt_text: string
  prompt_prefix_count: number
  prompt_hash: string
  response_text: string
  reasoning_text: string
  phase: string
  turn_index: number | null
}

function rowToMetric(row: MetricRow): LlmCallMetric {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    streaming: row.streaming === 1,
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
    promptText: row.prompt_text,
    promptPrefixCount: row.prompt_prefix_count,
    promptHash: row.prompt_hash,
    responseText: row.response_text,
    reasoningText: row.reasoning_text,
    phase: row.phase,
    turnIndex: row.turn_index,
  }
}

/** The per-call LLM telemetry sink — the local-sqlite mirror of `D1LlmCallMetricRepository`. */
class SqliteLlmCallMetricRepository implements LlmCallMetricRepository {
  constructor(private readonly db: DatabaseSync) {}

  async record(metric: LlmCallMetric): Promise<void> {
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
           COALESCE(SUM(CASE WHEN ok = 1 AND finish_reason IN (${WARNING_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS warnings
         FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ?
         GROUP BY agent_kind`,
      )
      .all(workspaceId, executionId) as unknown as {
      agent_kind: string
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
    }[]
    return rows.map((r) => ({
      agentKind: r.agent_kind,
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
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const res = this.db.prepare('DELETE FROM llm_call_metrics WHERE created_at < ?').run(epochMs)
    return Number(res.changes)
  }
}

function parseArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

interface SnapshotRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  step_index: number
  created_at: number
  model: string | null
  harness: string | null
  system_prompt: string
  user_prompt: string
  fragments: string
  context_files: string
  extras: string
}

/** The per-dispatch agent-context sink — the local-sqlite mirror of `D1AgentContextSnapshotRepository`. */
class SqliteAgentContextSnapshotRepository implements AgentContextSnapshotRepository {
  constructor(private readonly db: DatabaseSync) {}

  async record(snapshot: AgentContextSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_context_snapshots
           (id, workspace_id, execution_id, agent_kind, step_index, created_at,
            model, harness, system_prompt, user_prompt, fragments, context_files, extras)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      executionId: row.execution_id,
      agentKind: row.agent_kind,
      stepIndex: row.step_index,
      createdAt: row.created_at,
      model: row.model,
      harness: row.harness,
      systemPrompt: row.system_prompt,
      userPrompt: row.user_prompt,
      fragments: parseArray<AgentContextFragment>(row.fragments),
      contextFiles: parseArray<AgentContextFile>(row.context_files),
      extras: parseObject(row.extras),
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const res = this.db
      .prepare('DELETE FROM agent_context_snapshots WHERE created_at < ?')
      .run(epochMs)
    return Number(res.changes)
  }
}

interface SearchQueryRow {
  id: string
  workspace_id: string
  execution_id: string
  agent_kind: string
  provider: string | null
  query: string
  result_count: number
  created_at: number
}

/** The performed-web-search sink — the local-sqlite mirror of `D1AgentSearchQueryRepository`. */
class SqliteAgentSearchQueryRepository implements AgentSearchQueryRepository {
  constructor(private readonly db: DatabaseSync) {}

  async record(query: AgentSearchQuery): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_search_queries
           (id, workspace_id, execution_id, agent_kind, provider, query, result_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      executionId: row.execution_id,
      agentKind: row.agent_kind,
      // The stored provider column is free-text TEXT; narrow it back to the wire union.
      provider: isWebSearchProvider(row.provider) ? row.provider : null,
      query: row.query,
      resultCount: row.result_count,
      createdAt: row.created_at,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const res = this.db
      .prepare('DELETE FROM agent_search_queries WHERE created_at < ?')
      .run(epochMs)
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
    if (query.before != null) {
      clauses.push('created_at < ?')
      binds.push(query.before)
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
  provisioningLogRepository: ProvisioningLogRepository
  subscriptionQuotaCycleRepository: SubscriptionQuotaCycleRepository
}

/** The local telemetry repositories plus a handle to close the underlying db. */
export interface LocalTelemetryStore extends LocalTelemetryRepositories {
  close(): void
}

/**
 * Open the local telemetry store at `path` (a file under the developer's config dir, or
 * `:memory:` in tests). Holds ONLY high-volume run telemetry — never a credential, never org
 * state — and is pruned to the deployment's retention window by the local retention sweep.
 */
export function createLocalTelemetryStore(path: string): LocalTelemetryStore {
  const db = openSqliteDb(path, SCHEMA)
  return {
    llmCallMetricRepository: new SqliteLlmCallMetricRepository(db),
    agentContextSnapshotRepository: new SqliteAgentContextSnapshotRepository(db),
    agentSearchQueryRepository: new SqliteAgentSearchQueryRepository(db),
    provisioningLogRepository: new SqliteProvisioningLogRepository(db),
    subscriptionQuotaCycleRepository: new SqliteSubscriptionQuotaCycleRepository(db),
    close: () => db.close(),
  }
}
