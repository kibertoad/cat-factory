// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import { parseJsonArray } from './_shared.js'
import type {
  AgentContextIndexQuery,
  AgentContextRunPageQuery,
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  AgentContextSnapshotRepository,
  AgentSearchQuery,
  AgentSearchQueryPageQuery,
  AgentSearchQueryRepository,
  AgentToolCall,
  AgentToolCallPageQuery,
  AgentToolCallRepository,
  AgentToolCallSummary,
  AgentToolCallTrajectoryQuery,
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  DocumentArtifactRef,
  DocumentOrigin,
  LlmCallBodyWindow,
  LlmCallMetric,
  LlmCallMetricPage,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmCallOutcomeFilter,
  LlmCallPageQuery,
  LlmCallRunPageQuery,
  LlmPromptChainTip,
  ProvisioningLogQuery,
  ProvisioningLogRecord,
  ProvisioningLogRepository,
} from '@cat-factory/kernel'
import {
  LLM_WARNING_FINISH_REASONS,
  dedupeDocumentRefs,
  escapeLikePattern,
} from '@cat-factory/kernel'
import { isWebSearchProvider } from '@cat-factory/contracts'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentContextSnapshots,
  agentSearchQueries,
  agentToolCalls,
  binaryArtifacts,
  llmCallMetrics,
  provisioningLog,
} from '../../db/schema.js'

