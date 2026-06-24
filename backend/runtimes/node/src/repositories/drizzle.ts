import type {
  AccountInvitationRecord,
  AccountInvitationRepository,
  AccountRecord,
  AccountRepository,
  AccountRole,
  AccountSettingsPatch,
  AgentFailure,
  EmailConnectionRecord,
  EmailConnectionRepository,
  EmailProviderKind,
  AgentRunKind,
  CloudProvider,
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
  MergePresetRepository,
  MergeThresholdPreset,
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  ObservabilityProviderKind,
  ReleaseHealthConfigRecord,
  ReleaseHealthConfigRepository,
  ModelDefaultsRepository,
  ServiceFragmentDefaultsRepository,
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
  ConsensusSession,
  ConsensusSessionRepository,
  RequirementReview,
  RequirementReviewItem,
  RequirementReviewRepository,
  ClarityReview,
  ClarityReviewItem,
  ClarityReviewRepository,
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
  UserIdentityRecord,
  UserRecord,
  UserRepository,
  IdentityProvider,
  Workspace,
  WorkspaceRepository,
  WorkspaceVisibility,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { LLM_WARNING_FINISH_REASONS } from '@cat-factory/kernel'
import {
  type ExecutionRow,
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
  rowToExecution,
  executionToDetail,
  rowToPipeline,
  rowToWorkspace,
} from '@cat-factory/server'
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import {
  accountInvitations,
  accounts,
  agentRuns,
  blocks,
  consensusSessions,
  observabilityConnections,
  emailConnections,
  llmCallMetrics,
  memberships,
  mergeThresholdPresets,
  releaseHealthConfigs,
  pipelineScheduleRuns,
  pipelineSchedules,
  pipelines,
  requirementReviews,
  clarityReviews,
  services,
  tokenUsage,
  trackerSettings,
  userIdentities,
  users,
  workspaceFragmentDefaults,
  workspaceModelDefaults,
  workspaceServices,
  workspaceSettings,
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

  async ownerOf(id: string): Promise<string | null | undefined> {
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
    ownerUserId: string | null,
    accountId: string | null,
  ): Promise<void> {
    await this.db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      created_at: workspace.createdAt,
      owner_user_id: ownerUserId,
      account_id: accountId,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(workspaces).set({ name }).where(eq(workspaces.id, id))
  }

  async setDescription(id: string, description: string | null): Promise<void> {
    await this.db.update(workspaces).set({ description }).where(eq(workspaces.id, id))
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
      // Order by the monotonic insert `seq` so the catalog comes back in the curated
      // `seedPipelines()` order it was inserted in (Postgres gives no row order without
      // ORDER BY) — deterministic snapshots, a stable default `pipelines[0]`, and parity
      // with the Cloudflare facade's `ORDER BY rowid`.
      .orderBy(pipelines.seq)
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
      enabled: pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
      consensus: pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
      gating: pipeline.gating ? JSON.stringify(pipeline.gating) : null,
      labels: pipeline.labels ? JSON.stringify(pipeline.labels) : null,
      archived: pipeline.archived ? 1 : null,
      builtin: pipeline.builtin ? 1 : null,
    })
  }

  async update(workspaceId: string, pipeline: Pipeline): Promise<void> {
    // UPDATE in place preserves the row's `seq`, so an edited pipeline keeps its place
    // in the catalog order. `builtin` is immutable, so it is not rewritten.
    await this.db
      .update(pipelines)
      .set({
        name: pipeline.name,
        agent_kinds: JSON.stringify(pipeline.agentKinds),
        gates: pipeline.gates ? JSON.stringify(pipeline.gates) : null,
        thresholds: pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
        enabled: pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
        consensus: pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
        gating: pipeline.gating ? JSON.stringify(pipeline.gating) : null,
        labels: pipeline.labels ? JSON.stringify(pipeline.labels) : null,
        archived: pipeline.archived ? 1 : null,
      })
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, pipeline.id)))
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
    const detail = executionToDetail(execution)
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
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    ...(row.default_cloud_provider
      ? { defaultCloudProvider: row.default_cloud_provider as CloudProvider }
      : {}),
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
      owner_user_id: account.ownerUserId,
      created_at: account.createdAt,
      default_cloud_provider: account.defaultCloudProvider ?? null,
    })
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(accounts).set({ name }).where(eq(accounts.id, id))
  }

  async updateSettings(id: string, patch: AccountSettingsPatch): Promise<void> {
    if (!('defaultCloudProvider' in patch)) return
    await this.db
      .update(accounts)
      .set({ default_cloud_provider: patch.defaultCloudProvider ?? null })
      .where(eq(accounts.id, id))
  }

  async findPersonalByUser(userId: string): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.type, 'personal'), eq(accounts.owner_user_id, userId)))
    return row ? rowToAccount(row) : null
  }
}

