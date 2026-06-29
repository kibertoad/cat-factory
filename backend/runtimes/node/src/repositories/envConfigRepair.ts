import type {
  AgentFailure,
  EnvConfigRepairJobRecord,
  EnvConfigRepairJobRecordPatch,
  EnvConfigRepairJobRepository,
  RepoValidationIssue,
  StepSubtasks,
} from '@cat-factory/kernel'
import { isKnownAgentFailureKind } from '@cat-factory/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { agentRuns } from '../db/schema.js'

// Drizzle/Postgres mirror of the D1EnvConfigRepairJobRepository. Env-config-repair runs are
// kind='env-config-repair' rows of the unified agent_runs table (the repair-specific fields —
// owner/repo/branch + the post-repair ok/issues — ride in the `detail` JSON), exactly like
// the Worker. A repair run has no board block and no service frame, so block_id/service_id
// stay null. Behaviourally identical so the cross-runtime conformance suite asserts the same
// repair lifecycle on both stores.

interface EnvConfigRepairDetail {
  owner: string
  repo: string
  branch: string
  ok: boolean | null
  issues: RepoValidationIssue[]
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

function parseFailure(raw: string | null): AgentFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as AgentFailure
    if (o && typeof o.kind === 'string' && typeof o.message === 'string') {
      return isKnownAgentFailureKind(o.kind) ? o : null
    }
  } catch {
    // fall through
  }
  return null
}

function parseDetail(raw: string): EnvConfigRepairDetail {
  try {
    const o = JSON.parse(raw) as Partial<EnvConfigRepairDetail>
    return {
      owner: o.owner ?? '',
      repo: o.repo ?? '',
      branch: o.branch ?? '',
      ok: typeof o.ok === 'boolean' ? o.ok : null,
      issues: Array.isArray(o.issues) ? o.issues : [],
    }
  } catch {
    return { owner: '', repo: '', branch: '', ok: null, issues: [] }
  }
}

function rowToRecord(row: typeof agentRuns.$inferSelect): EnvConfigRepairJobRecord {
  const detail = parseDetail(row.detail)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: detail.owner,
    repo: detail.repo,
    branch: detail.branch,
    status: row.status as EnvConfigRepairJobRecord['status'],
    ok: detail.ok,
    issues: detail.issues,
    subtasks: parseSubtasks(row.subtasks ?? null),
    error: row.error,
    failure: parseFailure(row.failure ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Postgres-backed env-config-repair runs, stored as kind='env-config-repair' rows of agent_runs. */
export class DrizzleEnvConfigRepairJobRepository implements EnvConfigRepairJobRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: EnvConfigRepairJobRecord): Promise<void> {
    const detail: EnvConfigRepairDetail = {
      owner: record.owner,
      repo: record.repo,
      branch: record.branch,
      ok: record.ok,
      issues: record.issues,
    }
    await this.db.insert(agentRuns).values({
      workspace_id: record.workspaceId,
      id: record.id,
      kind: 'env-config-repair',
      block_id: null,
      status: record.status,
      detail: JSON.stringify(detail),
      subtasks: record.subtasks == null ? null : JSON.stringify(record.subtasks),
      error: record.error,
      failure: record.failure == null ? null : JSON.stringify(record.failure),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      service_id: null,
    })
  }

  async update(
    workspaceId: string,
    id: string,
    patch: EnvConfigRepairJobRecordPatch,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    // `ok` + `issues` live inside the `detail` JSON; patch them together with a single
    // jsonb_set chain so a partial patch leaves the other field untouched.
    let detailExpr = sql`${agentRuns.detail}::jsonb`
    let patchesDetail = false
    if (patch.ok !== undefined) {
      detailExpr = sql`jsonb_set(${detailExpr}, '{ok}', ${JSON.stringify(patch.ok)}::jsonb)`
      patchesDetail = true
    }
    if (patch.issues !== undefined) {
      detailExpr = sql`jsonb_set(${detailExpr}, '{issues}', ${JSON.stringify(patch.issues)}::jsonb)`
      patchesDetail = true
    }
    if (patchesDetail) set.detail = sql`(${detailExpr})::text`
    if (patch.status !== undefined) set.status = patch.status
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
          eq(agentRuns.kind, 'env-config-repair'),
        ),
      )
  }

  async get(workspaceId: string, id: string): Promise<EnvConfigRepairJobRecord | null> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.id, id),
          eq(agentRuns.kind, 'env-config-repair'),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<EnvConfigRepairJobRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.kind, 'env-config-repair')))
      .orderBy(desc(agentRuns.created_at))
    return rows.map(rowToRecord)
  }
}