function rowToLlmMetric(row: typeof llmCallMetrics.$inferSelect): LlmCallMetric {
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
 * The SQL predicate for one outcome class, or undefined for "no narrowing". Mirrors
 * `classifyCall`: a failed call is an `error`; a successful one cut short by the output limit
 * or a content filter is a `warning`; the rest are `ok`. Kept in SQL so a narrowed page spends
 * its `limit` on rows the caller wants, rather than filtering a page down to three rows.
 */
function llmOutcomeFilter(outcome: LlmCallOutcomeFilter | undefined) {
  const reasons = [...LLM_WARNING_FINISH_REASONS]
  if (outcome === 'error') return eq(llmCallMetrics.ok, 0)
  if (outcome === 'warning') {
    return and(eq(llmCallMetrics.ok, 1), inArray(llmCallMetrics.finish_reason, reasons))
  }
  if (outcome === 'ok') {
    // `finish_reason` is nullable and a plain `NOT IN (...)` is UNKNOWN for NULL in SQL, which
    // would silently drop clean calls that recorded no finish reason. Mirrors the D1 repo's
    // explicit `finish_reason IS NULL OR finish_reason NOT IN (...)`.
    return and(
      eq(llmCallMetrics.ok, 1),
      or(isNull(llmCallMetrics.finish_reason), notInArray(llmCallMetrics.finish_reason, reasons)),
    )
  }
  return undefined
}

/**
 * The column set for a bounded page: every metadata column, plus each text body windowed to
 * the caller's budget (from `offsetChars` on) and its full `length()` alongside. The cases,
 * kept in step with the D1 repo's `bodyColumns`:
 *
 *  - `undefined` budget at offset 0 selects the column RAW. Deliberately not a huge sentinel
 *    length: SQLite returns an EMPTY string for one of those, so a shared "give me
 *    everything" sentinel would make the two stores disagree on the point read that exists
 *    to return whole bodies.
 *  - `undefined` budget at a later offset selects the REST of the body (two-argument
 *    `substr`).
 *  - `0` selects a literal empty string rather than `substr(col, 1, 0)`, so a sweep over a
 *    long run never makes the database materialise (or the driver transfer) a single prompt
 *    byte — the whole reason bodies are opt-in on this surface.
 *  - anything else slices the window; `substr` is 1-based and counts characters, so the
 *    parameter is `offset + 1`.
 *
 * The lengths are reported either way, because a size is what tells the caller which rows are
 * worth a point read.
 *
 * `containsLower` (the search term, ASCII-lowered like the D1 repo's) additionally selects a
 * per-body first-match offset — `nullif(position(term in lower(col)), 0) - 1`, NULL where
 * the term does not occur. `position` counts characters like `substr`, so the offset feeds a
 * point read's window directly.
 */
function llmPageColumns(bodyChars: number | undefined, offsetChars = 0, containsLower?: string) {
  const from = Math.max(0, offsetChars) + 1
  const slice = (column: AnyPgColumn) => {
    if (bodyChars !== undefined && bodyChars <= 0) return sql<string>`''`
    if (bodyChars === undefined && offsetChars <= 0) return column
    if (bodyChars === undefined) return sql<string>`substr(${column}, ${from})`
    return sql<string>`substr(${column}, ${from}, ${bodyChars})`
  }
  // Selected as literal NULL on an unsearched page (a plain conditional spread would make the
  // select shape a union type): `rowToLlmCallPage`'s `searched` flag keeps "no search ran"
  // distinct from "searched, no match" on the domain shape.
  const match = (column: AnyPgColumn) =>
    containsLower === undefined
      ? sql<number | null>`NULL`
      : sql<number | null>`nullif(position(${containsLower} in lower(${column})), 0) - 1`
  return {
    prompt_match: match(llmCallMetrics.prompt_text),
    response_match: match(llmCallMetrics.response_text),
    reasoning_match: match(llmCallMetrics.reasoning_text),
    id: llmCallMetrics.id,
    workspace_id: llmCallMetrics.workspace_id,
    execution_id: llmCallMetrics.execution_id,
    agent_kind: llmCallMetrics.agent_kind,
    provider: llmCallMetrics.provider,
    model: llmCallMetrics.model,
    created_at: llmCallMetrics.created_at,
    streaming: llmCallMetrics.streaming,
    phase: llmCallMetrics.phase,
    turn_index: llmCallMetrics.turn_index,
    message_count: llmCallMetrics.message_count,
    tool_count: llmCallMetrics.tool_count,
    request_max_tokens: llmCallMetrics.request_max_tokens,
    prompt_tokens: llmCallMetrics.prompt_tokens,
    cache_read_tokens: llmCallMetrics.cache_read_tokens,
    cache_write_tokens: llmCallMetrics.cache_write_tokens,
    completion_tokens: llmCallMetrics.completion_tokens,
    total_tokens: llmCallMetrics.total_tokens,
    finish_reason: llmCallMetrics.finish_reason,
    upstream_ms: llmCallMetrics.upstream_ms,
    overhead_ms: llmCallMetrics.overhead_ms,
    total_ms: llmCallMetrics.total_ms,
    ok: llmCallMetrics.ok,
    http_status: llmCallMetrics.http_status,
    error_message: llmCallMetrics.error_message,
    prompt_prefix_count: llmCallMetrics.prompt_prefix_count,
    prompt_text: slice(llmCallMetrics.prompt_text),
    prompt_chars: sql<number>`length(${llmCallMetrics.prompt_text})::int`,
    response_text: slice(llmCallMetrics.response_text),
    response_chars: sql<number>`length(${llmCallMetrics.response_text})::int`,
    reasoning_text: slice(llmCallMetrics.reasoning_text),
    reasoning_chars: sql<number>`length(${llmCallMetrics.reasoning_text})::int`,
  }
}

type LlmPageRow = { [K in keyof ReturnType<typeof llmPageColumns>]: unknown }

function rowToLlmCallPage(row: LlmPageRow, searched = false): LlmCallMetricPage {
  const r = row as {
    prompt_match: number | string | null
    response_match: number | string | null
    reasoning_match: number | string | null
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
    prompt_prefix_count: number
    prompt_text: string
    prompt_chars: number
    response_text: string
    response_chars: number
    reasoning_text: string
    reasoning_chars: number
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    executionId: r.execution_id,
    agentKind: r.agent_kind,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
    streaming: r.streaming === 1,
    phase: r.phase,
    turnIndex: r.turn_index,
    messageCount: r.message_count,
    toolCount: r.tool_count,
    requestMaxTokens: r.request_max_tokens,
    promptTokens: r.prompt_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    finishReason: r.finish_reason,
    upstreamMs: r.upstream_ms,
    overheadMs: r.overhead_ms,
    totalMs: r.total_ms,
    ok: r.ok === 1,
    httpStatus: r.http_status,
    errorMessage: r.error_message,
    promptPrefixCount: r.prompt_prefix_count,
    // A searched row attaches each body's first-match offset (null = the term occurs only in
    // a sibling body); an unsearched row carries none, so the two states stay distinct.
    prompt: {
      text: r.prompt_text,
      totalChars: Number(r.prompt_chars ?? 0),
      ...(searched ? { matchOffset: r.prompt_match == null ? null : Number(r.prompt_match) } : {}),
    },
    response: {
      text: r.response_text,
      totalChars: Number(r.response_chars ?? 0),
      ...(searched
        ? { matchOffset: r.response_match == null ? null : Number(r.response_match) }
        : {}),
    },
    reasoning: {
      text: r.reasoning_text,
      totalChars: Number(r.reasoning_chars ?? 0),
      ...(searched
        ? { matchOffset: r.reasoning_match == null ? null : Number(r.reasoning_match) }
        : {}),
    },
  }
}

/**
 * Rows per multi-row INSERT in the batch appends below. Postgres caps a statement at 65535 bind
 * parameters and the widest of these rows binds ~30 columns, so 200 leaves generous headroom
 * while keeping the mothership-mode telemetry ingest to a handful of statements per chunk.
 */
const INSERT_CHUNK_ROWS = 200

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One metric as its insert row — shared by the single-row and batch appends so they can't drift. */
function metricValues(metric: LlmCallMetric) {
  return {
    id: metric.id,
    workspace_id: metric.workspaceId,
    execution_id: metric.executionId,
    agent_kind: metric.agentKind,
    provider: metric.provider,
    model: metric.model,
    created_at: metric.createdAt,
    streaming: metric.streaming ? 1 : 0,
    phase: metric.phase,
    turn_index: metric.turnIndex,
    message_count: metric.messageCount,
    tool_count: metric.toolCount,
    request_max_tokens: metric.requestMaxTokens,
    prompt_tokens: metric.promptTokens,
    cache_read_tokens: metric.cacheReadTokens,
    cache_write_tokens: metric.cacheWriteTokens,
    completion_tokens: metric.completionTokens,
    total_tokens: metric.totalTokens,
    finish_reason: metric.finishReason,
    upstream_ms: metric.upstreamMs,
    overhead_ms: metric.overheadMs,
    total_ms: metric.totalMs,
    ok: metric.ok ? 1 : 0,
    http_status: metric.httpStatus,
    error_message: metric.errorMessage,
    prompt_text: metric.promptText,
    prompt_prefix_count: metric.promptPrefixCount,
    prompt_hash: metric.promptHash,
    response_text: metric.responseText,
    reasoning_text: metric.reasoningText,
  }
}

export class DrizzleLlmCallMetricRepository implements LlmCallMetricRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(metric: LlmCallMetric): Promise<void> {
    // First write wins (see the port). The harness-call recorder deliberately re-offers a
    // deterministic id: the terminal write repeats calls the live poll drain already stored,
    // and a durable-driver replay repeats the lot. Ignoring the repeat is what makes those
    // paths idempotent; UPDATING instead would invalidate the row's stored prompt delta, which
    // is only meaningful against the chain tip that preceded its FIRST write.
    await this.db
      .insert(llmCallMetrics)
      .values(metricValues(metric))
      .onConflictDoNothing({ target: llmCallMetrics.id })
  }

  async recordMany(metrics: LlmCallMetric[]): Promise<void> {
    // One multi-row insert per chunk (never `record` in a loop — that is the banned N+1 write).
    // Chunked because Postgres caps a statement's bind parameters and these rows are wide.
    for (const batch of chunks(metrics, INSERT_CHUNK_ROWS)) {
      await this.db
        .insert(llmCallMetrics)
        .values(batch.map(metricValues))
        .onConflictDoNothing({ target: llmCallMetrics.id })
    }
  }

  async latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null> {
    // The newest call for the conversation; one indexed row, no text columns.
    // `message_count > 0` skips rows that can never BE a tip: a subagent call carries no
    // re-sendable prompt chain (empty prompt, count 0), and such calls interleave with the
    // parent's in real time now that telemetry streams. Letting one become the tip makes the
    // next parent call unchainable, so it stores its whole prompt instead of a delta — the
    // compression this chain exists for, lost for the rest of the run. Mirrors the D1 repo.
    const rows = await this.db
      .select({
        messageCount: llmCallMetrics.message_count,
        promptHash: llmCallMetrics.prompt_hash,
      })
      .from(llmCallMetrics)
      .where(
        and(
          eq(llmCallMetrics.workspace_id, workspaceId),
          eq(llmCallMetrics.execution_id, executionId),
          eq(llmCallMetrics.agent_kind, agentKind),
          gt(llmCallMetrics.message_count, 0),
        ),
      )
      // message_count breaks a same-millisecond createdAt tie in chain order (it grows
      // monotonically as the conversation appends); id is the last resort.
      .orderBy(
        desc(llmCallMetrics.created_at),
        desc(llmCallMetrics.message_count),
        desc(llmCallMetrics.id),
      )
      .limit(1)
    const row = rows[0]
    return row ? { messageCount: row.messageCount, promptHash: row.promptHash } : null
  }

  async listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
    agentKind?: string,
  ): Promise<LlmCallMetric[]> {
    const base = this.db
      .select()
      .from(llmCallMetrics)
      .where(
        and(
          eq(llmCallMetrics.workspace_id, workspaceId),
          eq(llmCallMetrics.execution_id, executionId),
          ...(agentKind == null ? [] : [eq(llmCallMetrics.agent_kind, agentKind)]),
        ),
      )
      .orderBy(desc(llmCallMetrics.created_at), desc(llmCallMetrics.id))
    const rows = await (limit == null ? base : base.limit(limit))
    return rows.map(rowToLlmMetric)
  }

  async listRunPage(workspaceId: string, query: LlmCallRunPageQuery): Promise<LlmCallMetric[]> {
    const filters = [
      eq(llmCallMetrics.workspace_id, workspaceId),
      eq(llmCallMetrics.execution_id, query.executionId),
    ]
    if (query.agentKind != null) filters.push(eq(llmCallMetrics.agent_kind, query.agentKind))
    if (query.cursor) {
      // Composite keyset matching the ORDER BY, for the same reason `listPage`'s is composite.
      const { createdAt, id } = query.cursor
      filters.push(
        or(
          lt(llmCallMetrics.created_at, createdAt),
          and(eq(llmCallMetrics.created_at, createdAt), lt(llmCallMetrics.id, id)),
        )!,
      )
    }
    // A whole-row select, unlike `listPage`, which projects sliced bodies plus their lengths.
    const rows = await this.db
      .select()
      .from(llmCallMetrics)
      .where(and(...filters))
      .orderBy(desc(llmCallMetrics.created_at), desc(llmCallMetrics.id))
      .limit(query.limit)
    return rows.map(rowToLlmMetric)
  }

  async listPage(workspaceId: string, query: LlmCallPageQuery): Promise<LlmCallMetricPage[]> {
    const ascending = query.order === 'oldest'
    const filters = [
      eq(llmCallMetrics.workspace_id, workspaceId),
      eq(llmCallMetrics.execution_id, query.executionId),
    ]
    if (query.agentKind != null) filters.push(eq(llmCallMetrics.agent_kind, query.agentKind))
    // `!= null`, not a truthiness check: '' is the unattributed slice and a legitimate filter.
    if (query.phase != null) filters.push(eq(llmCallMetrics.phase, query.phase))
    const outcome = llmOutcomeFilter(query.outcome)
    if (outcome) filters.push(outcome)
    if (query.contains != null) {
      // The surface's grep. ILIKE for case-insensitivity (SQLite's plain LIKE is already
      // ASCII-insensitive; conformance pins the ASCII behaviour the two share), with `%`/`_`
      // in the term made literal by the shared escaper — Postgres' default escape character
      // is the backslash it uses, so no ESCAPE clause is needed here.
      const pattern = `%${escapeLikePattern(query.contains)}%`
      filters.push(
        or(
          ilike(llmCallMetrics.prompt_text, pattern),
          ilike(llmCallMetrics.response_text, pattern),
          ilike(llmCallMetrics.reasoning_text, pattern),
        )!,
      )
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY. Calls are recorded off the response path, so a
      // burst genuinely shares a millisecond; a `created_at`-only bound would drop the ties.
      const { createdAt, id } = query.cursor
      const [timeCmp, idCmp] = ascending ? [gt, gt] : [lt, lt]
      filters.push(
        or(
          timeCmp(llmCallMetrics.created_at, createdAt),
          and(eq(llmCallMetrics.created_at, createdAt), idCmp(llmCallMetrics.id, id)),
        )!,
      )
    }
    const searched = query.contains != null
    const rows = await this.db
      .select(llmPageColumns(query.bodyChars, 0, query.contains?.toLowerCase()))
      .from(llmCallMetrics)
      .where(and(...filters))
      .orderBy(
        ascending ? asc(llmCallMetrics.created_at) : desc(llmCallMetrics.created_at),
        ascending ? asc(llmCallMetrics.id) : desc(llmCallMetrics.id),
      )
      .limit(query.limit)
    return rows.map((row) => rowToLlmCallPage(row, searched))
  }

  async get(
    workspaceId: string,
    id: string,
    body?: LlmCallBodyWindow,
  ): Promise<LlmCallMetricPage | null> {
    const rows = await this.db
      .select(llmPageColumns(body?.chars, body?.offset ?? 0))
      .from(llmCallMetrics)
      .where(and(eq(llmCallMetrics.workspace_id, workspaceId), eq(llmCallMetrics.id, id)))
      .limit(1)
    return rows[0] ? rowToLlmCallPage(rows[0]) : null
  }

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    // Aggregate-only: selects no prompt/response text, so it stays cheap on every
    // execution emit (it backs the live board rollups). int sums fit Number's safe
    // range here (per-run call counts/tokens are small), so a plain ::bigint cast
    // matching the SQLite 64-bit sum is unnecessary — totals are coerced below. The
    // ONE exception is the carry cost, a product of two sums: it clears int4's 2.1e9
    // ceiling on any real run, so it is summed as ::bigint (which arrives as a string
    // from node-postgres and is coerced like the rest).
    const reasons = [...LLM_WARNING_FINISH_REASONS]
    // Each call with its total input and the turns left in ITS conversation after it — the
    // two factors of the carry-cost proxy. `partition by agent_kind` is the conversation
    // boundary (the prompt delta chain is keyed by `(workspace, execution, agent_kind)`), and
    // the ordering avoids `turn_index` because a proxied row's is NULL by design; mirrors the
    // D1/node:sqlite subquery exactly.
    const ranked = this.db
      .select({
        agentKind: llmCallMetrics.agent_kind,
        phase: llmCallMetrics.phase,
        provider: llmCallMetrics.provider,
        model: llmCallMetrics.model,
        completionTokens: llmCallMetrics.completion_tokens,
        promptTokens: llmCallMetrics.prompt_tokens,
        cacheReadTokens: llmCallMetrics.cache_read_tokens,
        cacheWriteTokens: llmCallMetrics.cache_write_tokens,
        requestMaxTokens: llmCallMetrics.request_max_tokens,
        finishReason: llmCallMetrics.finish_reason,
        upstreamMs: llmCallMetrics.upstream_ms,
        overheadMs: llmCallMetrics.overhead_ms,
        ok: llmCallMetrics.ok,
        inputTokens:
          sql<number>`(${llmCallMetrics.prompt_tokens} + ${llmCallMetrics.cache_read_tokens} + ${llmCallMetrics.cache_write_tokens})`.as(
            'input_tokens',
          ),
        turnsAfter:
          sql<number>`(count(*) over (partition by ${llmCallMetrics.agent_kind}) - row_number() over (partition by ${llmCallMetrics.agent_kind} order by ${llmCallMetrics.created_at}, ${llmCallMetrics.message_count}, ${llmCallMetrics.id}))`.as(
            'turns_after',
          ),
      })
      .from(llmCallMetrics)
      .where(
        and(
          eq(llmCallMetrics.workspace_id, workspaceId),
          eq(llmCallMetrics.execution_id, executionId),
        ),
      )
      .as('ranked')
    const rows = await this.db
      .select({
        agentKind: ranked.agentKind,
        phase: ranked.phase,
        provider: ranked.provider,
        model: ranked.model,
        calls: sql<number>`count(*)::int`,
        promptTokens: sql<number>`coalesce(sum(${ranked.promptTokens}), 0)::int`,
        cacheReadTokens: sql<number>`coalesce(sum(${ranked.cacheReadTokens}), 0)::int`,
        cacheWriteTokens: sql<number>`coalesce(sum(${ranked.cacheWriteTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${ranked.completionTokens}), 0)::int`,
        peakCompletionTokens: sql<number>`coalesce(max(${ranked.completionTokens}), 0)::int`,
        maxOutputTokens: sql<number | null>`max(${ranked.requestMaxTokens})`,
        truncatedCalls: sql<number>`coalesce(sum(case when ${ranked.finishReason} = 'length' then 1 else 0 end), 0)::int`,
        upstreamMs: sql<number>`coalesce(sum(${ranked.upstreamMs}), 0)::int`,
        overheadMs: sql<number>`coalesce(sum(${ranked.overheadMs}), 0)::int`,
        errors: sql<number>`coalesce(sum(case when ${ranked.ok} = 0 then 1 else 0 end), 0)::int`,
        // `inArray` builds the IN-list membership: idiomatic, type-checked, and tied to
        // the shared constant. (A raw `${...finishReason} in ${reasons}` renders the same
        // `in ($1, $2)` on this drizzle version; inArray just documents intent and can't
        // silently mis-bind the array.)
        warnings: sql<number>`coalesce(sum(case when ${ranked.ok} = 1 and ${inArray(ranked.finishReason, reasons)} then 1 else 0 end), 0)::int`,
        carryCostTokens: sql<
          number | string
        >`coalesce(sum(${ranked.inputTokens}::bigint * ${ranked.turnsAfter}), 0)::bigint`,
      })
      .from(ranked)
      .groupBy(ranked.agentKind, ranked.phase, ranked.provider, ranked.model)
    return rows.map((r) => ({
      agentKind: r.agentKind,
      phase: r.phase,
      provider: r.provider,
      model: r.model,
      calls: Number(r.calls),
      promptTokens: Number(r.promptTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      completionTokens: Number(r.completionTokens),
      peakCompletionTokens: Number(r.peakCompletionTokens),
      maxOutputTokens: r.maxOutputTokens == null ? null : Number(r.maxOutputTokens),
      truncatedCalls: Number(r.truncatedCalls),
      upstreamMs: Number(r.upstreamMs),
      overheadMs: Number(r.overheadMs),
      errors: Number(r.errors),
      warnings: Number(r.warnings),
      carryCostTokens: Number(r.carryCostTokens),
      // Unpriced at the store: a price table is configuration, not SQL. `priceRollupCells`
      // fills this in at the seam that holds one, and null until then says exactly that.
      costEstimate: null,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(llmCallMetrics)
      .where(lt(llmCallMetrics.created_at, epochMs))
      .returning({ id: llmCallMetrics.id })
    return deleted.length
  }
}

type AgentContextSnapshotRow = typeof agentContextSnapshots.$inferSelect

function rowToAgentContextSnapshot(row: AgentContextSnapshotRow): AgentContextSnapshot {
  return {
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
    fragments: parseJsonArray<AgentContextSnapshot['fragments'][number]>(row.fragments),
    contextFiles: parseJsonArray<AgentContextSnapshot['contextFiles'][number]>(row.context_files),
    extras: parseAgentContextExtras(row.extras),
  }
}

/** Parse the extras JSON object column, degrading a malformed value to {}. */

function parseAgentContextExtras(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Rows per multi-row snapshot INSERT — far smaller than {@link INSERT_CHUNK_ROWS} because a single
 * snapshot row is routinely megabytes (the whole composed system prompt plus every injected
 * `.cat-context/*` file's body), so the bind-parameter cap is never the binding constraint here.
 */
const SNAPSHOT_CHUNK_ROWS = 20

/** One snapshot as its insert row — shared by the single-row and batch appends. */
function snapshotValues(snapshot: AgentContextSnapshot) {
  return {
    id: snapshot.id,
    workspace_id: snapshot.workspaceId,
    execution_id: snapshot.executionId,
    agent_kind: snapshot.agentKind,
    step_index: snapshot.stepIndex,
    created_at: snapshot.createdAt,
    model: snapshot.model,
    harness: snapshot.harness,
    system_prompt: snapshot.systemPrompt,
    user_prompt: snapshot.userPrompt,
    fragments: JSON.stringify(snapshot.fragments),
    context_files: JSON.stringify(snapshot.contextFiles),
    extras: JSON.stringify(snapshot.extras),
  }
}

export class DrizzleAgentContextSnapshotRepository implements AgentContextSnapshotRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(snapshot: AgentContextSnapshot): Promise<void> {
    await this.db.insert(agentContextSnapshots).values(snapshotValues(snapshot))
  }

  async recordMany(snapshots: AgentContextSnapshot[]): Promise<void> {
    // Idempotent by id (see the port): the ingest retries a chunk whose ack was lost. Chunked
    // small because one snapshot row carries the whole composed prompt plus every injected
    // context file's body.
    for (const batch of chunks(snapshots, SNAPSHOT_CHUNK_ROWS)) {
      await this.db
        .insert(agentContextSnapshots)
        .values(batch.map(snapshotValues))
        .onConflictDoNothing({ target: agentContextSnapshots.id })
    }
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]> {
    const rows = await this.db
      .select()
      .from(agentContextSnapshots)
      .where(
        and(
          eq(agentContextSnapshots.workspace_id, workspaceId),
          eq(agentContextSnapshots.execution_id, executionId),
        ),
      )
      .orderBy(desc(agentContextSnapshots.created_at), desc(agentContextSnapshots.id))
    return rows.map(rowToAgentContextSnapshot)
  }

  async listIndex(
    workspaceId: string,
    query: AgentContextIndexQuery,
  ): Promise<AgentContextSnapshotIndex[]> {
    const filters = [
      eq(agentContextSnapshots.workspace_id, workspaceId),
      eq(agentContextSnapshots.execution_id, query.executionId),
    ]
    if (query.stepIndex != null) {
      filters.push(eq(agentContextSnapshots.step_index, query.stepIndex))
    }
    if (query.cursor) {
      const { createdAt, id } = query.cursor
      filters.push(
        or(
          lt(agentContextSnapshots.created_at, createdAt),
          and(eq(agentContextSnapshots.created_at, createdAt), lt(agentContextSnapshots.id, id)),
        )!,
      )
    }
    // Sizes only — the four body-bearing columns are never selected, just measured, so listing a
    // run's dispatches costs no body bytes even though a single snapshot can be megabytes.
    const rows = await this.db
      .select({
        id: agentContextSnapshots.id,
        agentKind: agentContextSnapshots.agent_kind,
        stepIndex: agentContextSnapshots.step_index,
        createdAt: agentContextSnapshots.created_at,
        model: agentContextSnapshots.model,
        harness: agentContextSnapshots.harness,
        systemPromptChars: sql<number>`length(${agentContextSnapshots.system_prompt})::int`,
        userPromptChars: sql<number>`length(${agentContextSnapshots.user_prompt})::int`,
        fragmentsChars: sql<number>`length(${agentContextSnapshots.fragments})::int`,
        contextFilesChars: sql<number>`length(${agentContextSnapshots.context_files})::int`,
      })
      .from(agentContextSnapshots)
      .where(and(...filters))
      .orderBy(desc(agentContextSnapshots.created_at), desc(agentContextSnapshots.id))
      .limit(query.limit)
    return rows.map((r) => ({
      id: r.id,
      agentKind: r.agentKind,
      stepIndex: r.stepIndex,
      createdAt: r.createdAt,
      model: r.model,
      harness: r.harness,
      systemPromptChars: Number(r.systemPromptChars ?? 0),
      userPromptChars: Number(r.userPromptChars ?? 0),
      fragmentsChars: Number(r.fragmentsChars ?? 0),
      contextFilesChars: Number(r.contextFilesChars ?? 0),
    }))
  }

  async listRunPage(
    workspaceId: string,
    query: AgentContextRunPageQuery,
  ): Promise<AgentContextSnapshot[]> {
    const filters = [
      eq(agentContextSnapshots.workspace_id, workspaceId),
      eq(agentContextSnapshots.execution_id, query.executionId),
    ]
    if (query.stepIndex != null) {
      filters.push(eq(agentContextSnapshots.step_index, query.stepIndex))
    }
    if (query.cursor) {
      const { createdAt, id } = query.cursor
      filters.push(
        or(
          lt(agentContextSnapshots.created_at, createdAt),
          and(eq(agentContextSnapshots.created_at, createdAt), lt(agentContextSnapshots.id, id)),
        )!,
      )
    }
    // Same predicate, ordering and keyset as `listIndex` — bodies included. Keeping the two in
    // step is what lets a caller page the index and then page the rows and see the same run.
    const rows = await this.db
      .select()
      .from(agentContextSnapshots)
      .where(and(...filters))
      .orderBy(desc(agentContextSnapshots.created_at), desc(agentContextSnapshots.id))
      .limit(query.limit)
    return rows.map(rowToAgentContextSnapshot)
  }

  async get(workspaceId: string, id: string): Promise<AgentContextSnapshot | null> {
    const rows = await this.db
      .select()
      .from(agentContextSnapshots)
      .where(
        and(eq(agentContextSnapshots.workspace_id, workspaceId), eq(agentContextSnapshots.id, id)),
      )
      .limit(1)
    return rows[0] ? rowToAgentContextSnapshot(rows[0]) : null
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(agentContextSnapshots)
      .where(
        and(
          eq(agentContextSnapshots.workspace_id, workspaceId),
          eq(agentContextSnapshots.execution_id, executionId),
        ),
      )
    return Number(rows[0]?.n ?? 0)
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(agentContextSnapshots)
      .where(lt(agentContextSnapshots.created_at, epochMs))
      .returning({ id: agentContextSnapshots.id })
    return deleted.length
  }
}

type AgentSearchQueryRow = typeof agentSearchQueries.$inferSelect

function rowToAgentSearchQuery(row: AgentSearchQueryRow): AgentSearchQuery {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    // The stored provider column is free-text; narrow it back to the wire union.
    provider: isWebSearchProvider(row.provider) ? row.provider : null,
    query: row.query,
    resultCount: row.result_count,
    createdAt: row.created_at,
  }
}

/** One search query as its insert row — shared by the single-row and batch appends. */
function searchQueryValues(query: AgentSearchQuery) {
  return {
    id: query.id,
    workspace_id: query.workspaceId,
    execution_id: query.executionId,
    agent_kind: query.agentKind,
    provider: query.provider,
    query: query.query,
    result_count: query.resultCount,
    created_at: query.createdAt,
  }
}

export class DrizzleAgentSearchQueryRepository implements AgentSearchQueryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(query: AgentSearchQuery): Promise<void> {
    await this.db.insert(agentSearchQueries).values(searchQueryValues(query))
  }

  async recordMany(queries: AgentSearchQuery[]): Promise<void> {
    // Idempotent by id (see the port): the ingest retries a chunk whose ack was lost.
    for (const batch of chunks(queries, INSERT_CHUNK_ROWS)) {
      await this.db
        .insert(agentSearchQueries)
        .values(batch.map(searchQueryValues))
        .onConflictDoNothing({ target: agentSearchQueries.id })
    }
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]> {
    const rows = await this.db
      .select()
      .from(agentSearchQueries)
      .where(
        and(
          eq(agentSearchQueries.workspace_id, workspaceId),
          eq(agentSearchQueries.execution_id, executionId),
        ),
      )
      .orderBy(desc(agentSearchQueries.created_at), desc(agentSearchQueries.id))
    return rows.map(rowToAgentSearchQuery)
  }

  async listPage(
    workspaceId: string,
    query: AgentSearchQueryPageQuery,
  ): Promise<AgentSearchQuery[]> {
    const filters = [
      eq(agentSearchQueries.workspace_id, workspaceId),
      eq(agentSearchQueries.execution_id, query.executionId),
    ]
    if (query.cursor) {
      const { createdAt, id } = query.cursor
      filters.push(
        or(
          lt(agentSearchQueries.created_at, createdAt),
          and(eq(agentSearchQueries.created_at, createdAt), lt(agentSearchQueries.id, id)),
        )!,
      )
    }
    const rows = await this.db
      .select()
      .from(agentSearchQueries)
      .where(and(...filters))
      .orderBy(desc(agentSearchQueries.created_at), desc(agentSearchQueries.id))
      .limit(query.limit)
    return rows.map(rowToAgentSearchQuery)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(agentSearchQueries)
      .where(
        and(
          eq(agentSearchQueries.workspace_id, workspaceId),
          eq(agentSearchQueries.execution_id, executionId),
        ),
      )
    return Number(rows[0]?.n ?? 0)
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(agentSearchQueries)
      .where(lt(agentSearchQueries.created_at, epochMs))
      .returning({ id: agentSearchQueries.id })
    return deleted.length
  }
}

function rowToAgentToolCall(row: typeof agentToolCalls.$inferSelect): AgentToolCall {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    jobId: row.job_id,
    seq: row.seq,
    tool: row.tool,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ok: row.ok === 1,
    // The stored column is free-text; narrow it back to the wire union. Anything else reads as
    // `withheld`, the answer that claims nothing about a body we cannot account for.
    bodies: row.bodies === 'stored' ? 'stored' : 'withheld',
    args: row.args,
    result: row.result,
    argsDropped: row.args_dropped,
    resultDropped: row.result_dropped,
    createdAt: row.created_at,
  }
}