/** Parse the CSV `roles` column into a non-empty role set (defaults to developer). */
function parseRoles(csv: string | null): AccountRole[] {
  const roles = (csv ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AccountRole => r === 'admin' || r === 'developer' || r === 'product')
  return roles.length > 0 ? [...new Set(roles)] : ['developer']
}

function rowToMembership(row: typeof memberships.$inferSelect): Membership {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    roles: parseRoles(row.roles),
    createdAt: row.created_at,
  }
}

class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUser(userId: string): Promise<Membership[]> {
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

  async get(accountId: string, userId: string): Promise<Membership | null> {
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
        roles: membership.roles.join(','),
        created_at: membership.createdAt,
      })
      .onConflictDoUpdate({
        target: [memberships.account_id, memberships.user_id],
        set: { roles: membership.roles.join(',') },
      })
  }

  async remove(accountId: string, userId: string): Promise<void> {
    await this.db
      .delete(memberships)
      .where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)))
  }
}

function rowToUser(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  }
}

function rowToIdentity(row: typeof userIdentities.$inferSelect): UserIdentityRecord {
  return {
    userId: row.user_id,
    provider: row.provider as IdentityProvider,
    subject: row.subject,
    secret: row.secret,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id))
    return row ? rowToUser(row) : null
  }

  async create(user: UserRecord): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar_url: user.avatarUrl,
      created_at: user.createdAt,
    })
  }

  async update(
    id: string,
    patch: Partial<Pick<UserRecord, 'name' | 'email' | 'avatarUrl'>>,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if ('name' in patch) set.name = patch.name
    if ('email' in patch) set.email = patch.email
    if ('avatarUrl' in patch) set.avatar_url = patch.avatarUrl
    if (Object.keys(set).length === 0) return
    await this.db.update(users).set(set).where(eq(users.id, id))
  }

  async findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .innerJoin(userIdentities, eq(userIdentities.user_id, users.id))
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    return row ? rowToUser(row.users) : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
    return row ? rowToUser(row) : null
  }

  async listByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return []
    const rows = await this.db.select().from(users).where(inArray(users.id, ids))
    return rows.map(rowToUser)
  }

  async getIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<UserIdentityRecord | null> {
    const [row] = await this.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    return row ? rowToIdentity(row) : null
  }

  async linkIdentity(identity: UserIdentityRecord): Promise<void> {
    await this.db
      .insert(userIdentities)
      .values({
        user_id: identity.userId,
        provider: identity.provider,
        subject: identity.subject,
        secret: identity.secret,
        metadata: identity.metadata,
        created_at: identity.createdAt,
      })
      .onConflictDoUpdate({
        target: [userIdentities.provider, userIdentities.subject],
        set: { user_id: identity.userId, secret: identity.secret, metadata: identity.metadata },
      })
  }

  async listIdentities(userId: string): Promise<UserIdentityRecord[]> {
    const rows = await this.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, userId))
    return rows.map(rowToIdentity)
  }
}

function rowToInvitation(row: typeof accountInvitations.$inferSelect): AccountInvitationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    roles: parseRoles(row.roles),
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    status: row.status as AccountInvitationRecord['status'],
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

class DrizzleAccountInvitationRepository implements AccountInvitationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(record: AccountInvitationRecord): Promise<void> {
    await this.db.insert(accountInvitations).values({
      id: record.id,
      account_id: record.accountId,
      email: record.email,
      roles: record.roles.join(','),
      token_hash: record.tokenHash,
      invited_by: record.invitedBy,
      status: record.status,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    })
  }

  async get(id: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.id, id))
    return row ? rowToInvitation(row) : null
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    const [row] = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.token_hash, tokenHash))
    return row ? rowToInvitation(row) : null
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    const rows = await this.db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.account_id, accountId))
      .orderBy(desc(accountInvitations.created_at))
    return rows.map(rowToInvitation)
  }

  async setStatus(id: string, status: AccountInvitationRecord['status']): Promise<void> {
    await this.db.update(accountInvitations).set({ status }).where(eq(accountInvitations.id, id))
  }
}

