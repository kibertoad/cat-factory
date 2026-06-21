import type {
  AccountRecord,
  AccountRepository,
  AgentFailure,
  AgentRunKind,
  AgentRunRef,
  AgentRunRepository,
  Block,
  BlockPatch,
  BlockRepository,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  Membership,
  MembershipRepository,
  ModelDefaultsRepository,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmPromptChainTip,
  Pipeline,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  DueSchedule,
  Recurrence,
  RequirementReview,
  RequirementReviewItem,
  RequirementReviewRepository,
  RunRef,
  Service,
  ServicePatch,
  ServiceRepository,
  WorkspaceMount,
  WorkspaceMountPatch,
  WorkspaceMountRepository,
  ScheduleRun,
  ScheduleTemplate,
  TokenUsageRecord,
  TokenUsageRepository,
  TokenUsageTotals,
  TrackerSettings,
  TrackerSettingsRepository,
  Workspace,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import { LLM_WARNING_FINISH_REASONS } from '@cat-factory/kernel'
import {
  type ExecutionRow,
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
  rowToExecution,
  rowToPipeline,
  rowToWorkspace,
} from '@cat-factory/server'
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import {
  accounts,
  agentRuns,
  blocks,
  llmCallMetrics,
  memberships,
  pipelineScheduleRuns,
  pipelineSchedules,
  pipelines,
  requirementReviews,
  services,
  tokenUsage,
  trackerSettings,
  workspaceModelDefaults,
  workspaceServices,
  workspaces,
} from '../db/schema.js'

// Drizzle/Postgres implementations of the core kernel repository ports. The
// row<->domain mapping is the SAME shared mapping the Cloudflare D1 repos use
// (@cat-factory/server), so behaviour matches across stores; this layer only owns
// the Drizzle queries. This is the single persistence used in dev, test and prod.

class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listVisible(scope: WorkspaceVisibility): Promise<Workspace[]> {
    if (scope === null) {
      const rows = await this.db.select().from(workspaces).orderBy(desc(workspaces.created_at))
      return rows.map(rowToWorkspace)
    }
    const legacy = and(
      isNull(workspaces.account_id),
      eq(workspaces.owner_user_id, scope.ownerUserId),
    )
    const where =
      scope.accountIds.length > 0
        ? or(inArray(workspaces.account_id, scope.accountIds), legacy)
        : legacy
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(where)
      .orderBy(desc(workspaces.created_at))
    return rows.map(rowToWorkspace)
  }

  async get(id: string): Promise<Workspace | null> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id))
    return row ? rowToWorkspace(row) : null
  }

  async ownerOf(id: string): Promise<number | null | undefined> {
    const [row] = await this.db
      .select({ owner: workspaces.owner_user_id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
    return row ? row.owner : undefined
  }

  async accountOf(id: string): Promise<string | null | undefined> {
    const [row] = await this.db
      .select({ account: workspaces.account_id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
    return row ? row.account : undefined
  }

  async create(
    workspace: Workspace,
    ownerUserId: number | null,
    accountId: string | null,
  ): Promise<void> {
    await this.db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      created_at: workspace.createdAt,
      owner_user_id: ownerUserId,
      account_id: accountId,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(workspaces).set({ name }).where(eq(workspaces.id, id))
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(agentRuns).where(eq(agentRuns.workspace_id, id))
      await tx.delete(blocks).where(eq(blocks.workspace_id, id))
      await tx.delete(pipelines).where(eq(pipelines.workspace_id, id))
      await tx.delete(workspaces).where(eq(workspaces.id, id))
    })
  }
}

class DrizzleBlockRepository implements BlockRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<Block[]> {
    const rows = await this.db.select().from(blocks).where(eq(blocks.workspace_id, workspaceId))
    return rows.map(rowToBlock)
  }

  async listByService(serviceId: string): Promise<Block[]> {
    const rows = await this.db.select().from(blocks).where(eq(blocks.service_id, serviceId))
    return rows.map(rowToBlock)
  }

  async listByServices(serviceIds: string[]): Promise<Block[]> {
    if (serviceIds.length === 0) return []
    const out: Block[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(blocks)
        .where(inArray(blocks.service_id, serviceIds.slice(i, i + 500)))
      for (const row of rows) out.push(rowToBlock(row))
    }
    return out
  }

  async get(workspaceId: string, id: string): Promise<Block | null> {
    const [row] = await this.db
      .select()
      .from(blocks)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.id, id)))
    return row ? rowToBlock(row) : null
  }

  async findById(
    blockId: string,
  ): Promise<{ workspaceId: string; serviceId: string | null; block: Block } | null> {
    const [row] = await this.db.select().from(blocks).where(eq(blocks.id, blockId)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      serviceId: row.service_id ?? null,
      block: rowToBlock(row),
    }
  }

  async insert(workspaceId: string, block: Block, serviceId?: string | null): Promise<void> {
    await this.db.insert(blocks).values({
      workspace_id: workspaceId,
      service_id: serviceId ?? null,
      ...blockInsertValues(block),
    } as typeof blocks.$inferInsert)
  }

  async update(workspaceId: string, id: string, patch: BlockPatch): Promise<void> {
    const set = blockPatchToColumns(patch)
    if (Object.keys(set).length === 0) return
    await this.db
      .update(blocks)
      .set(set as Partial<typeof blocks.$inferInsert>)
      .where(and(eq(blocks.workspace_id, workspaceId), eq(blocks.id, id)))
  }

  async setService(workspaceId: string, ids: string[], serviceId: string | null): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .update(blocks)
      .set({ service_id: serviceId })
      .where(and(eq(blocks.workspace_id, workspaceId), inArray(blocks.id, ids)))
  }

  async deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .delete(blocks)
      .where(and(eq(blocks.workspace_id, workspaceId), inArray(blocks.id, ids)))
  }
}