/** One tool call as its insert row. */
function toolCallValues(call: AgentToolCall) {
  return {
    id: call.id,
    workspace_id: call.workspaceId,
    execution_id: call.executionId,
    agent_kind: call.agentKind,
    job_id: call.jobId,
    seq: call.seq,
    tool: call.tool,
    started_at: call.startedAt,
    ended_at: call.endedAt,
    ok: call.ok ? 1 : 0,
    bodies: call.bodies,
    args: call.args,
    result: call.result,
    args_dropped: call.argsDropped,
    result_dropped: call.resultDropped,
    created_at: call.createdAt,
  }
}

/** Drizzle/Postgres sink for the tool-call trajectory (mirror of D1 migration 0005). */
export class DrizzleAgentToolCallRepository implements AgentToolCallRepository {
  constructor(private readonly db: DrizzleDb) {}

  async recordMany(calls: AgentToolCall[]): Promise<void> {
    // First write wins, never an upsert: a re-offered call is byte-identical to the stored one
    // (its id derives from `(jobId, seq)`), so a durable replay or a retried ingest is a no-op.
    for (const batch of chunks(calls, INSERT_CHUNK_ROWS)) {
      await this.db
        .insert(agentToolCalls)
        .values(batch.map(toolCallValues))
        .onConflictDoNothing({ target: agentToolCalls.id })
    }
  }