function rowToEmailConnection(row: typeof emailConnections.$inferSelect): EmailConnectionRecord {
  return {
    accountId: row.account_id,
    provider: row.provider as EmailProviderKind,
    fromAddress: row.from_address,
    apiKeyCipher: row.api_key_cipher,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

class DrizzleEmailConnectionRepository implements EmailConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByAccount(accountId: string): Promise<EmailConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(emailConnections)
      .where(and(eq(emailConnections.account_id, accountId), isNull(emailConnections.deleted_at)))
    return row ? rowToEmailConnection(row) : null
  }

  async upsert(record: EmailConnectionRecord): Promise<void> {
    await this.db
      .insert(emailConnections)
      .values({
        account_id: record.accountId,
        provider: record.provider,
        from_address: record.fromAddress,
        api_key_cipher: record.apiKeyCipher,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        deleted_at: record.deletedAt,
      })
      .onConflictDoUpdate({
        target: emailConnections.account_id,
        set: {
          provider: record.provider,
          from_address: record.fromAddress,
          api_key_cipher: record.apiKeyCipher,
          updated_at: record.updatedAt,
          deleted_at: record.deletedAt,
        },
      })
  }

  async softDelete(accountId: string, at: number): Promise<void> {
    await this.db
      .update(emailConnections)
      .set({ deleted_at: at, updated_at: at })
      .where(eq(emailConnections.account_id, accountId))
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
    reasoningText: row.reasoning_text,
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
      reasoning_text: metric.reasoningText,
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

/**
 * A workspace's default service-fragment selection — one row per workspace in
 * `workspace_fragment_defaults`, the fragment ids stored as a JSON array (mirror of the
 * D1 `D1ServiceFragmentDefaultsRepository`). `set` upserts the whole list.
 */
class DrizzleServiceFragmentDefaultsRepository implements ServiceFragmentDefaultsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ fragmentIds: workspaceFragmentDefaults.fragment_ids })
      .from(workspaceFragmentDefaults)
      .where(eq(workspaceFragmentDefaults.workspace_id, workspaceId))
    return row ? (JSON.parse(row.fragmentIds) as string[]) : []
  }

  async set(workspaceId: string, fragmentIds: string[]): Promise<void> {
    await this.db
      .insert(workspaceFragmentDefaults)
      .values({
        workspace_id: workspaceId,
        fragment_ids: JSON.stringify(fragmentIds),
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: workspaceFragmentDefaults.workspace_id,
        set: { fragment_ids: JSON.stringify(fragmentIds), updated_at: Date.now() },
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
      writebackCommentOnPrOpen: row.writeback_comment_on_pr_open === 1,
      writebackResolveOnMerge: row.writeback_resolve_on_merge === 1,
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
        writeback_comment_on_pr_open: settings.writebackCommentOnPrOpen ? 1 : 0,
        writeback_resolve_on_merge: settings.writebackResolveOnMerge ? 1 : 0,
        updated_at: settings.updatedAt,
      })
      .onConflictDoUpdate({
        target: trackerSettings.workspace_id,
        set: {
          tracker: settings.tracker,
          jira_project_key: settings.jiraProjectKey,
          writeback_comment_on_pr_open: settings.writebackCommentOnPrOpen ? 1 : 0,
          writeback_resolve_on_merge: settings.writebackResolveOnMerge ? 1 : 0,
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
    iteration: row.iteration,
    maxIterations: row.max_iterations,
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
      iteration: review.iteration ?? 1,
      max_iterations: review.maxIterations ?? 1,
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
          iteration: values.iteration,
          max_iterations: values.max_iterations,
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

type ConsensusSessionRow = typeof consensusSessions.$inferSelect

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToConsensusSession(row: ConsensusSessionRow): ConsensusSession {
  return {
    id: row.id,
    blockId: row.block_id,
    executionId: row.execution_id,
    stepIndex: row.step_index,
    agentKind: row.agent_kind,
    strategy: row.strategy as ConsensusSession['strategy'],
    status: row.status as ConsensusSession['status'],
    participants: parseJsonArray(row.participants),
    rounds: parseJsonArray(row.rounds),
    synthesis: row.synthesis,
    confidence: row.confidence,
    dissent: parseJsonArray(row.dissent),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type ClarityReviewRow = typeof clarityReviews.$inferSelect

function rowToClarityReview(row: ClarityReviewRow): ClarityReview {
  let items: ClarityReviewItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as ClarityReviewItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as ClarityReview['status'],
    items,
    model: row.model,
    clarifiedReport: row.clarified_report,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Consensus session transcripts (`consensus_sessions`), the Drizzle/Postgres mirror of
 * {@link D1ConsensusSessionRepository}. One row per (execution, step); the
 * participants/rounds/dissent live as JSON columns, upserted as the process streams.
 */
export class DrizzleConsensusSessionRepository implements ConsensusSessionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(and(eq(consensusSessions.workspace_id, workspaceId), eq(consensusSessions.id, id)))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(
        and(
          eq(consensusSessions.workspace_id, workspaceId),
          eq(consensusSessions.execution_id, executionId),
          eq(consensusSessions.step_index, stepIndex),
        ),
      )
      .orderBy(desc(consensusSessions.created_at))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ConsensusSession | null> {
    const rows = await this.db
      .select()
      .from(consensusSessions)
      .where(
        and(
          eq(consensusSessions.workspace_id, workspaceId),
          eq(consensusSessions.block_id, blockId),
        ),
      )
      .orderBy(desc(consensusSessions.created_at))
      .limit(1)
    return rows[0] ? rowToConsensusSession(rows[0]) : null
  }

  async upsert(workspaceId: string, session: ConsensusSession): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: session.id,
      block_id: session.blockId,
      execution_id: session.executionId,
      step_index: session.stepIndex,
      agent_kind: session.agentKind,
      strategy: session.strategy,
      status: session.status,
      participants: JSON.stringify(session.participants),
      rounds: JSON.stringify(session.rounds),
      synthesis: session.synthesis,
      confidence: session.confidence ?? null,
      dissent: JSON.stringify(session.dissent ?? []),
      error: session.error ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }
    await this.db
      .insert(consensusSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [consensusSessions.workspace_id, consensusSessions.id],
        set: {
          block_id: values.block_id,
          execution_id: values.execution_id,
          step_index: values.step_index,
          agent_kind: values.agent_kind,
          strategy: values.strategy,
          status: values.status,
          participants: values.participants,
          rounds: values.rounds,
          synthesis: values.synthesis,
          confidence: values.confidence,
          dissent: values.dissent,
          error: values.error,
          updated_at: values.updated_at,
        },
      })
  }
}

/**
 * Clarity (bug-report triage) reviews over Postgres — the Drizzle mirror of the Worker's
 * `D1ClarityReviewRepository`. Behaviourally identical to the D1 repo so the cross-runtime
 * conformance suite asserts the same clarified-brief substitution against both stores.
 */
export class DrizzleClarityReviewRepository implements ClarityReviewRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(workspaceId: string, blockId: string): Promise<ClarityReview | null> {
    const rows = await this.db
      .select()
      .from(clarityReviews)
      .where(
        and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.block_id, blockId)),
      )
      .orderBy(desc(clarityReviews.created_at))
      .limit(1)
    return rows[0] ? rowToClarityReview(rows[0]) : null
  }

  async get(workspaceId: string, id: string): Promise<ClarityReview | null> {
    const rows = await this.db
      .select()
      .from(clarityReviews)
      .where(and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.id, id)))
      .limit(1)
    return rows[0] ? rowToClarityReview(rows[0]) : null
  }

  async upsert(workspaceId: string, review: ClarityReview): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: review.id,
      block_id: review.blockId,
      status: review.status,
      items: JSON.stringify(review.items),
      model: review.model,
      clarified_report: review.clarifiedReport,
      iteration: review.iteration ?? 1,
      max_iterations: review.maxIterations ?? 1,
      created_at: review.createdAt,
      updated_at: review.updatedAt,
    }
    await this.db
      .insert(clarityReviews)
      .values(values)
      .onConflictDoUpdate({
        target: [clarityReviews.workspace_id, clarityReviews.id],
        set: {
          block_id: values.block_id,
          status: values.status,
          items: values.items,
          model: values.model,
          clarified_report: values.clarified_report,
          iteration: values.iteration,
          max_iterations: values.max_iterations,
          updated_at: values.updated_at,
        },
      })
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(clarityReviews)
      .where(
        and(eq(clarityReviews.workspace_id, workspaceId), eq(clarityReviews.block_id, blockId)),
      )
  }
}