class DrizzlePipelineRepository implements PipelineRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<Pipeline[]> {
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.workspace_id, workspaceId))
    return rows.map(rowToPipeline)
  }

  async get(workspaceId: string, id: string): Promise<Pipeline | null> {
    const [row] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, id)))
    return row ? rowToPipeline(row) : null
  }

  async insert(workspaceId: string, pipeline: Pipeline): Promise<void> {
    await this.db.insert(pipelines).values({
      workspace_id: workspaceId,
      id: pipeline.id,
      name: pipeline.name,
      agent_kinds: JSON.stringify(pipeline.agentKinds),
      gates: pipeline.gates ? JSON.stringify(pipeline.gates) : null,
      thresholds: pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
    })
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(pipelines)
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, id)))
  }
}

/** Execution runs live as `kind='execution'` rows of the unified agent_runs table. */
class DrizzleExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  private readonly isExecution = eq(agentRuns.kind, 'execution')

  async listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), this.isExecution))
      .orderBy(agentRuns.created_at)
    return rows.map((r) => rowToExecution(r as ExecutionRow))
  }

  async listByService(serviceId: string): Promise<ExecutionInstance[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.service_id, serviceId), this.isExecution))
      .orderBy(agentRuns.created_at)
    return rows.map((r) => rowToExecution(r as ExecutionRow))
  }

  async listByServices(serviceIds: string[]): Promise<ExecutionInstance[]> {
    if (serviceIds.length === 0) return []
    const out: ExecutionInstance[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(agentRuns)
        .where(and(inArray(agentRuns.service_id, serviceIds.slice(i, i + 500)), this.isExecution))
        .orderBy(agentRuns.created_at)
      for (const r of rows) out.push(rowToExecution(r as ExecutionRow))
    }
    return out
  }

  async get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id), this.isExecution))
    return row ? rowToExecution(row as ExecutionRow) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.block_id, blockId),
          this.isExecution,
        ),
      )
    return row ? rowToExecution(row as ExecutionRow) : null
  }

  async upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    const now = this.clock.now()
    const detail = JSON.stringify({
      pipelineId: execution.pipelineId,
      pipelineName: execution.pipelineName,
      steps: execution.steps,
      currentStep: execution.currentStep,
    })
    // Stamp `service_id` from the run's block (subquery) so a shared service's runs surface on
    // every board that mounts it via `listByService`; refreshed on every write so it follows a
    // reparent that re-homes the block. Mirrors the D1 repo.
    const serviceIdSub = sql`(SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${workspaceId} AND ${blocks.id} = ${execution.blockId})`
    await this.db
      .insert(agentRuns)
      .values({
        workspace_id: workspaceId,
        id: execution.id,
        kind: 'execution',
        block_id: execution.blockId,
        status: execution.status,
        detail,
        created_at: now,
        updated_at: now,
        workflow_instance_id: execution.id,
        service_id: serviceIdSub,
      })
      // error/failure/workflow_instance_id are left out of the update so they survive
      // normal step writes (see markFailed) — mirrors the D1 repo.
      .onConflictDoUpdate({
        target: [agentRuns.workspace_id, agentRuns.id],
        set: {
          block_id: execution.blockId,
          status: execution.status,
          detail,
          updated_at: now,
          service_id: serviceIdSub,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.block_id, blockId),
          this.isExecution,
        ),
      )
  }

  async listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const rows = await this.db
      .select({ workspaceId: agentRuns.workspace_id, id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          this.isExecution,
          eq(agentRuns.status, 'running'),
          lt(agentRuns.updated_at, olderThanEpochMs),
        ),
      )
      .orderBy(agentRuns.updated_at)
    return rows
  }

  async markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: 'failed',
        error: failure.message,
        failure: JSON.stringify(failure),
        updated_at: this.clock.now(),
      })
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id), this.isExecution))
  }
}

class DrizzleAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getRef(workspaceId: string, id: string): Promise<AgentRunRef | null> {
    const [row] = await this.db
      .select({ kind: agentRuns.kind })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id)))
    return row ? { workspaceId, id, kind: row.kind as AgentRunKind } : null
  }

  async listStale(olderThanEpochMs: number): Promise<AgentRunRef[]> {
    const rows = await this.db
      .select({ workspaceId: agentRuns.workspace_id, id: agentRuns.id, kind: agentRuns.kind })
      .from(agentRuns)
      .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.updated_at, olderThanEpochMs)))
      .orderBy(agentRuns.updated_at)
    return rows.map((r) => ({ workspaceId: r.workspaceId, id: r.id, kind: r.kind as AgentRunKind }))
  }
}

function rowToAccount(row: typeof accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    type: row.type === 'org' ? 'org' : 'personal',
    name: row.name,
    githubAccountLogin: row.github_account_login,
    createdAt: row.created_at,
  }
}

class DrizzleAccountRepository implements AccountRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<AccountRecord | null> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id))
    return row ? rowToAccount(row) : null
  }

  async create(account: AccountRecord): Promise<void> {
    await this.db.insert(accounts).values({
      id: account.id,
      type: account.type,
      name: account.name,
      github_account_login: account.githubAccountLogin,
      created_at: account.createdAt,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(accounts).set({ name }).where(eq(accounts.id, id))
  }

  async findPersonalByLogin(login: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.type, 'personal'), eq(accounts.github_account_login, login)))
    return row ? rowToAccount(row) : null
  }
}

function rowToMembership(row: typeof memberships.$inferSelect): Membership {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.created_at,
  }
}

class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUser(userId: number): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.user_id, userId))
      .orderBy(memberships.created_at)
    return rows.map(rowToMembership)
  }

  async listByAccount(accountId: string): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(eq(memberships.account_id, accountId))
      .orderBy(memberships.created_at)
    return rows.map(rowToMembership)
  }

  async get(accountId: string, userId: number): Promise<Membership | null> {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)))
    return row ? rowToMembership(row) : null
  }

  async upsert(membership: Membership): Promise<void> {
    await this.db
      .insert(memberships)
      .values({
        account_id: membership.accountId,
        user_id: membership.userId,
        role: membership.role,
        created_at: membership.createdAt,
      })
      .onConflictDoUpdate({
        target: [memberships.account_id, memberships.user_id],
        set: { role: membership.role },
      })
  }

  async remove(accountId: string, userId: number): Promise<void> {
    await this.db
      .delete(memberships)
      .where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)))
  }
}