  async listByExecution(
    workspaceId: string,
    query: AgentToolCallTrajectoryQuery,
  ): Promise<AgentToolCall[]> {
    // Trajectory order: oldest first by the call's own start — `created_at` cannot carry it,
    // since a whole poll window's calls share one stamp, and `job_id` is a string that would
    // sort a run's dispatches alphabetically. `seq` separates the calls sharing a millisecond
    // and `id` makes the order total. The limit takes the OLDEST end, so a truncated read is a
    // prefix of the run rather than a middle slice with no beginning.
    const filters = [
      eq(agentToolCalls.workspace_id, workspaceId),
      eq(agentToolCalls.execution_id, query.executionId),
    ]
    if (query.jobId) filters.push(eq(agentToolCalls.job_id, query.jobId))
    if (query.ok !== undefined) filters.push(eq(agentToolCalls.ok, query.ok ? 1 : 0))
    const rows = await this.db
      .select()
      .from(agentToolCalls)
      .where(and(...filters))
      .orderBy(asc(agentToolCalls.started_at), asc(agentToolCalls.seq), asc(agentToolCalls.id))
      .limit(query.limit)
    return rows.map(rowToAgentToolCall)
  }

  async listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]> {
    const filters = [
      eq(agentToolCalls.workspace_id, workspaceId),
      eq(agentToolCalls.execution_id, query.executionId),
    ]
    if (query.jobId) filters.push(eq(agentToolCalls.job_id, query.jobId))
    if (query.ok !== undefined) filters.push(eq(agentToolCalls.ok, query.ok ? 1 : 0))
    if (query.cursor) {
      const { createdAt, id } = query.cursor
      filters.push(
        or(
          lt(agentToolCalls.created_at, createdAt),
          and(eq(agentToolCalls.created_at, createdAt), lt(agentToolCalls.id, id)),
        )!,
      )
    }
    const rows = await this.db
      .select()
      .from(agentToolCalls)
      .where(and(...filters))
      .orderBy(desc(agentToolCalls.created_at), desc(agentToolCalls.id))
      .limit(query.limit)
    return rows.map(rowToAgentToolCall)
  }

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<AgentToolCallSummary[]> {
    // Mirror of the D1 GROUP BY: one pass over the run's rows, neither body column read, and
    // the failures summed in SQL beside the count rather than by a second query or a JS reduce.
    const rows = await this.db
      .select({
        agentKind: agentToolCalls.agent_kind,
        tool: agentToolCalls.tool,
        calls: count(),
        failures: sql<number>`sum(case when ${agentToolCalls.ok} = 0 then 1 else 0 end)`,
      })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.workspace_id, workspaceId),
          eq(agentToolCalls.execution_id, executionId),
        ),
      )
      .groupBy(agentToolCalls.agent_kind, agentToolCalls.tool)
    return rows.map((row) => ({
      agentKind: row.agentKind,
      tool: row.tool,
      // Postgres returns COUNT/SUM as bigint strings over the wire; Number() on both keeps the
      // two runtimes' cells identical rather than one store's numbers arriving as text.
      calls: Number(row.calls),
      failures: Number(row.failures ?? 0),
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(agentToolCalls)
      .where(lt(agentToolCalls.created_at, epochMs))
      .returning({ id: agentToolCalls.id })
    return deleted.length
  }
}

function rowToBinaryArtifact(row: typeof binaryArtifacts.$inferSelect): BinaryArtifactRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    blockId: row.block_id,
    kind: row.kind as BinaryArtifactRecord['kind'],
    view: row.view,
    contentType: row.content_type,
    byteSize: row.byte_size,
    hash: row.hash,
    storage: row.storage as BinaryArtifactRecord['storage'],
    storageKey: row.storage_key,
    // Both halves or neither: a row with only one is not a document reference, and treating it as
    // one would key a reclaim on a half-identity that matches the wrong artifacts.
    document:
      row.document_source && row.document_external_id
        ? { source: row.document_source as DocumentOrigin, externalId: row.document_external_id }
        : null,
    createdAt: row.created_at,
  }
}

