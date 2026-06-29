import type {
  AgentFailure,
  EnvConfigRepairJobRecord,
  EnvConfigRepairJobRecordPatch,
  EnvConfigRepairJobRepository,
  RepoValidationIssue,
  StepSubtasks,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { isKnownAgentFailureKind } from '@cat-factory/server'

/**
 * A row of the unified `agent_runs` table. This repository owns only the
 * `kind='env-config-repair'` rows (the durable, asynchronous environment-provider
 * config-repair runs); the execution / bootstrap flows own their own kinds. A repair
 * run has NO board block and NO service frame, so `block_id`/`service_id` stay null —
 * the repair-specific fields (owner/repo/branch + the post-repair `ok`/`issues`) live
 * in the `detail` JSON column, while lifecycle/progress/failure are the shared
 * top-level columns.
 */
interface AgentRunRow {
  id: string
  workspace_id: string
  status: string
  /** JSON {owner,repo,branch,ok,issues}. */
  detail: string
  /** JSON {completed,inProgress,total}; null until the agent reports. */
  subtasks: string | null
  error: string | null
  /** JSON-encoded AgentFailure; null unless the run failed. */
  failure: string | null
  created_at: number
  updated_at: number
}

/** The env-config-repair-specific payload packed into `agent_runs.detail`. */
interface EnvConfigRepairDetail {
  owner: string
  repo: string
  branch: string
  ok: boolean | null
  issues: RepoValidationIssue[]
  /** The original bootstrap form inputs, kept so a retry re-dispatches the same prompt. */
  inputs: Record<string, string> | null
}

/** Parse the JSON-encoded subtask counts column, tolerating a null/garbage value. */
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

/** Parse the JSON-encoded structured failure column, tolerating null/garbage. */
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

/** Parse the `detail` JSON, tolerating null/garbage (older/blank rows). */
/** Coerce a parsed `inputs` value to a string→string record, tolerating null/garbage. */
function parseInputs(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : null
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
      inputs: parseInputs(o.inputs),
    }
  } catch {
    return { owner: '', repo: '', branch: '', ok: null, issues: [], inputs: null }
  }
}

function rowToRecord(row: AgentRunRow): EnvConfigRepairJobRecord {
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
    inputs: detail.inputs,
    subtasks: parseSubtasks(row.subtasks ?? null),
    error: row.error,
    failure: parseFailure(row.failure ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Top-level patch fields → their `agent_runs` column. */
const TOP_LEVEL_COLUMNS: Partial<Record<keyof EnvConfigRepairJobRecordPatch, string>> = {
  status: 'status',
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

/** D1-backed env-config-repair runs, stored as `kind='env-config-repair'` rows of `agent_runs`. */
export class D1EnvConfigRepairJobRepository implements EnvConfigRepairJobRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: EnvConfigRepairJobRecord): Promise<void> {
    const detail: EnvConfigRepairDetail = {
      owner: record.owner,
      repo: record.repo,
      branch: record.branch,
      ok: record.ok,
      issues: record.issues,
      inputs: record.inputs,
    }
    await this.db
      .prepare(
        `INSERT INTO agent_runs
          (workspace_id, id, kind, block_id, status, detail, subtasks, error, failure,
           created_at, updated_at, service_id)
         VALUES (?, ?, 'env-config-repair', NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.id,
        record.status,
        JSON.stringify(detail),
        record.subtasks == null ? null : JSON.stringify(record.subtasks),
        record.error,
        record.failure == null ? null : JSON.stringify(record.failure),
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async update(
    workspaceId: string,
    id: string,
    patch: EnvConfigRepairJobRecordPatch,
  ): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return

    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    // `ok` + `issues` live inside the `detail` JSON; patch them with a single json_set so a
    // partial patch leaves the other field untouched. json(?) keeps the bound value nested
    // JSON (an array / a boolean / null) rather than a quoted string.
    const jsonSets: string[] = []
    for (const [key, value] of entries) {
      if (key === 'ok' || key === 'issues') {
        jsonSets.push(`'$.${key}'`, 'json(?)')
        values.push(JSON.stringify(value))
      }
    }
    if (jsonSets.length > 0) setClauses.push(`detail = json_set(detail, ${jsonSets.join(', ')})`)

    for (const [key, value] of entries) {
      const column = TOP_LEVEL_COLUMNS[key as keyof EnvConfigRepairJobRecordPatch]
      if (!column) continue // ok/issues handled above
      setClauses.push(`${column} = ?`)
      values.push(encodeTopLevel(key, value))
    }

    if (setClauses.length === 0) return
    await this.db
      .prepare(
        `UPDATE agent_runs SET ${setClauses.join(', ')} WHERE workspace_id = ? AND id = ? AND kind = 'env-config-repair'`,
      )
      .bind(...values, workspaceId, id)
      .run()
  }

  async get(workspaceId: string, id: string): Promise<EnvConfigRepairJobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND id = ? AND kind = 'env-config-repair'`,
      )
      .bind(workspaceId, id)
      .first<AgentRunRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<EnvConfigRepairJobRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND kind = 'env-config-repair' ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<AgentRunRow>()
    return (results ?? []).map(rowToRecord)
  }
}
