import type {
  BootstrapFailure,
  BootstrapJobRecord,
  BootstrapJobRecordPatch,
  BootstrapJobRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * A row of the unified `agent_runs` table (see migration 0019). This repository
 * owns only the `kind='bootstrap'` rows; the execution flow owns `kind='execution'`
 * via {@link D1ExecutionRepository}. Bootstrap-specific fields (the reference
 * architecture, repo name/owner/url, instructions) live in the `detail` JSON
 * column — nothing queries on them — while lifecycle/progress/failure are
 * top-level columns shared with execution.
 */
interface AgentRunRow {
  id: string
  workspace_id: string
  status: string
  block_id: string | null
  /** JSON {referenceArchitectureId,referenceArchitectureName,repoName,repoOwner,repoUrl,instructions}. */
  detail: string
  /** JSON {completed,inProgress,total}; null until the agent reports. */
  subtasks: string | null
  error: string | null
  /** JSON-encoded AgentFailure; null unless the run failed. */
  failure: string | null
  created_at: number
  updated_at: number
}

/** The bootstrap-specific payload packed into `agent_runs.detail`. */
interface BootstrapDetail {
  referenceArchitectureId: string | null
  referenceArchitectureName: string | null
  repoName: string
  repoOwner: string | null
  repoUrl: string | null
  instructions: string
}

/** Parse the JSON-encoded subtask counts column, tolerating a null/garbage value. */
function parseSubtasks(raw: string | null): BootstrapJobRecord['subtasks'] {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof o.completed === 'number' &&
      typeof o.inProgress === 'number' &&
      typeof o.total === 'number'
    ) {
      type Item = NonNullable<NonNullable<BootstrapJobRecord['subtasks']>['items']>[number]
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

/** Parse the JSON-encoded structured failure column, tolerating null/garbage. */
function parseFailure(raw: string | null): BootstrapFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as BootstrapFailure
    if (o && typeof o.kind === 'string' && typeof o.message === 'string') return o
  } catch {
    // fall through
  }
  return null
}

/** Parse the `detail` JSON, tolerating null/garbage (older/blank rows). */
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

function rowToRecord(row: AgentRunRow): BootstrapJobRecord {
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

/** Top-level patch fields → their `agent_runs` column. */
const TOP_LEVEL_COLUMNS: Partial<Record<keyof BootstrapJobRecordPatch, string>> = {
  status: 'status',
  blockId: 'block_id',
  subtasks: 'subtasks',
  error: 'error',
  failure: 'failure',
  updatedAt: 'updated_at',
}

/** Encode a top-level patch value: subtasks + failure are JSON, everything else scalar. */
function encodeTopLevel(key: string, value: unknown): string | number | null {
  if (key === 'subtasks' || key === 'failure') return value == null ? null : JSON.stringify(value)
  return value as string | number | null
}

/** D1-backed bootstrap runs, stored as `kind='bootstrap'` rows of `agent_runs`. */
export class D1BootstrapJobRepository implements BootstrapJobRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
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
    // Stamp `service_id` from the materialised service frame (when known) so a shared
    // service's in-flight bootstrap surfaces on every board that mounts it via `listByService`.
    await this.db
      .prepare(
        `INSERT INTO agent_runs
          (workspace_id, id, kind, block_id, status, detail, subtasks, error, failure,
           created_at, updated_at, service_id)
         VALUES (?, ?, 'bootstrap', ?, ?, ?, ?, ?, ?, ?, ?,
            (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?))`,
      )
      .bind(
        record.workspaceId,
        record.id,
        record.blockId,
        record.status,
        JSON.stringify(detail),
        record.subtasks == null ? null : JSON.stringify(record.subtasks),
        record.error,
        record.failure == null ? null : JSON.stringify(record.failure),
        record.createdAt,
        record.updatedAt,
        record.workspaceId,
        record.blockId,
      )
      .run()
  }

  async update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return

    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    // repoOwner/repoUrl live inside the `detail` JSON; patch them together with a
    // single json_set so a partial patch leaves the other field untouched.
    const jsonSets: string[] = []
    for (const [key, value] of entries) {
      if (key === 'repoOwner' || key === 'repoUrl') {
        jsonSets.push(`'$.${key}'`, '?')
        values.push(value as string | null)
      }
    }
    if (jsonSets.length > 0) setClauses.push(`detail = json_set(detail, ${jsonSets.join(', ')})`)

    for (const [key, value] of entries) {
      const column = TOP_LEVEL_COLUMNS[key as keyof BootstrapJobRecordPatch]
      if (!column) continue // repoOwner/repoUrl handled above
      setClauses.push(`${column} = ?`)
      values.push(encodeTopLevel(key, value))
    }

    // The run row is inserted before its service frame exists (block_id is set on a later
    // patch), so refresh `service_id` from the block whenever block_id is (re)assigned — this
    // is when a bootstrap becomes service-discoverable on every board mounting the service.
    const blockIdEntry = entries.find(([key]) => key === 'blockId')
    if (blockIdEntry) {
      setClauses.push(
        'service_id = (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?)',
      )
      values.push(workspaceId, blockIdEntry[1] as string | null)
    }

    if (setClauses.length === 0) return
    await this.db
      .prepare(
        `UPDATE agent_runs SET ${setClauses.join(', ')} WHERE workspace_id = ? AND id = ? AND kind = 'bootstrap'`,
      )
      .bind(...values, workspaceId, id)
      .run()
  }

  async get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM agent_runs WHERE workspace_id = ? AND id = ? AND kind = 'bootstrap'`)
      .bind(workspaceId, id)
      .first<AgentRunRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND kind = 'bootstrap' ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<AgentRunRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listByService(serviceId: string): Promise<BootstrapJobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE service_id = ? AND kind = 'bootstrap' ORDER BY created_at DESC`,
      )
      .bind(serviceId)
      .all<AgentRunRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listByServices(serviceIds: string[]): Promise<BootstrapJobRecord[]> {
    if (serviceIds.length === 0) return []
    const out: BootstrapJobRecord[] = []
    // Chunk the IN list to stay well under SQLite/D1's bound-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const chunk = serviceIds.slice(i, i + 500)
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM agent_runs WHERE service_id IN (${placeholders}) AND kind = 'bootstrap' ORDER BY created_at DESC`,
        )
        .bind(...chunk)
        .all<AgentRunRow>()
      for (const row of results ?? []) out.push(rowToRecord(row))
    }
    return out
  }
}