type MergePresetRow = typeof mergeThresholdPresets.$inferSelect

function rowToMergePreset(row: MergePresetRow): MergeThresholdPreset {
  return {
    id: row.id,
    name: row.name,
    maxComplexity: row.max_complexity,
    maxRisk: row.max_risk,
    maxImpact: row.max_impact,
    ciMaxAttempts: row.ci_max_attempts,
    maxRequirementIterations: row.max_requirement_iterations,
    maxRequirementConcernAllowed:
      row.max_requirement_concern_allowed as MergeThresholdPreset['maxRequirementConcernAllowed'],
    releaseWatchWindowMinutes: row.release_watch_window_minutes,
    releaseMaxAttempts: row.release_max_attempts,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

/**
 * Per-workspace merge threshold presets over Postgres (the Drizzle mirror of the
 * Worker's `D1MergePresetRepository`, migration 0024). Enforces the single-default
 * invariant: promoting a preset to default demotes every other in the workspace
 * before the upsert. The default preset cannot be removed (the service keeps that
 * rule too; the DELETE also guards `is_default = 0`). Behaviourally identical to the
 * D1 repo so the cross-runtime conformance suite asserts the same preset resolution.
 */
export class DrizzleMergePresetRepository implements MergePresetRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<MergeThresholdPreset | null> {
    const rows = await this.db
      .select()
      .from(mergeThresholdPresets)
      .where(
        and(eq(mergeThresholdPresets.workspace_id, workspaceId), eq(mergeThresholdPresets.id, id)),
      )
      .limit(1)
    return rows[0] ? rowToMergePreset(rows[0]) : null
  }

  async list(workspaceId: string): Promise<MergeThresholdPreset[]> {
    const rows = await this.db
      .select()
      .from(mergeThresholdPresets)
      .where(eq(mergeThresholdPresets.workspace_id, workspaceId))
      .orderBy(mergeThresholdPresets.created_at)
    return rows.map(rowToMergePreset)
  }

  async getDefault(workspaceId: string): Promise<MergeThresholdPreset | null> {
    const rows = await this.db
      .select()
      .from(mergeThresholdPresets)
      .where(
        and(
          eq(mergeThresholdPresets.workspace_id, workspaceId),
          eq(mergeThresholdPresets.is_default, 1),
        ),
      )
      .orderBy(mergeThresholdPresets.created_at)
      .limit(1)
    return rows[0] ? rowToMergePreset(rows[0]) : null
  }

  async upsert(workspaceId: string, preset: MergeThresholdPreset): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: preset.id,
      name: preset.name,
      max_complexity: preset.maxComplexity,
      max_risk: preset.maxRisk,
      max_impact: preset.maxImpact,
      ci_max_attempts: preset.ciMaxAttempts,
      max_requirement_iterations: preset.maxRequirementIterations,
      max_requirement_concern_allowed: preset.maxRequirementConcernAllowed,
      release_watch_window_minutes: preset.releaseWatchWindowMinutes,
      release_max_attempts: preset.releaseMaxAttempts,
      is_default: preset.isDefault ? 1 : 0,
      created_at: preset.createdAt,
    }
    // Demote + upsert run in one transaction so the single-default invariant can never
    // be observed broken (zero or two defaults) by a concurrent reader or a partial failure.
    await this.db.transaction(async (tx) => {
      // Promoting this preset to default demotes any other default first.
      if (preset.isDefault) {
        await tx
          .update(mergeThresholdPresets)
          .set({ is_default: 0 })
          .where(
            and(
              eq(mergeThresholdPresets.workspace_id, workspaceId),
              sql`${mergeThresholdPresets.id} <> ${preset.id}`,
            ),
          )
      }
      await tx
        .insert(mergeThresholdPresets)
        .values(values)
        .onConflictDoUpdate({
          target: [mergeThresholdPresets.workspace_id, mergeThresholdPresets.id],
          set: {
            name: values.name,
            max_complexity: values.max_complexity,
            max_risk: values.max_risk,
            max_impact: values.max_impact,
            ci_max_attempts: values.ci_max_attempts,
            max_requirement_iterations: values.max_requirement_iterations,
            max_requirement_concern_allowed: values.max_requirement_concern_allowed,
            release_watch_window_minutes: values.release_watch_window_minutes,
            release_max_attempts: values.release_max_attempts,
            is_default: values.is_default,
          },
        })
    })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(mergeThresholdPresets)
      .where(
        and(
          eq(mergeThresholdPresets.workspace_id, workspaceId),
          eq(mergeThresholdPresets.id, id),
          eq(mergeThresholdPresets.is_default, 0),
        ),
      )
  }
}