/** Drizzle/Postgres metadata store for binary artifacts (mirror of D1 migration 0017). */

export class DrizzleBinaryArtifactMetadataStore implements BinaryArtifactMetadataStore {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: BinaryArtifactRecord): Promise<void> {
    await this.db.insert(binaryArtifacts).values({
      workspace_id: record.workspaceId,
      id: record.id,
      execution_id: record.executionId,
      block_id: record.blockId,
      kind: record.kind,
      view: record.view,
      content_type: record.contentType,
      byte_size: record.byteSize,
      hash: record.hash,
      storage: record.storage,
      storage_key: record.storageKey,
      document_source: record.document?.source ?? null,
      document_external_id: record.document?.externalId ?? null,
      created_at: record.createdAt,
    })
  }

  async get(workspaceId: string, id: string): Promise<BinaryArtifactRecord | null> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.id, id)))
      .limit(1)
    return rows[0] ? rowToBinaryArtifact(rows[0]) : null
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          eq(binaryArtifacts.execution_id, executionId),
        ),
      )
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async countByExecution(workspaceId: string, executionId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          eq(binaryArtifacts.execution_id, executionId),
        ),
      )
    return rows[0]?.n ?? 0
  }

  async countByBlock(workspaceId: string, blockId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(binaryArtifacts)
      .where(
        and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.block_id, blockId)),
      )
    return rows[0]?.n ?? 0
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(
        and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.block_id, blockId)),
      )
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async listByDocument(
    workspaceId: string,
    document: DocumentArtifactRef,
  ): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(this.documentScope(workspaceId, document))
      .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
    return rows.map(rowToBinaryArtifact)
  }

  async listByDocuments(
    workspaceId: string,
    documents: readonly DocumentArtifactRef[],
  ): Promise<BinaryArtifactRecord[]> {
    const refs = dedupeDocumentRefs(documents)
    if (!refs.length) return []
    const rows: (typeof binaryArtifacts.$inferSelect)[] = []
    for (let i = 0; i < refs.length; i += 500) {
      const chunk = refs.slice(i, i + 500)
      const found = await this.db
        .select()
        .from(binaryArtifacts)
        .where(
          and(
            eq(binaryArtifacts.workspace_id, workspaceId),
            or(
              ...chunk.map((ref) =>
                and(
                  eq(binaryArtifacts.document_source, ref.source),
                  eq(binaryArtifacts.document_external_id, ref.externalId),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(binaryArtifacts.created_at), asc(binaryArtifacts.id))
      rows.push(...found)
    }
    // Re-sorted across chunks: each statement orders its own rows, and the caller's "newest
    // render for a view wins" rule reads the whole list in order.
    return rows
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(rowToBinaryArtifact)
  }

  async deleteByIds(workspaceId: string, ids: readonly string[]): Promise<number> {
    let removed = 0
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const deleted = await this.db
        .delete(binaryArtifacts)
        .where(
          and(
            eq(binaryArtifacts.workspace_id, workspaceId),
            inArray(binaryArtifacts.id, ids.slice(i, i + 500) as string[]),
          ),
        )
        .returning({ id: binaryArtifacts.id })
      removed += deleted.length
    }
    return removed
  }

  private documentScope(workspaceId: string, document: DocumentArtifactRef) {
    return and(
      eq(binaryArtifacts.workspace_id, workspaceId),
      eq(binaryArtifacts.document_source, document.source),
      eq(binaryArtifacts.document_external_id, document.externalId),
    )
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(binaryArtifacts)
      .where(and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.id, id)))
  }

  async listOlderThan(workspaceId: string, olderThan: number): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(this.agedScope(workspaceId, olderThan))
    return rows.map(rowToBinaryArtifact)
  }

  async deleteOlderThan(workspaceId: string, olderThan: number): Promise<number> {
    const deleted = await this.db
      .delete(binaryArtifacts)
      .where(this.agedScope(workspaceId, olderThan))
      .returning({ id: binaryArtifacts.id })
    return deleted.length
  }

  /**
   * The age sweep's scope, shared by its list and its delete so the two cannot drift: run debris
   * past the window, EXCLUDING a document's renders, which expire with their document rather than
   * on a clock (see the port).
   */
  private agedScope(workspaceId: string, olderThan: number) {
    return and(
      eq(binaryArtifacts.workspace_id, workspaceId),
      lt(binaryArtifacts.created_at, olderThan),
      isNull(binaryArtifacts.document_source),
    )
  }

  async listByWorkspace(workspaceId: string): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(eq(binaryArtifacts.workspace_id, workspaceId))
    return rows.map(rowToBinaryArtifact)
  }

  async deleteByWorkspace(workspaceId: string): Promise<number> {
    const deleted = await this.db
      .delete(binaryArtifacts)
      .where(eq(binaryArtifacts.workspace_id, workspaceId))
      .returning({ id: binaryArtifacts.id })
    return deleted.length
  }
}