class DrizzleTokenUsageRepository implements TokenUsageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(usage: TokenUsageRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: usage.id,
      workspace_id: usage.workspaceId,
      execution_id: usage.executionId,
      agent_kind: usage.agentKind,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_estimate: usage.costEstimate,
      created_at: usage.createdAt,
    })
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
      .where(gte(tokenUsage.created_at, epochMs))
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
  }
}

class DrizzleLlmCallMetricRepository implements LlmCallMetricRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(metric: LlmCallMetric): Promise<void> {
    await this.db.insert(llmCallMetrics).values({
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
    })
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
  ): Promise<LlmCallMetric[]> {
    const base = this.db
      .select()
      .from(llmCallMetrics)
      .where(
        and(
          eq(llmCallMetrics.workspace_id, workspaceId),
          eq(llmCallMetrics.execution_id, executionId),
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

/**
 * A workspace's per-agent-kind default models, one row per (workspace, agent kind)
 * in `workspace_model_defaults`. `replace` rewrites the whole map for a workspace
 * in a transaction (delete-all then insert-each), so a kind omitted is cleared.
 */
class DrizzleModelDefaultsRepository implements ModelDefaultsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        agentKind: workspaceModelDefaults.agent_kind,
        modelId: workspaceModelDefaults.model_id,
      })
      .from(workspaceModelDefaults)
      .where(eq(workspaceModelDefaults.workspace_id, workspaceId))
    const map: Record<string, string> = {}
    for (const row of rows) map[row.agentKind] = row.modelId
    return map
  }

  async getForKind(workspaceId: string, agentKind: string): Promise<string | null> {
    const [row] = await this.db
      .select({ modelId: workspaceModelDefaults.model_id })
      .from(workspaceModelDefaults)
      .where(
        and(
          eq(workspaceModelDefaults.workspace_id, workspaceId),
          eq(workspaceModelDefaults.agent_kind, agentKind),
        ),
      )
    return row ? row.modelId : null
  }

  async replace(workspaceId: string, defaults: Record<string, string>): Promise<void> {
    const updatedAt = Date.now()
    const values = Object.entries(defaults).map(([agentKind, modelId]) => ({
      workspace_id: workspaceId,
      agent_kind: agentKind,
      model_id: modelId,
      updated_at: updatedAt,
    }))
    // Rewrite the whole per-kind map atomically: clear the workspace's rows, then
    // insert one per entry, so a reader never sees a partial map.
    await this.db.transaction(async (tx) => {
      await tx
        .delete(workspaceModelDefaults)
        .where(eq(workspaceModelDefaults.workspace_id, workspaceId))
      if (values.length > 0) await tx.insert(workspaceModelDefaults).values(values)
    })
  }
}

type ScheduleRow = typeof pipelineSchedules.$inferSelect
type RunRow = typeof pipelineScheduleRuns.$inferSelect

function rowToSchedule(row: ScheduleRow): PipelineSchedule {
  const recurrence: Recurrence = {
    intervalHours: row.interval_hours,
    weekdays: safeWeekdays(row.weekdays),
    windowStartHour: row.window_start_hour,
    windowEndHour: row.window_end_hour,
    timezone: row.timezone,
  }
  return {
    id: row.id,
    serviceId: row.service_id,
    blockId: row.block_id,
    frameId: row.frame_id,
    pipelineId: row.pipeline_id,
    template: row.template as ScheduleTemplate,
    name: row.name,
    recurrence,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  }
}

function safeWeekdays(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

function rowToRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    executionId: row.execution_id,
    status: row.status as ScheduleRun['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
  }
}

class DrizzlePipelineScheduleRepository implements PipelineScheduleRepository {
  constructor(private readonly db: DrizzleDb) {}

  private values(workspaceId: string, schedule: PipelineSchedule) {
    const r = schedule.recurrence
    return {
      workspace_id: workspaceId,
      id: schedule.id,
      service_id: schedule.serviceId,
      block_id: schedule.blockId,
      frame_id: schedule.frameId,
      pipeline_id: schedule.pipelineId,
      template: schedule.template,
      name: schedule.name,
      interval_hours: r.intervalHours,
      weekdays: JSON.stringify(r.weekdays),
      window_start_hour: r.windowStartHour,
      window_end_hour: r.windowEndHour,
      timezone: r.timezone,
      enabled: schedule.enabled ? 1 : 0,
      last_run_at: schedule.lastRunAt,
      next_run_at: schedule.nextRunAt,
      created_at: schedule.createdAt,
    }
  }