/**
 * Per-workspace runtime settings over Postgres (the Drizzle mirror of the Worker's
 * `D1WorkspaceSettingsRepository`, migration 0004). One row per workspace; the service
 * lazily seeds the default, so an absent row reads as null. Per-type task limits are a
 * JSON column.
 */
export class DrizzleWorkspaceSettingsRepository implements WorkspaceSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<WorkspaceSettings | null> {
    const rows = await this.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    let perType: WorkspaceSettings['taskLimitPerType'] = null
    if (row.task_limit_per_type) {
      try {
        perType = JSON.parse(row.task_limit_per_type) as WorkspaceSettings['taskLimitPerType']
      } catch {
        perType = null
      }
    }
    return {
      waitingEscalationMinutes: row.waiting_escalation_minutes,
      taskLimitMode: row.task_limit_mode as WorkspaceSettings['taskLimitMode'],
      taskLimitShared: row.task_limit_shared,
      taskLimitPerType: perType,
    }
  }

  async upsert(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      waiting_escalation_minutes: settings.waitingEscalationMinutes,
      task_limit_mode: settings.taskLimitMode,
      task_limit_shared: settings.taskLimitShared,
      task_limit_per_type: settings.taskLimitPerType
        ? JSON.stringify(settings.taskLimitPerType)
        : null,
    }
    await this.db
      .insert(workspaceSettings)
      .values(values)
      .onConflictDoUpdate({
        target: [workspaceSettings.workspace_id],
        set: {
          waiting_escalation_minutes: values.waiting_escalation_minutes,
          task_limit_mode: values.task_limit_mode,
          task_limit_shared: values.task_limit_shared,
          task_limit_per_type: values.task_limit_per_type,
        },
      })
  }
}

