import type {
  BootstrapFailure,
  BootstrapJobRecord,
  BootstrapJobRecordPatch,
  BootstrapJobRepository,
  ReferenceArchitectureRecord,
  ReferenceArchitectureRecordPatch,
  ReferenceArchitectureRepository,
  StepSubtasks,
} from '@cat-factory/kernel'
import { isKnownAgentFailureKind } from '@cat-factory/server'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { agentRuns, blocks, referenceArchitectures } from '../db/schema.js'

// Drizzle/Postgres mirrors of the repo-bootstrap D1 repositories (migration 0010).
// Reference architectures are their own table; bootstrap runs are kind='bootstrap'
// rows of the unified agent_runs table (the bootstrap-specific fields ride in the
// `detail` JSON), exactly like the Worker. Behaviourally identical so the
// cross-runtime conformance suite asserts the same bootstrap lifecycle on both stores.

// ---- reference architectures ----------------------------------------------

type ReferenceArchitectureRow = typeof referenceArchitectures.$inferSelect

function rowToRefArch(row: ReferenceArchitectureRow): ReferenceArchitectureRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    defaultInstructions: row.default_instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

const REF_ARCH_PATCH_COLUMNS = {
  name: 'name',
  description: 'description',
  repoOwner: 'repo_owner',
  repoName: 'repo_name',
  defaultInstructions: 'default_instructions',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof ReferenceArchitectureRecordPatch, string>

export class DrizzleReferenceArchitectureRepository implements ReferenceArchitectureRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: ReferenceArchitectureRecord): Promise<void> {
    await this.db.insert(referenceArchitectures).values({
      id: record.id,
      workspace_id: record.workspaceId,
      name: record.name,
      description: record.description,
      repo_owner: record.repoOwner,
      repo_name: record.repoName,
      default_instructions: record.defaultInstructions,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: null,
    })
  }

  async update(
    workspaceId: string,
    id: string,
    patch: ReferenceArchitectureRecordPatch,
  ): Promise<void> {
    const set: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      set[REF_ARCH_PATCH_COLUMNS[key as keyof ReferenceArchitectureRecordPatch]] = value as
        | string
        | number
    }
    if (Object.keys(set).length === 0) return
    await this.db
      .update(referenceArchitectures)
      .set(set)
      .where(
        and(
          eq(referenceArchitectures.workspace_id, workspaceId),
          eq(referenceArchitectures.id, id),
          isNull(referenceArchitectures.deleted_at),
        ),
      )
  }

  async get(workspaceId: string, id: string): Promise<ReferenceArchitectureRecord | null> {
    const rows = await this.db
      .select()
      .from(referenceArchitectures)
      .where(
        and(
          eq(referenceArchitectures.workspace_id, workspaceId),
          eq(referenceArchitectures.id, id),
          isNull(referenceArchitectures.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRefArch(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ReferenceArchitectureRecord[]> {
    const rows = await this.db
      .select()
      .from(referenceArchitectures)
      .where(
        and(
          eq(referenceArchitectures.workspace_id, workspaceId),
          isNull(referenceArchitectures.deleted_at),
        ),
      )
      .orderBy(desc(referenceArchitectures.created_at))
    return rows.map(rowToRefArch)
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(referenceArchitectures)
      .set({ deleted_at: at })
      .where(
        and(
          eq(referenceArchitectures.workspace_id, workspaceId),
          eq(referenceArchitectures.id, id),
          isNull(referenceArchitectures.deleted_at),
        ),
      )
  }
}

// ---- bootstrap jobs (kind='bootstrap' rows of agent_runs) -----------------

interface BootstrapDetail {
  referenceArchitectureId: string | null
  referenceArchitectureName: string | null
  repoName: string
  repoOwner: string | null
  repoUrl: string | null
  instructions: string
}

function parseSubtasks(raw: string | null): StepSubtasks | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof o.completed === 'number' &&
      typeof o.inProgress === 'number' &&
      typeof o.total === 'number'
    ) {
      type Item = NonNullable<StepSubtasks['items']>[number]
      let items: Item[] | undefined
      if (Array.isArray(o.items)) {
        items = []
        for (const it of o.items as unknown[]) {
          if (!it || typeof it !== 'object') continue
          const r = it as Record<string, unknown>
          const status = r.status
          if (
            typeof r.label === 'string' &&
            (status === 'pending' || status === 'in_progress' || status === 'completed')
          ) {
            items.push({ label: r.label, status })
          }
        }
      }
      return { completed: o.completed, inProgress: o.inProgress, total: o.total, items }
    }
  } catch {
    // fall through
  }
  return null
}

function parseFailure(raw: string | null): BootstrapFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as BootstrapFailure
    // LEGACY: drop a failure carrying a removed kind (e.g. `decision_timeout`); the obsolete
    // value would fail the contract picklist and brick the snapshot. Remove after 2026-07-15.
    if (o && typeof o.kind === 'string' && typeof o.message === 'string') {
      return isKnownAgentFailureKind(o.kind) ? o : null
    }
  } catch {
    // fall through
  }
  return null
}