  async get(workspaceId: string, id: string): Promise<PipelineSchedule | null> {
    const [row] = await this.db
      .select()
      .from(pipelineSchedules)
      .where(and(eq(pipelineSchedules.workspace_id, workspaceId), eq(pipelineSchedules.id, id)))
    return row ? rowToSchedule(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<PipelineSchedule | null> {
    const [row] = await this.db
      .select()
      .from(pipelineSchedules)
      .where(
        and(
          eq(pipelineSchedules.workspace_id, workspaceId),
          eq(pipelineSchedules.block_id, blockId),
        ),
      )
    return row ? rowToSchedule(row) : null
  }

  async list(workspaceId: string): Promise<PipelineSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(eq(pipelineSchedules.workspace_id, workspaceId))
      .orderBy(pipelineSchedules.created_at)
    return rows.map(rowToSchedule)
  }

  async listByService(serviceId: string): Promise<PipelineSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(eq(pipelineSchedules.service_id, serviceId))
      .orderBy(pipelineSchedules.created_at)
    return rows.map(rowToSchedule)
  }

  async listByServices(serviceIds: string[]): Promise<PipelineSchedule[]> {
    if (serviceIds.length === 0) return []
    const out: PipelineSchedule[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(pipelineSchedules)
        .where(inArray(pipelineSchedules.service_id, serviceIds.slice(i, i + 500)))
        .orderBy(pipelineSchedules.created_at)
      for (const row of rows) out.push(rowToSchedule(row))
    }
    return out
  }

  async listDue(asOf: number): Promise<DueSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(and(eq(pipelineSchedules.enabled, 1), lt(pipelineSchedules.next_run_at, asOf + 1)))
      .orderBy(pipelineSchedules.next_run_at)
    return rows.map((row) => ({ workspaceId: row.workspace_id, schedule: rowToSchedule(row) }))
  }

  async upsert(workspaceId: string, schedule: PipelineSchedule): Promise<void> {
    const values = this.values(workspaceId, schedule)
    await this.db
      .insert(pipelineSchedules)
      .values(values)
      .onConflictDoUpdate({
        target: [pipelineSchedules.workspace_id, pipelineSchedules.id],
        set: {
          service_id: values.service_id,
          block_id: values.block_id,
          frame_id: values.frame_id,
          pipeline_id: values.pipeline_id,
          template: values.template,
          name: values.name,
          interval_hours: values.interval_hours,
          weekdays: values.weekdays,
          window_start_hour: values.window_start_hour,
          window_end_hour: values.window_end_hour,
          timezone: values.timezone,
          enabled: values.enabled,
          last_run_at: values.last_run_at,
          next_run_at: values.next_run_at,
        },
      })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(pipelineSchedules)
      .where(and(eq(pipelineSchedules.workspace_id, workspaceId), eq(pipelineSchedules.id, id)))
  }

  async insertRun(workspaceId: string, run: ScheduleRun): Promise<void> {
    await this.db.insert(pipelineScheduleRuns).values({
      workspace_id: workspaceId,
      id: run.id,
      schedule_id: run.scheduleId,
      execution_id: run.executionId,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      outcome: run.outcome,
    })
  }

  async updateRun(
    workspaceId: string,
    runId: string,
    patch: Partial<Pick<ScheduleRun, 'status' | 'finishedAt' | 'outcome' | 'executionId'>>,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.status !== undefined) set.status = patch.status
    if (patch.finishedAt !== undefined) set.finished_at = patch.finishedAt
    if (patch.outcome !== undefined) set.outcome = patch.outcome
    if (patch.executionId !== undefined) set.execution_id = patch.executionId
    if (Object.keys(set).length === 0) return
    await this.db
      .update(pipelineScheduleRuns)
      .set(set)
      .where(
        and(eq(pipelineScheduleRuns.workspace_id, workspaceId), eq(pipelineScheduleRuns.id, runId)),
      )
  }

  async listRuns(workspaceId: string, scheduleId: string): Promise<ScheduleRun[]> {
    const rows = await this.db
      .select()
      .from(pipelineScheduleRuns)
      .where(
        and(
          eq(pipelineScheduleRuns.workspace_id, workspaceId),
          eq(pipelineScheduleRuns.schedule_id, scheduleId),
        ),
      )
      .orderBy(desc(pipelineScheduleRuns.started_at))
    return rows.map(rowToRun)
  }

  async pruneRunsBefore(before: number): Promise<number> {
    const rows = await this.db
      .delete(pipelineScheduleRuns)
      .where(lt(pipelineScheduleRuns.started_at, before))
      .returning({ id: pipelineScheduleRuns.id })
    return rows.length
  }
}

