import {
  LLM_WARNING_FINISH_REASONS,
  escapeLikePattern,
  type LlmCallBodyWindow,
  type LlmCallMetric,
  type LlmCallMetricPage,
  type LlmCallMetricRepository,
  type LlmCallMetricSummary,
  type LlmCallOutcomeFilter,
  type LlmCallPageQuery,
  type LlmCallRunPageQuery,
  type LlmPromptChainTip,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// `length` and `content_filter` as a SQL list literal, derived from the shared
// constant so the warning classification matches the service + the Node store.
const WARNING_REASONS_SQL = LLM_WARNING_FINISH_REASONS.map((r) => `'${r}'`).join(', ')

/**
 * The run's calls with each one's total input and the number of turns left in ITS conversation
 * after it — the two factors of the carry-cost proxy (`LlmCallRollupTotals.carryCostTokens`).
 *
 * `PARTITION BY agent_kind` is the conversation boundary, not a convenience: the prompt delta
 * chain is keyed by `(workspace, execution, agent_kind)`, so a later step's turns never re-send
 * an earlier step's context and must not be counted as carrying it.
 *
 * The order is `(created_at, message_count, id)` rather than `turn_index`: a proxied row's turn
 * index is deliberately NULL (the proxy has no job-scoped counter), so ordering by it would
 * heap every Pi call at one end of its conversation. `message_count` breaks the same-millisecond
 * ties a burst produces, and `id` makes the result deterministic.
 */
const CARRY_COST_SUBQUERY_SQL = `SELECT
       agent_kind,
       phase,
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

interface SummaryRow {
  agent_kind: string
  phase: string
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
}

function rowToSummary(r: SummaryRow): LlmCallMetricSummary {
  return {
    agentKind: r.agent_kind,
    phase: r.phase,
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
    // Coerced, matching the `node:sqlite` store line for line: these two files mirror each
    // other by contract, and the carry cost is the one column a driver may hand back as
    // something other than a plain number (it is the 64-bit sum).
    carryCostTokens: Number(r.carry_cost_tokens),
  }
}

interface MetricRow {
  id: string
  workspace_id: string
  execution_id: string | null
  agent_kind: string
  provider: string
  model: string
  created_at: number
  streaming: number
  phase: string
  turn_index: number | null
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
    promptText: row.prompt_text,
    promptPrefixCount: row.prompt_prefix_count,
    promptHash: row.prompt_hash,
    responseText: row.response_text,
    reasoningText: row.reasoning_text,
  }
}

/**
 * The metadata columns a bounded page selects, plus each body's full `length()`. The bodies
 * themselves are added by {@link bodyColumns} so the SLICE can be bound to the caller's budget.
 */
const PAGE_METADATA_COLUMNS = `id, workspace_id, execution_id, agent_kind, provider, model,
  created_at, streaming, phase, turn_index, message_count, tool_count, request_max_tokens,
  prompt_tokens,
  cache_read_tokens, cache_write_tokens, completion_tokens, total_tokens, finish_reason, upstream_ms,
  overhead_ms, total_ms, ok, http_status, error_message, prompt_prefix_count,
  length(prompt_text)    AS prompt_chars,
  length(response_text)  AS response_chars,
  length(reasoning_text) AS reasoning_chars`

/**
 * The three body columns, windowed to `bodyChars` from `offsetChars` on — the cases, each a
 * different SQL shape:
 *
 *  - `undefined` budget at offset 0 selects the columns RAW. Not
 *    `substr(col, 1, <huge sentinel>)`: SQLite returns an EMPTY string for a length that
 *    large, so a "give me everything" point read would silently hand back nothing while
 *    still reporting the real `totalChars`.
 *  - `undefined` budget at a later offset selects the REST of the body from there
 *    (two-argument `substr`).
 *  - `0` selects a literal empty string rather than `substr(col, 1, 0)`, so a sweep over a
 *    long run never makes SQLite materialise (or D1 transfer) a single prompt byte — the
 *    whole reason bodies are opt-in here.
 *  - anything else slices the caller's window. `substr` is 1-based and counts CHARACTERS
 *    (code points), matching the wire contract's offsets, so the bind is `offset + 1`.
 *
 * Lengths are always reported by {@link PAGE_METADATA_COLUMNS} regardless, because a size is
 * what tells the caller which rows are worth a point read. Mirrors the Drizzle repo's
 * `llmPageColumns`.
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
 * The per-body first-match columns a SEARCHED page adds: the 0-based code-point offset of
 * the term in each body, or NULL where it does not occur (`nullif(instr(...), 0) - 1`;
 * NULL propagates through the `- 1`). `instr` counts characters like `substr` does, so the
 * offset feeds a point read's window directly. Case folding matches the WHERE clause's
 * `LIKE`: SQLite's is ASCII-only, so the term is ASCII-lowered in {@link matchBinds}.
 */
const MATCH_COLUMNS = `,
  nullif(instr(lower(prompt_text), ?), 0) - 1    AS prompt_match,
  nullif(instr(lower(response_text), ?), 0) - 1  AS response_match,
  nullif(instr(lower(reasoning_text), ?), 0) - 1 AS reasoning_match`

/** The lowered-term binds {@link MATCH_COLUMNS} needs. */
function matchBinds(contains: string): string[] {
  const lowered = contains.toLowerCase()
  return [lowered, lowered, lowered]
}

/**
 * The SQL predicate for one outcome class, or null for "no narrowing". Mirrors `classifyCall`
 * and the Drizzle repo: a failed call is an `error`; a successful one cut short by the output
 * limit or a content filter is a `warning`; the rest are `ok`. In SQL so a narrowed page spends
 * its `limit` on rows the caller wants.
 */
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

/**
 * Statements per `db.batch` in the batch append. D1 executes a batch in one round trip as an
 * implicit transaction; chunking keeps a long run's ingest off any single-request ceiling.
 */
const INSERT_CHUNK_SIZE = 50

/** D1-backed sink for LLM observability (see migration 0026). */
export class D1LlmCallMetricRepository implements LlmCallMetricRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(metric: LlmCallMetric): Promise<void> {
    // First write wins (see the port). The harness-call recorder deliberately re-offers a
    // deterministic id — the terminal write repeats calls the live poll drain already stored,
    // and a durable-driver replay repeats the lot — so ignoring the repeat is what makes those
    // paths idempotent. Never an UPSERT: overwriting would invalidate the row's stored prompt
    // delta, which is only meaningful against the chain tip that preceded its FIRST write.
    // `ON CONFLICT(id)`, NOT `INSERT OR IGNORE`: the latter also swallows NOT NULL/CHECK
    // violations, so a malformed metric would vanish here while still throwing on Postgres.
    // This mirrors the Drizzle repo's `onConflictDoNothing({ target: id })` exactly — only a
    // duplicate id is ignored.
    await this.insertStatement(metric).run()
  }

  async recordMany(metrics: LlmCallMetric[]): Promise<void> {
    // One `batch` per chunk — a single round trip and one implicit transaction each — never a
    // `record` loop (the banned N+1 write). D1 caps bound parameters per statement, so a batch of
    // single-row statements is the portable shape rather than one multi-row VALUES. Same
    // first-write-wins-by-id semantics as `record`, which is what lets the mothership-mode
    // telemetry ingest retry a chunk whose ack was lost.
    const statements = metrics.map((metric) => this.insertStatement(metric))
    for (let i = 0; i < statements.length; i += INSERT_CHUNK_SIZE) {
      await this.db.batch(statements.slice(i, i + INSERT_CHUNK_SIZE))
    }
  }

  private insertStatement(metric: LlmCallMetric) {
    return this.db
      .prepare(
        `INSERT INTO llm_call_metrics
           (id, workspace_id, execution_id, agent_kind, provider, model, created_at,
            streaming, phase, turn_index, message_count, tool_count, request_max_tokens,
            prompt_tokens, cache_read_tokens, cache_write_tokens, completion_tokens,
            total_tokens, finish_reason,
            upstream_ms, overhead_ms, total_ms, ok, http_status, error_message,
            prompt_text, prompt_prefix_count, prompt_hash, response_text, reasoning_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        metric.id,
        metric.workspaceId,
        metric.executionId,
        metric.agentKind,
        metric.provider,
        metric.model,
        metric.createdAt,
        metric.streaming ? 1 : 0,
        metric.phase,
        metric.turnIndex,
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
      )
  }

  async latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null> {
    // The newest call for the conversation; one indexed row, no text columns.
    const row = await this.db
      .prepare(
        // message_count breaks a same-millisecond createdAt tie in chain order (it
        // grows monotonically as the conversation appends); id is the last resort.
        // `message_count > 0` skips rows that can never BE a tip: a subagent call carries no
        // re-sendable prompt chain (empty prompt, count 0), and such calls interleave with the
        // parent's in real time now that telemetry streams. Letting one become the tip makes
        // the next parent call unchainable, so it stores its whole prompt instead of a delta —
        // the compression this chain exists for, lost for the rest of the run. Mirrors the
        // Drizzle repo.
        `SELECT message_count, prompt_hash FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ? AND agent_kind = ? AND message_count > 0
         ORDER BY created_at DESC, message_count DESC, id DESC
         LIMIT 1`,
      )
      .bind(workspaceId, executionId, agentKind)
      .first<{ message_count: number; prompt_hash: string }>()
    return row ? { messageCount: row.message_count, promptHash: row.prompt_hash } : null
  }

  async listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
    agentKind?: string,
  ): Promise<LlmCallMetric[]> {
    // Newest first; `LIMIT -1` means "no limit" in SQLite, so an omitted cap reads all.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ?
           AND (? IS NULL OR agent_kind = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(workspaceId, executionId, agentKind ?? null, agentKind ?? null, limit ?? -1)
      .all<MetricRow>()
    return (results ?? []).map(rowToMetric)
  }

  async listRunPage(workspaceId: string, query: LlmCallRunPageQuery): Promise<LlmCallMetric[]> {
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    const binds: unknown[] = [workspaceId, query.executionId]
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
    const { results } = await this.db
      .prepare(
        `SELECT * FROM llm_call_metrics
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<MetricRow>()
    return (results ?? []).map(rowToMetric)
  }

  async listPage(workspaceId: string, query: LlmCallPageQuery): Promise<LlmCallMetricPage[]> {
    const ascending = query.order === 'oldest'
    const clauses = ['workspace_id = ?', 'execution_id = ?']
    // The SELECT-list binds come FIRST (slices, then match offsets), ahead of every WHERE
    // placeholder.
    const binds: unknown[] = [
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
      // The surface's grep: SQLite's LIKE is ASCII-case-insensitive by default, and the shared
      // escaper makes `%`/`_` in the term literal (`ESCAPE '\'` — SQLite has no default escape
      // character, unlike Postgres).
      const pattern = `%${escapeLikePattern(query.contains)}%`
      clauses.push(
        `(prompt_text LIKE ? ESCAPE '\\' OR response_text LIKE ? ESCAPE '\\' OR reasoning_text LIKE ? ESCAPE '\\')`,
      )
      binds.push(pattern, pattern, pattern)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY. Calls are recorded off the response path, so a
      // burst genuinely shares a millisecond; a `created_at`-only bound would drop the ties.
      const cmp = ascending ? '>' : '<'
      clauses.push(`(created_at ${cmp} ? OR (created_at = ? AND id ${cmp} ?))`)
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    binds.push(query.limit)
    const direction = ascending ? 'ASC' : 'DESC'
    const { results } = await this.db
      .prepare(
        `SELECT ${PAGE_METADATA_COLUMNS}, ${bodyColumns(query.bodyChars)}${
          query.contains != null ? MATCH_COLUMNS : ''
        }
         FROM llm_call_metrics
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at ${direction}, id ${direction}
         LIMIT ?`,
      )
      .bind(...binds)
      .all<PageRow>()
    return (results ?? []).map(rowToPage)
  }

  async get(
    workspaceId: string,
    id: string,
    body?: LlmCallBodyWindow,
  ): Promise<LlmCallMetricPage | null> {
    const row = await this.db
      .prepare(
        `SELECT ${PAGE_METADATA_COLUMNS}, ${bodyColumns(body?.chars, body?.offset ?? 0)}
         FROM llm_call_metrics
         WHERE workspace_id = ? AND id = ?`,
      )
      .bind(...bodyBinds(body?.chars, body?.offset ?? 0), workspaceId, id)
      .first<PageRow>()
    return row ? rowToPage(row) : null
  }

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    // Aggregate-only: deliberately selects no prompt/response text, so this stays
    // cheap to run on every execution emit (it backs the live board rollups).
    const { results } = await this.db
      .prepare(
        `SELECT
           agent_kind                                                   AS agent_kind,
           phase                                                        AS phase,
           COUNT(*)                                                     AS calls,
           COALESCE(SUM(prompt_tokens), 0)                              AS prompt_tokens,
           COALESCE(SUM(cache_read_tokens), 0)                          AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0)                         AS cache_write_tokens,
           COALESCE(SUM(completion_tokens), 0)                          AS completion_tokens,
           COALESCE(MAX(completion_tokens), 0)                          AS peak_completion_tokens,
           MAX(request_max_tokens)                                      AS max_output_tokens,
           COALESCE(SUM(CASE WHEN finish_reason = 'length' THEN 1 ELSE 0 END), 0)         AS truncated_calls,
           COALESCE(SUM(upstream_ms), 0)                                AS upstream_ms,
           COALESCE(SUM(overhead_ms), 0)                                AS overhead_ms,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0)         AS errors,
           COALESCE(SUM(CASE WHEN ok = 1 AND finish_reason IN (${WARNING_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS warnings,
           COALESCE(SUM(input_tokens * turns_after), 0)                 AS carry_cost_tokens
         FROM (${CARRY_COST_SUBQUERY_SQL})
         GROUP BY agent_kind, phase`,
      )
      .bind(workspaceId, executionId)
      .all<SummaryRow>()
    return (results ?? []).map(rowToSummary)
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_llm_call_metrics_created; bounded by the rows being pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM llm_call_metrics WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}