function parseDetail(raw: string): BootstrapDetail {
  try {
    const o = JSON.parse(raw) as Partial<BootstrapDetail>
    return {
      referenceArchitectureId: o.referenceArchitectureId ?? null,
      referenceArchitectureName: o.referenceArchitectureName ?? null,
      repoName: o.repoName ?? '',
      repoOwner: o.repoOwner ?? null,
      repoUrl: o.repoUrl ?? null,
      instructions: o.instructions ?? '',
    }
  } catch {
    return {
      referenceArchitectureId: null,
      referenceArchitectureName: null,
      repoName: '',
      repoOwner: null,
      repoUrl: null,
      instructions: '',
    }
  }
}

function rowToBootstrapJob(row: typeof agentRuns.$inferSelect): BootstrapJobRecord {
  const detail = parseDetail(row.detail)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    referenceArchitectureId: detail.referenceArchitectureId,
    referenceArchitectureName: detail.referenceArchitectureName,
    repoName: detail.repoName,
    repoOwner: detail.repoOwner,
    repoUrl: detail.repoUrl,
    instructions: detail.instructions,
    status: row.status as BootstrapJobRecord['status'],
    blockId: row.block_id ?? null,
    subtasks: parseSubtasks(row.subtasks ?? null),
    error: row.error,
    failure: parseFailure(row.failure ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Postgres-backed bootstrap runs, stored as kind='bootstrap' rows of agent_runs. */
export class DrizzleBootstrapJobRepository implements BootstrapJobRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** The service_id of a workspace's block, as a correlated subquery value. */
  private blockServiceId(workspaceId: string, blockId: string | null) {
    return sql<string | null>`(SELECT ${blocks.service_id} FROM ${blocks}
      WHERE ${blocks.workspace_id} = ${workspaceId} AND ${blocks.id} = ${blockId})`
  }

  async insert(record: BootstrapJobRecord): Promise<void> {
    const detail: BootstrapDetail = {
      referenceArchitectureId: record.referenceArchitectureId,
      referenceArchitectureName: record.referenceArchitectureName,
      repoName: record.repoName,
      repoOwner: record.repoOwner,
      repoUrl: record.repoUrl,
      instructions: record.instructions,
    }
    await this.db.insert(agentRuns).values({
      workspace_id: record.workspaceId,
      id: record.id,
      kind: 'bootstrap',
      block_id: record.blockId,
      status: record.status,
      detail: JSON.stringify(detail),
      subtasks: record.subtasks == null ? null : JSON.stringify(record.subtasks),
      error: record.error,
      failure: record.failure == null ? null : JSON.stringify(record.failure),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      // Stamp service_id from the materialised service frame (when known) so a shared
      // service's in-flight bootstrap surfaces on every board that mounts it.
      service_id: this.blockServiceId(record.workspaceId, record.blockId),
    })
  }

  async update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void> {
    const set: Record<string, unknown> = {}
    // repoOwner/repoUrl live inside the `detail` JSON; patch them together with a
    // single jsonb_set chain so a partial patch leaves the other field untouched.
    let detailExpr = sql`${agentRuns.detail}::jsonb`
    let patchesDetail = false
    if (patch.repoOwner !== undefined) {
      detailExpr = sql`jsonb_set(${detailExpr}, '{repoOwner}', ${JSON.stringify(patch.repoOwner)}::jsonb)`
      patchesDetail = true
    }
    if (patch.repoUrl !== undefined) {
      detailExpr = sql`jsonb_set(${detailExpr}, '{repoUrl}', ${JSON.stringify(patch.repoUrl)}::jsonb)`
      patchesDetail = true
    }
    if (patchesDetail) set.detail = sql`(${detailExpr})::text`
    if (patch.status !== undefined) set.status = patch.status
    if (patch.blockId !== undefined) {
      set.block_id = patch.blockId
      // The run row is inserted before its service frame exists, so refresh service_id
      // from the block whenever block_id is (re)assigned.
      set.service_id = this.blockServiceId(workspaceId, patch.blockId)
    }
    if (patch.subtasks !== undefined) {
      set.subtasks = patch.subtasks == null ? null : JSON.stringify(patch.subtasks)
    }
    if (patch.error !== undefined) set.error = patch.error
    if (patch.failure !== undefined) {
      set.failure = patch.failure == null ? null : JSON.stringify(patch.failure)
    }
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt
    if (Object.keys(set).length === 0) return
    await this.db
      .update(agentRuns)
      .set(set)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.id, id),
          eq(agentRuns.kind, 'bootstrap'),
        ),
      )
  }

  async get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.id, id),
          eq(agentRuns.kind, 'bootstrap'),
        ),
      )
      .limit(1)
    return rows[0] ? rowToBootstrapJob(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.kind, 'bootstrap')))
      .orderBy(desc(agentRuns.created_at))
    return rows.map(rowToBootstrapJob)
  }

  async listByService(serviceId: string): Promise<BootstrapJobRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.service_id, serviceId), eq(agentRuns.kind, 'bootstrap')))
      .orderBy(desc(agentRuns.created_at))
    return rows.map(rowToBootstrapJob)
  }

  async listByServices(serviceIds: string[]): Promise<BootstrapJobRecord[]> {
    if (serviceIds.length === 0) return []
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(inArray(agentRuns.service_id, serviceIds), eq(agentRuns.kind, 'bootstrap')))
      .orderBy(desc(agentRuns.created_at))
    return rows.map(rowToBootstrapJob)
  }
}