class DrizzleTrackerSettingsRepository implements TrackerSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<TrackerSettings | null> {
    const [row] = await this.db
      .select()
      .from(trackerSettings)
      .where(eq(trackerSettings.workspace_id, workspaceId))
    if (!row) return null
    return {
      tracker: (row.tracker as TrackerSettings['tracker']) ?? null,
      jiraProjectKey: row.jira_project_key,
      updatedAt: row.updated_at,
    }
  }

  async put(workspaceId: string, settings: TrackerSettings): Promise<void> {
    await this.db
      .insert(trackerSettings)
      .values({
        workspace_id: workspaceId,
        tracker: settings.tracker,
        jira_project_key: settings.jiraProjectKey,
        updated_at: settings.updatedAt,
      })
      .onConflictDoUpdate({
        target: trackerSettings.workspace_id,
        set: {
          tracker: settings.tracker,
          jira_project_key: settings.jiraProjectKey,
          updated_at: settings.updatedAt,
        },
      })
  }
}

function rowToService(row: typeof services.$inferSelect): Service {
  return {
    id: row.id,
    accountId: row.account_id,
    frameBlockId: row.frame_block_id,
    installationId: row.installation_id,
    repoGithubId: row.repo_github_id,
    directory: row.directory,
    createdAt: row.created_at,
  }
}

/** Account-owned services (migration 0030). The canonical, shareable board unit. */
class DrizzleServiceRepository implements ServiceRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<Service | null> {
    const [row] = await this.db.select().from(services).where(eq(services.id, id))
    return row ? rowToService(row) : null
  }

  async getByFrameBlock(frameBlockId: string): Promise<Service | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(eq(services.frame_block_id, frameBlockId))
    return row ? rowToService(row) : null
  }

  async listByAccount(accountId: string | null): Promise<Service[]> {
    // NULL-safe match so the legacy/unscoped org (accountId null) lists cleanly.
    const rows = await this.db
      .select()
      .from(services)
      .where(sql`${services.account_id} IS NOT DISTINCT FROM ${accountId}`)
      .orderBy(services.created_at)
    return rows.map(rowToService)
  }

  async listByIds(ids: string[]): Promise<Service[]> {
    if (ids.length === 0) return []
    const out: Service[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select()
        .from(services)
        .where(inArray(services.id, ids.slice(i, i + 500)))
      for (const row of rows) out.push(rowToService(row))
    }
    return out
  }

  async getByRepo(installationId: number, repoGithubId: number): Promise<Service | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(
        and(
          eq(services.installation_id, installationId),
          eq(services.repo_github_id, repoGithubId),
        ),
      )
    return row ? rowToService(row) : null
  }

  async insert(service: Service): Promise<void> {
    await this.db.insert(services).values({
      id: service.id,
      account_id: service.accountId,
      frame_block_id: service.frameBlockId,
      installation_id: service.installationId,
      repo_github_id: service.repoGithubId,
      directory: service.directory ?? null,
      created_at: service.createdAt,
    })
  }

  async update(id: string, patch: ServicePatch): Promise<void> {
    const set: Record<string, unknown> = {}
    if ('accountId' in patch) set.account_id = patch.accountId ?? null
    if ('installationId' in patch) set.installation_id = patch.installationId ?? null
    if ('repoGithubId' in patch) set.repo_github_id = patch.repoGithubId ?? null
    if ('directory' in patch) set.directory = patch.directory ?? null
    if (Object.keys(set).length === 0) return
    await this.db.update(services).set(set).where(eq(services.id, id))
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(services).where(eq(services.id, id))
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      await this.db.delete(services).where(inArray(services.id, ids.slice(i, i + 500)))
    }
  }
}

