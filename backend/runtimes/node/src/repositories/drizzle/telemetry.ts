// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import { parseJsonArray } from './_shared.js'
import type {
  AgentContextSnapshot,
  AgentContextSnapshotRepository,
  AgentSearchQuery,
  AgentSearchQueryRepository,
  BinaryArtifactMetadataStore,
  BinaryArtifactRecord,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmPromptChainTip,
  ProvisioningLogQuery,
  ProvisioningLogRecord,
  ProvisioningLogRepository,
  TokenUsageRecord,
  TokenUsageRepository,
  TokenUsageTotals,
  UsageBilling,
  UsageBreakdownRow,
} from '@cat-factory/kernel'
import { LLM_WARNING_FINISH_REASONS } from '@cat-factory/kernel'
import { isWebSearchProvider } from '@cat-factory/contracts'
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentContextSnapshots,
  agentSearchQueries,
  binaryArtifacts,
  llmCallMetrics,
  provisioningLog,
  tokenUsage,
} from '../../db/schema.js'

export class DrizzleTokenUsageRepository implements TokenUsageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(usage: TokenUsageRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: usage.id,
      workspace_id: usage.workspaceId,
      account_id: usage.accountId,
      user_id: usage.userId,
      execution_id: usage.executionId,
      agent_kind: usage.agentKind,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_estimate: usage.costEstimate,
      billing: usage.billing,
      vendor: usage.vendor,
      created_at: usage.createdAt,
    })
  }

  async usageBreakdownForWorkspace(
    workspaceId: string,
    epochMs: number,
  ): Promise<UsageBreakdownRow[]> {
    // One GROUP BY over the workspace's current period — both billing kinds (the report
    // shows total usage). Never a per-model loop. sum() of int columns is bigint; cast +
    // coerce like the totals rollups. Ordered heaviest-first in SQL, mirroring the D1 repo.
    const rows = await this.db
      .select({
        billing: tokenUsage.billing,
        vendor: tokenUsage.vendor,
        provider: tokenUsage.provider,
        model: tokenUsage.model,
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
        calls: sql<string>`count(*)::bigint`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.workspace_id, workspaceId), gte(tokenUsage.created_at, epochMs)))
      .groupBy(tokenUsage.billing, tokenUsage.vendor, tokenUsage.provider, tokenUsage.model)
      .orderBy(
        sql`(coalesce(sum(${tokenUsage.input_tokens}), 0) + coalesce(sum(${tokenUsage.output_tokens}), 0)) desc`,
      )
    return rows.map((r) => ({
      billing: (r.billing === 'subscription' ? 'subscription' : 'metered') as UsageBilling,
      vendor: r.vendor,
      provider: r.provider,
      model: r.model,
      inputTokens: Number(r.input ?? 0),
      outputTokens: Number(r.output ?? 0),
      costEstimate: r.cost ?? 0,
      calls: Number(r.calls ?? 0),
    }))
  }

  async totalsSince(epochMs: number): Promise<TokenUsageTotals> {
    // sum() of int columns is bigint in Postgres — cast to bigint (NOT int4, which
    // overflows past ~2.1B tokens) and coerce: node-postgres returns bigint as a
    // string to avoid precision loss, and token totals stay well within Number's
    // safe-integer range. Matches the 64-bit sum the D1/SQLite store returns.
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(and(gte(tokenUsage.created_at, epochMs), eq(tokenUsage.billing, 'metered')))
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForWorkspace(workspaceId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.workspace_id, workspaceId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForAccount(accountId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.account_id, accountId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async totalsSinceForUser(userId: string, epochMs: number): Promise<TokenUsageTotals> {
    const [row] = await this.db
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.input_tokens}), 0)::bigint`,
        output: sql<string>`coalesce(sum(${tokenUsage.output_tokens}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${tokenUsage.cost_estimate}), 0)::float8`,
      })
      .from(tokenUsage)
      .where(
        and(
          eq(tokenUsage.user_id, userId),
          gte(tokenUsage.created_at, epochMs),
          eq(tokenUsage.billing, 'metered'),
        ),
      )
    return {
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      costEstimate: row?.cost ?? 0,
    }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(tokenUsage)
      .where(lt(tokenUsage.created_at, epochMs))
      .returning({ id: tokenUsage.id })
    return deleted.length
  }
}

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
    messageCount: row.message_count,
    toolCount: row.tool_count,
    requestMaxTokens: row.request_max_tokens,
    promptTokens: row.prompt_tokens,
    cachedPromptTokens: row.cached_prompt_tokens,
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
      .values({
        id: metric.id,
        workspace_id: metric.workspaceId,
        execution_id: metric.executionId,
        agent_kind: metric.agentKind,
        provider: metric.provider,
        model: metric.model,
        created_at: metric.createdAt,
        streaming: metric.streaming ? 1 : 0,
        message_count: metric.messageCount,
        tool_count: metric.toolCount,
        request_max_tokens: metric.requestMaxTokens,
        prompt_tokens: metric.promptTokens,
        cached_prompt_tokens: metric.cachedPromptTokens,
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
      })
      .onConflictDoNothing({ target: llmCallMetrics.id })
  }

  async latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null> {
    // The newest call for the conversation; one indexed row, no text columns.
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

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    // Aggregate-only: selects no prompt/response text, so it stays cheap on every
    // execution emit (it backs the live board rollups). int sums fit Number's safe
    // range here (per-run call counts/tokens are small), so a plain ::bigint cast
    // matching the SQLite 64-bit sum is unnecessary — totals are coerced below.
    const reasons = [...LLM_WARNING_FINISH_REASONS]
    const rows = await this.db
      .select({
        agentKind: llmCallMetrics.agent_kind,
        calls: sql<number>`count(*)::int`,
        promptTokens: sql<number>`coalesce(sum(${llmCallMetrics.prompt_tokens}), 0)::int`,
        cachedPromptTokens: sql<number>`coalesce(sum(${llmCallMetrics.cached_prompt_tokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${llmCallMetrics.completion_tokens}), 0)::int`,
        peakCompletionTokens: sql<number>`coalesce(max(${llmCallMetrics.completion_tokens}), 0)::int`,
        maxOutputTokens: sql<number | null>`max(${llmCallMetrics.request_max_tokens})`,
        truncatedCalls: sql<number>`coalesce(sum(case when ${llmCallMetrics.finish_reason} = 'length' then 1 else 0 end), 0)::int`,
        upstreamMs: sql<number>`coalesce(sum(${llmCallMetrics.upstream_ms}), 0)::int`,
        overheadMs: sql<number>`coalesce(sum(${llmCallMetrics.overhead_ms}), 0)::int`,
        errors: sql<number>`coalesce(sum(case when ${llmCallMetrics.ok} = 0 then 1 else 0 end), 0)::int`,
        // `inArray` builds the IN-list membership: idiomatic, type-checked, and tied to
        // the shared constant. (A raw `${...finish_reason} in ${reasons}` renders the same
        // `in ($1, $2)` on this drizzle version; inArray just documents intent and can't
        // silently mis-bind the array.)
        warnings: sql<number>`coalesce(sum(case when ${llmCallMetrics.ok} = 1 and ${inArray(llmCallMetrics.finish_reason, reasons)} then 1 else 0 end), 0)::int`,
      })
      .from(llmCallMetrics)
      .where(
        and(
          eq(llmCallMetrics.workspace_id, workspaceId),
          eq(llmCallMetrics.execution_id, executionId),
        ),
      )
      .groupBy(llmCallMetrics.agent_kind)
    return rows.map((r) => ({
      agentKind: r.agentKind,
      calls: Number(r.calls),
      promptTokens: Number(r.promptTokens),
      cachedPromptTokens: Number(r.cachedPromptTokens),
      completionTokens: Number(r.completionTokens),
      peakCompletionTokens: Number(r.peakCompletionTokens),
      maxOutputTokens: r.maxOutputTokens == null ? null : Number(r.maxOutputTokens),
      truncatedCalls: Number(r.truncatedCalls),
      upstreamMs: Number(r.upstreamMs),
      overheadMs: Number(r.overheadMs),
      errors: Number(r.errors),
      warnings: Number(r.warnings),
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

export class DrizzleAgentContextSnapshotRepository implements AgentContextSnapshotRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(snapshot: AgentContextSnapshot): Promise<void> {
    await this.db.insert(agentContextSnapshots).values({
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
    })
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

export class DrizzleAgentSearchQueryRepository implements AgentSearchQueryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(query: AgentSearchQuery): Promise<void> {
    await this.db.insert(agentSearchQueries).values({
      id: query.id,
      workspace_id: query.workspaceId,
      execution_id: query.executionId,
      agent_kind: query.agentKind,
      provider: query.provider,
      query: query.query,
      result_count: query.resultCount,
      created_at: query.createdAt,
    })
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

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(agentSearchQueries)
      .where(lt(agentSearchQueries.created_at, epochMs))
      .returning({ id: agentSearchQueries.id })
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

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(binaryArtifacts)
      .where(and(eq(binaryArtifacts.workspace_id, workspaceId), eq(binaryArtifacts.id, id)))
  }

  async listOlderThan(workspaceId: string, olderThan: number): Promise<BinaryArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          lt(binaryArtifacts.created_at, olderThan),
        ),
      )
    return rows.map(rowToBinaryArtifact)
  }

  async deleteOlderThan(workspaceId: string, olderThan: number): Promise<number> {
    const deleted = await this.db
      .delete(binaryArtifacts)
      .where(
        and(
          eq(binaryArtifacts.workspace_id, workspaceId),
          lt(binaryArtifacts.created_at, olderThan),
        ),
      )
      .returning({ id: binaryArtifacts.id })
    return deleted.length
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
    if (query.before != null) conditions.push(lt(provisioningLog.created_at, query.before))
    const base = this.db
      .select()
      .from(provisioningLog)
      .where(and(...conditions))
      .orderBy(desc(provisioningLog.created_at), desc(provisioningLog.id))
    const rows = await (query.limit == null ? base : base.limit(query.limit))
    return rows.map(rowToProvisioningLog)
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const deleted = await this.db
      .delete(provisioningLog)
      .where(lt(provisioningLog.created_at, epochMs))
      .returning({ id: provisioningLog.id })
    return deleted.length
  }
}
