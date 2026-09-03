import type {
  AdoptionPlan,
  BootstrapDelivery,
  BootstrapJobRecord,
  BootstrapJobRecordPatch,
  BootstrapJobRepository,
  BootstrapPhase,
  MonorepoBootstrapRef,
  ResolvedAdoption,
  SurveyClaim,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { parseSubtasks } from '@cat-factory/kernel'
import { parseStoredAgentFailure } from '@cat-factory/contracts'
import { chunkForIn } from './chunk'

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

/**
 * The bootstrap-specific payload packed into `agent_runs.detail`.
 *
 * The monorepo flow's state rides here too rather than in new columns: nothing queries on any
 * of it (a run is always read by id, or listed by workspace/service), so a column would buy
 * indexes nobody uses at the cost of a migration on both runtimes.
 */
interface BootstrapDetail {
  referenceArchitectureId: string | null
  referenceArchitectureName: string | null
  repoName: string
  repoOwner: string | null
  repoUrl: string | null
  instructions: string
  monorepo: MonorepoBootstrapRef | null
  phase: BootstrapPhase | null
  driveId: string | null
  adoptionPlan: AdoptionPlan | null
  adoptionReview: ResolvedAdoption | null
  prUrl: string | null
  /**
   * How the run delivers its work. A row written before the delivery toggle existed carries
   * none, and `rowToRecord` resolves it from the TARGET rather than defaulting blindly: a
   * monorepo run of that vintage opened a pull request and a new-repo one force-pushed, which
   * is what those runs actually did.
   */
  delivery: BootstrapDelivery | null
}

/** The value every absent/garbled detail field falls back to. */
const EMPTY_DETAIL: BootstrapDetail = {
  referenceArchitectureId: null,
  referenceArchitectureName: null,
  repoName: '',
  repoOwner: null,
  repoUrl: null,
  instructions: '',
  monorepo: null,
  phase: null,
  driveId: null,
  adoptionPlan: null,
  adoptionReview: null,
  prUrl: null,
  delivery: null,
}

/** Parse the `detail` JSON, tolerating null/garbage (older/blank rows). */
function parseDetail(raw: string): BootstrapDetail {
  try {
    const o = JSON.parse(raw) as Partial<BootstrapDetail>
    return {
      ...EMPTY_DETAIL,
      // `null` is dropped alongside `undefined`, which is safe because every NULLABLE field's
      // empty default already IS null: what it protects are the two fields typed as plain
      // strings (`repoName`, `instructions`), where a row storing a null would otherwise flow
      // one through as a string and reach a prompt as the word "null".
      ...Object.fromEntries(Object.entries(o).filter(([, value]) => value != null)),
    }
  } catch {
    return { ...EMPTY_DETAIL }
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
    failure: parseStoredAgentFailure(row.failure),
    monorepo: detail.monorepo,
    phase: detail.phase,
    // A row written before the monorepo flow existed carries no `driveId`, and its drive WAS
    // keyed on the run id, so falling back to the row id is the historically true value, not a
    // guess. (Its drive is long finished either way; what this protects is a re-drive.)
    driveId: detail.driveId ?? row.id,
    adoptionPlan: detail.adoptionPlan,
    adoptionReview: detail.adoptionReview,
    prUrl: detail.prUrl,
    // A row predating the delivery toggle records what that run DID: a monorepo run opened a
    // pull request and a new-repo run force-pushed its initial commit, which was the only
    // behaviour either target had. Historically true, not a guess.
    delivery: detail.delivery ?? (detail.monorepo ? 'pull_request' : 'direct_push'),
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

/**
 * Patch fields that live INSIDE `detail`, and whether each holds a JSON value rather than a
 * scalar. The split matters: a `json_set` given a stringified object with a bare `?` stores the
 * TEXT of the object, so a plan written that way reads back as a string where the reader expects
 * a plan; `json(?)` is what makes it a nested value.
 */
const DETAIL_FIELDS: Partial<Record<keyof BootstrapJobRecordPatch, 'scalar' | 'json'>> = {
  repoOwner: 'scalar',
  repoUrl: 'scalar',
  phase: 'scalar',
  driveId: 'scalar',
  prUrl: 'scalar',
  monorepo: 'json',
  adoptionPlan: 'json',
  adoptionReview: 'json',
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
      monorepo: record.monorepo,
      phase: record.phase,
      driveId: record.driveId,
      adoptionPlan: record.adoptionPlan,
      adoptionReview: record.adoptionReview,
      prUrl: record.prUrl,
      delivery: record.delivery,
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

  /**
   * One conditional UPDATE: stamp the survey claim only while the row carries none, or carries one
   * that has gone stale. `meta.changes` is the verdict, so the winner is decided by SQLite rather
   * than by a read this caller did first. See the port for why a marker written after the model
   * call cannot serve.
   */
  async claimSurvey(workspaceId: string, id: string, claim: SurveyClaim): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE agent_runs
            SET detail = json_set(COALESCE(detail, '{}'), '$.surveyClaimedAt', ?)
          WHERE workspace_id = ? AND id = ? AND kind = 'bootstrap'
            AND (json_extract(detail, '$.surveyClaimedAt') IS NULL
                 OR json_extract(detail, '$.surveyClaimedAt') <= ?)`,
      )
      .bind(claim.at, workspaceId, id, claim.staleBefore)
      .run()
    return (result.meta?.changes ?? 0) > 0
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
      const kind = DETAIL_FIELDS[key as keyof BootstrapJobRecordPatch]
      if (!kind) continue
      jsonSets.push(`'$.${key}'`, kind === 'json' ? 'json(?)' : '?')
      values.push(kind === 'json' ? JSON.stringify(value ?? null) : (value as string | null))
    }
    if (jsonSets.length > 0) setClauses.push(`detail = json_set(detail, ${jsonSets.join(', ')})`)

    for (const [key, value] of entries) {
      const column = TOP_LEVEL_COLUMNS[key as keyof BootstrapJobRecordPatch]
      if (!column) continue // the `detail` fields are handled above
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

  async listByServices(serviceIds: string[]): Promise<BootstrapJobRecord[]> {
    if (serviceIds.length === 0) return []
    const out: BootstrapJobRecord[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(serviceIds)) {
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