function rowToMount(row: typeof workspaceServices.$inferSelect): WorkspaceMount {
  return {
    workspaceId: row.workspace_id,
    serviceId: row.service_id,
    position: { x: row.pos_x, y: row.pos_y },
    size: row.width !== null && row.height !== null ? { w: row.width, h: row.height } : null,
    createdAt: row.created_at,
  }
}

/** A service mounted onto a workspace board + its per-workspace layout (migration 0030). */
class DrizzleWorkspaceMountRepository implements WorkspaceMountRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]> {
    const rows = await this.db
      .select()
      .from(workspaceServices)
      .where(eq(workspaceServices.workspace_id, workspaceId))
      .orderBy(workspaceServices.created_at)
    return rows.map(rowToMount)
  }

  async listByService(serviceId: string): Promise<WorkspaceMount[]> {
    const rows = await this.db
      .select()
      .from(workspaceServices)
      .where(eq(workspaceServices.service_id, serviceId))
      .orderBy(workspaceServices.created_at)
    return rows.map(rowToMount)
  }

  async listWorkspaceIdsMountingBlock(
    originWorkspaceId: string,
    blockId: string,
  ): Promise<string[]> {
    // One join: the service owning the block → the workspaces that mount it. A block with no
    // service makes the subquery NULL, which matches no rows (`service_id = NULL`) → empty.
    const rows = await this.db
      .select({ workspaceId: workspaceServices.workspace_id })
      .from(workspaceServices)
      .where(
        sql`${workspaceServices.service_id} = (SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${originWorkspaceId} AND ${blocks.id} = ${blockId})`,
      )
    return rows.map((r) => r.workspaceId)
  }

  async countByServiceIds(serviceIds: string[]): Promise<Record<string, number>> {
    if (serviceIds.length === 0) return {}
    const rows = await this.db
      .select({ serviceId: workspaceServices.service_id, n: sql<number>`count(*)` })
      .from(workspaceServices)
      .where(inArray(workspaceServices.service_id, serviceIds))
      .groupBy(workspaceServices.service_id)
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.serviceId] = Number(row.n)
    return counts
  }

  async get(workspaceId: string, serviceId: string): Promise<WorkspaceMount | null> {
    const [row] = await this.db
      .select()
      .from(workspaceServices)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
    return row ? rowToMount(row) : null
  }

  async upsert(mount: WorkspaceMount): Promise<void> {
    await this.db
      .insert(workspaceServices)
      .values({
        workspace_id: mount.workspaceId,
        service_id: mount.serviceId,
        pos_x: mount.position.x,
        pos_y: mount.position.y,
        width: mount.size?.w ?? null,
        height: mount.size?.h ?? null,
        created_at: mount.createdAt,
      })
      .onConflictDoUpdate({
        target: [workspaceServices.workspace_id, workspaceServices.service_id],
        set: {
          pos_x: mount.position.x,
          pos_y: mount.position.y,
          width: mount.size?.w ?? null,
          height: mount.size?.h ?? null,
        },
      })
  }

  async update(workspaceId: string, serviceId: string, patch: WorkspaceMountPatch): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.position) {
      set.pos_x = patch.position.x
      set.pos_y = patch.position.y
    }
    if ('size' in patch) {
      set.width = patch.size?.w ?? null
      set.height = patch.size?.h ?? null
    }
    if (Object.keys(set).length === 0) return
    await this.db
      .update(workspaceServices)
      .set(set)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
  }

  async remove(workspaceId: string, serviceId: string): Promise<void> {
    await this.db
      .delete(workspaceServices)
      .where(
        and(
          eq(workspaceServices.workspace_id, workspaceId),
          eq(workspaceServices.service_id, serviceId),
        ),
      )
  }

  async removeByServices(serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) return
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      await this.db
        .delete(workspaceServices)
        .where(inArray(workspaceServices.service_id, serviceIds.slice(i, i + 500)))
    }
  }
}