function rowToProvisioningLog(row: typeof provisioningLog.$inferSelect): ProvisioningLogRecord {
  return {
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
  }
}

/** Drizzle/Postgres provisioning-log sink, in its own `provisioning` schema. */

export class DrizzleProvisioningLogRepository implements ProvisioningLogRepository {
  constructor(private readonly db: DrizzleDb) {}

  async append(record: ProvisioningLogRecord): Promise<void> {
    await this.db.insert(provisioningLog).values({
      id: record.id,
      workspace_id: record.workspaceId,
      subsystem: record.subsystem,
      operation: record.operation,
      target_id: record.targetId,
      provider_id: record.providerId,
      block_id: record.blockId,
      execution_id: record.executionId,
      outcome: record.outcome,
      error: record.error,
      detail: record.detail,
      created_at: record.createdAt,
    })
  }

  async list(
    workspaceId: string,
    query: ProvisioningLogQuery = {},
  ): Promise<ProvisioningLogRecord[]> {
    const conditions = [eq(provisioningLog.workspace_id, workspaceId)]
    if (query.subsystem) conditions.push(eq(provisioningLog.subsystem, query.subsystem))
    if (query.executionId) conditions.push(eq(provisioningLog.execution_id, query.executionId))
    if (query.targetId) conditions.push(eq(provisioningLog.target_id, query.targetId))
    if (query.cursor) {
      // Composite keyset matching the ORDER BY: provisioning attempts are appended in bursts,
      // so a `created_at`-only bound would silently drop rows sharing a millisecond.
      const { createdAt, id } = query.cursor
      conditions.push(
        or(
          lt(provisioningLog.created_at, createdAt),
          and(eq(provisioningLog.created_at, createdAt), lt(provisioningLog.id, id)),
        )!,
      )
    }
    const base = this.db
      .select()
      .from(provisioningLog)
      .where(and(...conditions))
      .orderBy(desc(provisioningLog.created_at), desc(provisioningLog.id))
    const rows = await (query.limit == null ? base : base.limit(query.limit))
    return rows.map(rowToProvisioningLog)
  }

  async countByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<{ total: number; failures: number }> {
    // Total + failures in ONE aggregate pass over the run's slice (see the port).
    const rows = await this.db
      .select({
        total: count(),
        failures: sql<number>`coalesce(sum(case when ${provisioningLog.outcome} = 'failure' then 1 else 0 end), 0)::int`,
      })
      .from(provisioningLog)
      .where(
        and(
          eq(provisioningLog.workspace_id, workspaceId),
          eq(provisioningLog.execution_id, executionId),
        ),
      )
    return { total: Number(rows[0]?.total ?? 0), failures: Number(rows[0]?.failures ?? 0) }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(provisioningLog)
      .where(lt(provisioningLog.created_at, epochMs))
      .returning({ id: provisioningLog.id })
    return deleted.length
  }
}