/**
 * A workspace's observability connection over Postgres (the Drizzle mirror of the Worker's
 * `D1ObservabilityConnectionRepository`, migration 0007). One row per workspace; the
 * provider-specific credentials are stored as a sealed JSON blob (encrypted by the caller),
 * with a non-secret `summary` blob for display.
 */
export class DrizzleObservabilityConnectionRepository implements ObservabilityConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<ObservabilityConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(observabilityConnections)
      .where(eq(observabilityConnections.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      provider: row.provider as ObservabilityProviderKind,
      credentials: row.credentials,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: ObservabilityConnectionRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      provider: record.provider,
      credentials: record.credentials,
      summary: record.summary,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(observabilityConnections)
      .values(values)
      .onConflictDoUpdate({
        target: observabilityConnections.workspace_id,
        set: {
          provider: values.provider,
          credentials: values.credentials,
          summary: values.summary,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .delete(observabilityConnections)
      .where(eq(observabilityConnections.workspace_id, workspaceId))
  }
}

function parseReleaseIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

type ReleaseHealthConfigRow = typeof releaseHealthConfigs.$inferSelect

function rowToReleaseHealthConfig(row: ReleaseHealthConfigRow): ReleaseHealthConfigRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    monitorIds: parseReleaseIds(row.monitor_ids),
    sloIds: parseReleaseIds(row.slo_ids),
    envTag: row.env_tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-block monitor/SLO mapping for the post-release-health gate over Postgres (the
 * Drizzle mirror of the Worker's `D1ReleaseHealthConfigRepository`, migration 0003).
 */
export class DrizzleReleaseHealthConfigRepository implements ReleaseHealthConfigRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<ReleaseHealthConfigRecord | null> {
    const rows = await this.db
      .select()
      .from(releaseHealthConfigs)
      .where(
        and(
          eq(releaseHealthConfigs.workspace_id, workspaceId),
          eq(releaseHealthConfigs.block_id, blockId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToReleaseHealthConfig(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ReleaseHealthConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(releaseHealthConfigs)
      .where(eq(releaseHealthConfigs.workspace_id, workspaceId))
      .orderBy(releaseHealthConfigs.block_id)
    return rows.map(rowToReleaseHealthConfig)
  }

  async upsert(record: ReleaseHealthConfigRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      monitor_ids: JSON.stringify(record.monitorIds),
      slo_ids: JSON.stringify(record.sloIds),
      env_tag: record.envTag,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(releaseHealthConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [releaseHealthConfigs.workspace_id, releaseHealthConfigs.block_id],
        set: {
          monitor_ids: values.monitor_ids,
          slo_ids: values.slo_ids,
          env_tag: values.env_tag,
          updated_at: values.updated_at,
        },
      })
  }

  async delete(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(releaseHealthConfigs)
      .where(
        and(
          eq(releaseHealthConfigs.workspace_id, workspaceId),
          eq(releaseHealthConfigs.block_id, blockId),
        ),
      )
  }
}

export interface CoreRepositories {
  workspaceRepository: WorkspaceRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  userRepository: UserRepository
  invitationRepository: AccountInvitationRepository
  emailConnectionRepository: EmailConnectionRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  tokenUsageRepository: TokenUsageRepository
  llmCallMetricRepository: LlmCallMetricRepository
  agentRunRepository: AgentRunRepository
  modelDefaultsRepository: ModelDefaultsRepository
  serviceFragmentDefaultsRepository: ServiceFragmentDefaultsRepository
  pipelineScheduleRepository: PipelineScheduleRepository
  trackerSettingsRepository: TrackerSettingsRepository
  serviceRepository: ServiceRepository
  workspaceMountRepository: WorkspaceMountRepository
  requirementReviewRepository: RequirementReviewRepository
  consensusSessionRepository: ConsensusSessionRepository
  clarityReviewRepository: ClarityReviewRepository
  mergePresetRepository: MergePresetRepository
  workspaceSettingsRepository: WorkspaceSettingsRepository
  observabilityConnectionRepository: ObservabilityConnectionRepository
  releaseHealthConfigRepository: ReleaseHealthConfigRepository
}

/** Build the Drizzle/Postgres-backed core repositories. */
export function createDrizzleRepositories(db: DrizzleDb, clock: Clock): CoreRepositories {
  return {
    workspaceRepository: new DrizzleWorkspaceRepository(db),
    accountRepository: new DrizzleAccountRepository(db),
    membershipRepository: new DrizzleMembershipRepository(db),
    userRepository: new DrizzleUserRepository(db),
    invitationRepository: new DrizzleAccountInvitationRepository(db),
    emailConnectionRepository: new DrizzleEmailConnectionRepository(db),
    blockRepository: new DrizzleBlockRepository(db),
    pipelineRepository: new DrizzlePipelineRepository(db),
    executionRepository: new DrizzleExecutionRepository(db, clock),
    tokenUsageRepository: new DrizzleTokenUsageRepository(db),
    llmCallMetricRepository: new DrizzleLlmCallMetricRepository(db),
    agentRunRepository: new DrizzleAgentRunRepository(db),
    modelDefaultsRepository: new DrizzleModelDefaultsRepository(db),
    serviceFragmentDefaultsRepository: new DrizzleServiceFragmentDefaultsRepository(db),
    pipelineScheduleRepository: new DrizzlePipelineScheduleRepository(db),
    trackerSettingsRepository: new DrizzleTrackerSettingsRepository(db),
    serviceRepository: new DrizzleServiceRepository(db),
    workspaceMountRepository: new DrizzleWorkspaceMountRepository(db),
    requirementReviewRepository: new DrizzleRequirementReviewRepository(db),
    consensusSessionRepository: new DrizzleConsensusSessionRepository(db),
    clarityReviewRepository: new DrizzleClarityReviewRepository(db),
    mergePresetRepository: new DrizzleMergePresetRepository(db),
    workspaceSettingsRepository: new DrizzleWorkspaceSettingsRepository(db),
    observabilityConnectionRepository: new DrizzleObservabilityConnectionRepository(db),
    releaseHealthConfigRepository: new DrizzleReleaseHealthConfigRepository(db),
  }
}