type RequirementReviewRow = typeof requirementReviews.$inferSelect

function rowToRequirementReview(row: RequirementReviewRow): RequirementReview {
  let items: RequirementReviewItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as RequirementReviewItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as RequirementReview['status'],
    items,
    model: row.model,
    incorporatedRequirements: row.incorporated_requirements,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Requirements reviews over Postgres (the Drizzle mirror of the Worker's
 * `D1RequirementReviewRepository`, migration 0021). The reviewed items live as a JSON
 * array in `items`; the service keeps at most one live review per block (it deletes
 * the block's prior review before inserting a fresh one), so `getByBlock` returns the
 * latest. Behaviourally identical to the D1 repo so the cross-runtime conformance
 * suite asserts the same requirements-rework substitution against both stores.
 */
export class DrizzleRequirementReviewRepository implements RequirementReviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null> {
    const rows = await this.db
      .select()
      .from(requirementReviews)
      .where(
        and(
          eq(requirementReviews.workspace_id, workspaceId),
          eq(requirementReviews.block_id, blockId),
        ),
      )
      .orderBy(desc(requirementReviews.created_at))
      .limit(1)
    return rows[0] ? rowToRequirementReview(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<RequirementReview | null> {
    const rows = await this.db
      .select()
      .from(requirementReviews)
      .where(and(eq(requirementReviews.workspace_id, workspaceId), eq(requirementReviews.id, id)))
      .limit(1)
    return rows[0] ? rowToRequirementReview(rows[0]) : null
  }

  async upsert(workspaceId: string, review: RequirementReview): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: review.id,
      block_id: review.blockId,
      status: review.status,
      items: JSON.stringify(review.items),
      model: review.model,
      incorporated_requirements: review.incorporatedRequirements,
      created_at: review.createdAt,
      updated_at: review.updatedAt,
    }
    await this.db
      .insert(requirementReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [requirementReviews.workspace_id, requirementReviews.id],
        set: {
          block_id: values.block_id,
          status: values.status,
          items: values.items,
          model: values.model,
          incorporated_requirements: values.incorporated_requirements,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(requirementReviews)
      .where(
        and(
          eq(requirementReviews.workspace_id, workspaceId),
          eq(requirementReviews.block_id, blockId),
        ),
      )
  }
}

export interface CoreRepositories {
  workspaceRepository: WorkspaceRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  tokenUsageRepository: TokenUsageRepository
  llmCallMetricRepository: LlmCallMetricRepository
  agentRunRepository: AgentRunRepository
  modelDefaultsRepository: ModelDefaultsRepository
  pipelineScheduleRepository: PipelineScheduleRepository
  trackerSettingsRepository: TrackerSettingsRepository
  serviceRepository: ServiceRepository
  workspaceMountRepository: WorkspaceMountRepository
  requirementReviewRepository: RequirementReviewRepository
}

/** Build the Drizzle/Postgres-backed core repositories. */
export function createDrizzleRepositories(db: DrizzleDb, clock: Clock): CoreRepositories {
  return {
    workspaceRepository: new DrizzleWorkspaceRepository(db),
    accountRepository: new DrizzleAccountRepository(db),
    membershipRepository: new DrizzleMembershipRepository(db),
    blockRepository: new DrizzleBlockRepository(db),
    pipelineRepository: new DrizzlePipelineRepository(db),
    executionRepository: new DrizzleExecutionRepository(db, clock),
    tokenUsageRepository: new DrizzleTokenUsageRepository(db),
    llmCallMetricRepository: new DrizzleLlmCallMetricRepository(db),
    agentRunRepository: new DrizzleAgentRunRepository(db),
    modelDefaultsRepository: new DrizzleModelDefaultsRepository(db),
    pipelineScheduleRepository: new DrizzlePipelineScheduleRepository(db),
    trackerSettingsRepository: new DrizzleTrackerSettingsRepository(db),
    serviceRepository: new DrizzleServiceRepository(db),
    workspaceMountRepository: new DrizzleWorkspaceMountRepository(db),
    requirementReviewRepository: new DrizzleRequirementReviewRepository(db),
  }
}
