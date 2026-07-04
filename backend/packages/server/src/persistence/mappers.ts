import type { BlockPatch } from '@cat-factory/kernel'
import type {
  AgentFailure,
  Block,
  ExecutionInstance,
  Pipeline,
  PipelineStep,
  ResolvedFrontendBinding,
  Workspace,
} from '@cat-factory/contracts'
import {
  agentFailureKindSchema,
  agentFailureSchema,
  blockLevelSchema,
  blockStatusSchema,
  executionStatusSchema,
  resolvedFrontendBindingSchema,
} from '@cat-factory/contracts'
import { array, is, string, type GenericSchema } from 'valibot'
import { DataIntegrityError, decodeEnum, decodeJson } from './decode.js'

/** Contract for `blocks.depends_on`: a JSON array of block-id strings. */
const dependsOnSchema = array(string())

// Row <-> domain mapping for the D1 (SQLite) tables. JSON-shaped columns are
// (de)serialised here so the repositories stay focused on SQL.

export interface WorkspaceRow {
  id: string
  name: string
  description?: string | null
  created_at: number
  account_id: string | null
}

export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at,
    accountId: row.account_id ?? null,
  }
}

export interface BlockRow {
  id: string
  title: string
  type: string
  description: string
  pos_x: number
  pos_y: number
  width: number | null
  height: number | null
  status: string
  progress: number
  depends_on: string
  execution_id: string | null
  level: string
  parent_id: string | null
  /** Task-level: membership link to an `epic`-level block (independent of parent_id). */
  epic_id?: string | null
  /** Task-level: membership link to an `initiative`-level block (loop-spawned tasks). */
  initiative_id?: string | null
  /** Task-level: preceding-task auto-start toggle (0/1); null ⇒ off. */
  auto_start_dependents?: number | null
  confidence: number | null
  module_name: string | null
  fragment_ids: string | null
  /** Service-level: the service's selected best-practice fragment ids, JSON array. */
  service_fragment_ids: string | null
  model_id: string | null
  pull_request: string | null
  merge_preset_id: string | null
  model_preset_id: string | null
  pipeline_id: string | null
  /** Task-level agent-contributed config values, JSON id→value map. */
  agent_config: string | null
  /** Service-level: cloud provider the service's jobs run on. */
  cloud_provider: string | null
  /** Service-level: abstract instance size for the service's jobs. */
  instance_size: string | null
  /** Frontend-frame-level: serialized FrontendConfig (build/serve/mock + backend bindings), JSON object. */
  frontend_config?: string | null
  /** Service-frame-level: directed consumer→provider service connections, JSON array. */
  service_connections?: string | null
  /** Task-level: connected service frames directly involved in the task, JSON array of ids. */
  involved_service_ids?: string | null
  created_by: string | null
  responsible_product_user_id: string | null
  /** Task-level: the task-estimator's triage (complexity/risk/impact), JSON object. */
  estimate?: string | null
  /** Task-level: the kind of work (feature/bug/document/spike/recurring). */
  task_type?: string | null
  /** Task-level: small per-type form fields (bug severity, spike timebox…), JSON object. */
  task_type_fields?: string | null
  /** Task-level: 1 ⇒ technical task, 0 ⇒ business task, null ⇒ not yet determined. */
  technical?: number | null
  /** Task-level: per-task issue-tracker writeback overrides ('on'/'off'); null ⇒ inherit. */
  tracker_comment_on_pr_open?: string | null
  tracker_resolve_on_merge?: string | null
  /** Headless marker: 1 ⇒ a public-API "initiative" anchor block excluded from the board; null ⇒ normal. */
  internal?: number | null
}

// ---------------------------------------------------------------------------
// Field-map driven mappers
//
// Hand-enumerating `rowTo*` + `*InsertValues` + `*PatchToColumns` per entity means a
// single persisted field is 3–4 edits kept in sync by eye, and a renamed column only
// surfaces at runtime. Instead, an entity declares each column ONCE as a
// {@link FieldMapper} and the three directions (read / insert / patch) are derived from
// it. The common shapes have builders (`scalarField` / `optField` / `optJsonField` /
// `optBoolIntField`, all defaulting the column to the snake_case of the property); the
// genuinely divergent ones (composite position/size, the tri-state `technical`, the
// emptiness rules that differ between insert and patch) are spelled out inline. Adding a
// column is then a single table entry both the D1 and Drizzle repos pick up.
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>
type ColumnValues = Record<string, unknown>

/** One entity field's bidirectional mapping between a domain property and its column(s). */
interface FieldMapper<Domain, Patch> {
  /** Column row → domain object (mutates `out`); skips absent optionals so they stay unset. */
  read(row: AnyRow, out: AnyRow): void
  /** Domain object → insert column values (mutates `out`). */
  insert(domain: Domain, out: ColumnValues): void
  /** Domain patch → UPDATE column values (mutates `out`); only when the property is present. */
  patch(patch: Patch, out: ColumnValues): void
}

/** camelCase property → snake_case column (`responsibleProductUserId` → `responsible_product_user_id`). */
function toSnake(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

// ---------------------------------------------------------------------------
// LEGACY USER-ID REPAIR — REMOVE AFTER 2026-07-15
//
// PR #94 re-keyed every user id (block `createdBy`, execution `initiatedBy`, account
// membership, personal subscriptions) from the GitHub *numeric* id to the canonical
// `usr_*` *string*, with NO data migration (backwards compatibility is a non-goal here).
// Rows written before that still hold a number. The wire contract now types these fields
// as `string | null`, and the server ships rows WITHOUT validating them against the
// contract — so a single pre-#94 row makes the SPA's response validation reject the entire
// workspace snapshot, bricking the whole board with "Can't reach the backend".
//
// We repair on read: a non-string id is dropped to null. The stale number is an old GitHub
// id that matches no `usr_*` user, so it is useless for creator/initiator routing anyway —
// dropping it loses nothing real and lets the board load.
//
// After the 2026-07-15 grace cutoff, every project is expected to already be in the new
// format. DELETE this block and its callers: read `createdBy` straight through with
// `optField(prop, { patchable: false })`, and use `detail.initiatedBy ?? null` in
// `rowToExecution`.
function legacyUserId(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * A legacy user-id column. Identical to a non-patchable {@link optField} except it drops a
 * non-string (pre-#94 numeric) value to null on read. See the LEGACY USER-ID REPAIR note.
 */
function legacyUserIdField<D, P>(prop: string, column = toSnake(prop)): FieldMapper<D, P> {
  return {
    read: (row, out) => {
      const v = legacyUserId(row[column])
      if (v != null) out[prop] = v
    },
    insert: (d, out) => {
      out[column] = (d as AnyRow)[prop] ?? null
    },
    // Insert-only, never patched (matches the previous `optField(..., { patchable: false })`).
    patch: () => {},
  }
}

/**
 * A required scalar present on both the row and the domain (including always-present
 * nullables like `executionId`): read/insert pass the value straight through, patch
 * writes it whenever the property is defined.
 */
function scalarField<D, P>(prop: string, column = toSnake(prop)): FieldMapper<D, P> {
  return {
    read: (row, out) => {
      out[prop] = row[column]
    },
    insert: (d, out) => {
      out[column] = (d as AnyRow)[prop]
    },
    patch: (p, out) => {
      const v = (p as AnyRow)[prop]
      if (v !== undefined) out[column] = v
    },
  }
}

/**
 * A required enum scalar. Identical to {@link scalarField} on insert/patch, but on READ it
 * re-validates the stored value against its Valibot contract via {@link decodeEnum} — so a
 * corrupt/out-of-contract enum surfaces as a logged {@link DataIntegrityError} (→ 500) at
 * the row, instead of an erased `as` cast smuggling a fake-valid value into the domain.
 */
function enumField<D, P>(
  prop: string,
  schema: GenericSchema<unknown, unknown>,
  table: string,
  column = toSnake(prop),
): FieldMapper<D, P> {
  return {
    read: (row, out) => {
      out[prop] = decodeEnum(schema, row[column], { table, column, id: row.id })
    },
    insert: (d, out) => {
      out[column] = (d as AnyRow)[prop]
    },
    patch: (p, out) => {
      const value = (p as AnyRow)[prop]
      if (value !== undefined) out[column] = value
    },
  }
}

/**
 * An optional scalar: read only when the column is non-null (so the domain key stays
 * absent), insert null when unset. With `clearOnEmpty` a falsy patch value (the empty
 * string from a "clear the selection" dropdown) writes null; otherwise the defined value
 * is written as-is. `patchable: false` leaves the column out of patches entirely.
 */
function optField<D, P>(
  prop: string,
  opts: { column?: string; clearOnEmpty?: boolean; patchable?: boolean } = {},
): FieldMapper<D, P> {
  const column = opts.column ?? toSnake(prop)
  const patchable = opts.patchable ?? true
  return {
    read: (row, out) => {
      if (row[column] != null) out[prop] = row[column]
    },
    insert: (d, out) => {
      out[column] = (d as AnyRow)[prop] ?? null
    },
    patch: (p, out) => {
      if (!patchable) return
      const v = (p as AnyRow)[prop]
      if (v === undefined) return
      out[column] = opts.clearOnEmpty ? v || null : v
    },
  }
}

/** An optional JSON column: parse when present, serialize a truthy value else write null. */
function optJsonField<D, P>(prop: string, column = toSnake(prop)): FieldMapper<D, P> {
  return {
    read: (row, out) => {
      if (row[column] != null) out[prop] = JSON.parse(row[column] as string)
    },
    insert: (d, out) => {
      const v = (d as AnyRow)[prop]
      out[column] = v ? JSON.stringify(v) : null
    },
    patch: (p, out) => {
      const v = (p as AnyRow)[prop]
      if (v === undefined) return
      out[column] = v ? JSON.stringify(v) : null
    },
  }
}

/** An optional boolean stored as 1/null (absent ⇒ off). */
function optBoolIntField<D, P>(prop: string, column = toSnake(prop)): FieldMapper<D, P> {
  return {
    read: (row, out) => {
      if (row[column] != null) out[prop] = row[column] === 1
    },
    insert: (d, out) => {
      out[column] = (d as AnyRow)[prop] ? 1 : null
    },
    patch: (p, out) => {
      const v = (p as AnyRow)[prop]
      if (v === undefined) return
      out[column] = v ? 1 : null
    },
  }
}

/** Build `rowTo*` / `*InsertValues` / `*PatchToColumns` from an entity's field table. */
function makeEntityMapper<Domain, Patch, Row>(
  fields: FieldMapper<Domain, Patch>[],
): {
  fromRow(row: Row): Domain
  toInsert(domain: Domain): ColumnValues
  toPatch(patch: Patch): ColumnValues
} {
  return {
    fromRow(row) {
      const out: AnyRow = {}
      for (const f of fields) f.read(row as AnyRow, out)
      return out as Domain
    },
    toInsert(domain) {
      const out: ColumnValues = {}
      for (const f of fields) f.insert(domain, out)
      return out
    },
    toPatch(patch) {
      const out: ColumnValues = {}
      for (const f of fields) f.patch(patch, out)
      return out
    },
  }
}

// Block: the columns declared once, in insert order. The `position`/`size` composites,
// the tri-state `technical`, and `serviceFragmentIds`/`agentConfig` (whose insert and
// patch emptiness rules differ) are spelled out inline; everything else uses a builder.
const blockFields: FieldMapper<Block, BlockPatch>[] = [
  scalarField('id'),
  scalarField('title'),
  scalarField('type'),
  scalarField('description'),
  {
    read: (row, out) => {
      out.position = { x: row.pos_x, y: row.pos_y }
    },
    insert: (b, out) => {
      out.pos_x = b.position.x
      out.pos_y = b.position.y
    },
    patch: (p, out) => {
      if (p.position !== undefined) {
        out.pos_x = p.position.x
        out.pos_y = p.position.y
      }
    },
  },
  {
    read: (row, out) => {
      if (row.width !== null && row.height !== null) out.size = { w: row.width, h: row.height }
    },
    insert: (b, out) => {
      out.width = b.size?.w ?? null
      out.height = b.size?.h ?? null
    },
    patch: (p, out) => {
      if (p.size !== undefined) {
        out.width = p.size?.w ?? null
        out.height = p.size?.h ?? null
      }
    },
  },
  enumField('status', blockStatusSchema, 'blocks'),
  scalarField('progress'),
  // `dependsOn` is a required (always-present) JSON array, unlike the optional JSON fields.
  {
    read: (row, out) => {
      out.dependsOn = decodeJson(dependsOnSchema, row.depends_on as string, {
        table: 'blocks',
        column: 'depends_on',
        id: row.id,
      })
    },
    insert: (b, out) => {
      out.depends_on = JSON.stringify(b.dependsOn)
    },
    patch: (p, out) => {
      if (p.dependsOn !== undefined) out.depends_on = JSON.stringify(p.dependsOn)
    },
  },
  scalarField('executionId'),
  enumField('level', blockLevelSchema, 'blocks'),
  scalarField('parentId'),
  // Epic membership; an empty string / null detaches the task from its epic.
  optField('epicId', { clearOnEmpty: true }),
  // Initiative membership (loop-spawned tasks); empty/null detaches.
  optField('initiativeId', { clearOnEmpty: true }),
  optBoolIntField('autoStartDependents'),
  optField('confidence'),
  optField('moduleName'),
  optJsonField('fragmentIds'),
  // Service-level selection (frame blocks). Insert keeps a truthy value verbatim; patch
  // treats an empty array as "clear it" (length check), so the two directions differ.
  {
    read: (row, out) => {
      if (row.service_fragment_ids != null)
        out.serviceFragmentIds = JSON.parse(row.service_fragment_ids as string)
    },
    insert: (b, out) => {
      out.service_fragment_ids = b.serviceFragmentIds ? JSON.stringify(b.serviceFragmentIds) : null
    },
    patch: (p, out) => {
      if (p.serviceFragmentIds !== undefined) {
        out.service_fragment_ids =
          p.serviceFragmentIds && p.serviceFragmentIds.length
            ? JSON.stringify(p.serviceFragmentIds)
            : null
      }
    },
  },
  // An empty string clears the selection (back to the routing default).
  optField('modelId', { clearOnEmpty: true }),
  optJsonField('pullRequest'),
  // An empty string clears the selection (back to the workspace default preset).
  optField('mergePresetId', { clearOnEmpty: true }),
  // An empty string clears the selection (back to the workspace default model preset).
  optField('modelPresetId', { clearOnEmpty: true }),
  // An empty string clears the pinned pipeline selection.
  optField('pipelineId', { clearOnEmpty: true }),
  // Replace the whole task-level config map; an empty map clears it (both directions).
  {
    read: (row, out) => {
      if (row.agent_config != null) out.agentConfig = JSON.parse(row.agent_config as string)
    },
    insert: (b, out) => {
      out.agent_config =
        b.agentConfig && Object.keys(b.agentConfig).length ? JSON.stringify(b.agentConfig) : null
    },
    patch: (p, out) => {
      if (p.agentConfig !== undefined) {
        out.agent_config =
          p.agentConfig && Object.keys(p.agentConfig).length ? JSON.stringify(p.agentConfig) : null
      }
    },
  },
  // Service-owned provisioning config (the "what + where") — a JSON object on frame blocks.
  optJsonField('provisioning'),
  optField('cloudProvider'),
  optField('instanceSize'),
  // Frontend-frame-level config (build/serve/mock + backend bindings) — a JSON object.
  optJsonField('frontendConfig'),
  // Service-frame connections (consumer→provider edges). Patch treats an empty array as
  // "clear them" (length check), mirroring `serviceFragmentIds`.
  {
    read: (row, out) => {
      if (row.service_connections != null)
        out.serviceConnections = JSON.parse(row.service_connections as string)
    },
    insert: (b, out) => {
      out.service_connections = b.serviceConnections?.length
        ? JSON.stringify(b.serviceConnections)
        : null
    },
    patch: (p, out) => {
      if (p.serviceConnections !== undefined) {
        out.service_connections = p.serviceConnections?.length
          ? JSON.stringify(p.serviceConnections)
          : null
      }
    },
  },
  // A task's involved connected services. Patch treats an empty array as "clear it".
  {
    read: (row, out) => {
      if (row.involved_service_ids != null)
        out.involvedServiceIds = JSON.parse(row.involved_service_ids as string)
    },
    insert: (b, out) => {
      out.involved_service_ids = b.involvedServiceIds?.length
        ? JSON.stringify(b.involvedServiceIds)
        : null
    },
    patch: (p, out) => {
      if (p.involvedServiceIds !== undefined) {
        out.involved_service_ids = p.involvedServiceIds?.length
          ? JSON.stringify(p.involvedServiceIds)
          : null
      }
    },
  },
  // The PRs a multi-repo run opened in connected services' repos (engine-written beside the
  // own-service `pullRequest`). Patch treats an empty array as "clear them", mirroring the
  // other JSON-array block columns.
  {
    read: (row, out) => {
      if (row.peer_pull_requests != null)
        out.peerPullRequests = JSON.parse(row.peer_pull_requests as string)
    },
    insert: (b, out) => {
      out.peer_pull_requests = b.peerPullRequests?.length
        ? JSON.stringify(b.peerPullRequests)
        : null
    },
    patch: (p, out) => {
      if (p.peerPullRequests !== undefined) {
        out.peer_pull_requests = p.peerPullRequests?.length
          ? JSON.stringify(p.peerPullRequests)
          : null
      }
    },
  },
  // `createdBy` is set at insert time and never patched. LEGACY: a pre-#94 numeric id is
  // dropped to null on read (see the LEGACY USER-ID REPAIR note; remove after 2026-07-15).
  legacyUserIdField('createdBy'),
  // The responsible product person; an empty string clears the assignment.
  optField('responsibleProductUserId', { clearOnEmpty: true }),
  // The task-estimator's triage; a falsy value clears it.
  optJsonField('estimate'),
  optField('taskType'),
  optJsonField('taskTypeFields'),
  // Technical label: 1/0 column, null clears it back to "not yet determined" (the tri-state
  // "unset", so the engine may re-infer). `== null` distinguishes that from explicit false.
  {
    read: (row, out) => {
      if (row.technical != null) out.technical = row.technical === 1
    },
    insert: (b, out) => {
      out.technical = b.technical == null ? null : b.technical ? 1 : 0
    },
    patch: (p, out) => {
      if (p.technical !== undefined)
        out.technical = p.technical == null ? null : p.technical ? 1 : 0
    },
  },
  // Per-task writeback overrides; an empty string clears it (back to inheriting the workspace setting).
  optField('trackerCommentOnPrOpen', { clearOnEmpty: true }),
  optField('trackerResolveOnMerge', { clearOnEmpty: true }),
  // Headless public-API "initiative" anchor: 1/0 column, set once at insert (never patched).
  optBoolIntField('internal'),
]

const blockMapper = makeEntityMapper<Block, BlockPatch, BlockRow>(blockFields)

export function rowToBlock(row: BlockRow): Block {
  return blockMapper.fromRow(row)
}

/** Full column tuple for inserting a block. */
export function blockInsertValues(block: Block): Record<string, unknown> {
  return blockMapper.toInsert(block)
}

/** Map a domain patch onto `{ column: value }` pairs for an UPDATE. */
export function blockPatchToColumns(patch: BlockPatch): Record<string, unknown> {
  return blockMapper.toPatch(patch)
}

export interface PipelineRow {
  id: string
  name: string
  agent_kinds: string
  /** Nullable JSON array of per-step approval gates (migration 0022). */
  gates: string | null
  /** Nullable JSON array of per-step companion quality thresholds (migration 0035). */
  thresholds?: string | null
  /** Nullable JSON array of per-step enable flags (migration 0002). */
  enabled?: string | null
  /** Truthy (1) for the curated built-in catalog templates (migration 0002). */
  builtin?: number | boolean | null
  /** Nullable JSON array of per-step consensus configs (parallel to agent_kinds). */
  consensus?: string | null
  /** Nullable JSON array of per-step estimate gating (migration 0003). */
  gating?: string | null
  /** Nullable JSON array of per-step Follow-up companion toggles (migration 0032). */
  follow_ups?: string | null
  /** Nullable JSON array of per-step test quality-control companion configs (migration 0032). */
  tester_quality?: string | null
  /** Nullable JSON array of organizational labels (migration 0003). */
  labels?: string | null
  /** Truthy (1) when the pipeline is archived / hidden from the default view (migration 0003). */
  archived?: number | boolean | null
  /** Monotonic seed version for a built-in pipeline (migration 0017); null on custom/legacy rows. */
  version?: number | null
  /** Truthy (1) when the pipeline is callable via the public API (migration 0034). */
  public?: number | boolean | null
  /**
   * How the pipeline may be launched: `'one-off'` / `'recurring'` / `'both'` (migration 0037).
   * NULL/absent ⇒ unrestricted (`'both'`).
   */
  availability?: string | null
}

export function rowToPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    name: row.name,
    agentKinds: JSON.parse(row.agent_kinds) as Pipeline['agentKinds'],
    ...(row.gates ? { gates: JSON.parse(row.gates) as boolean[] } : {}),
    ...(row.thresholds ? { thresholds: JSON.parse(row.thresholds) as Pipeline['thresholds'] } : {}),
    ...(row.enabled ? { enabled: JSON.parse(row.enabled) as boolean[] } : {}),
    ...(row.consensus ? { consensus: JSON.parse(row.consensus) as Pipeline['consensus'] } : {}),
    ...(row.gating ? { gating: JSON.parse(row.gating) as Pipeline['gating'] } : {}),
    ...(row.follow_ups ? { followUps: JSON.parse(row.follow_ups) as Pipeline['followUps'] } : {}),
    ...(row.tester_quality
      ? { testerQuality: JSON.parse(row.tester_quality) as Pipeline['testerQuality'] }
      : {}),
    ...(row.labels ? { labels: JSON.parse(row.labels) as string[] } : {}),
    ...(row.archived ? { archived: true } : {}),
    ...(row.builtin ? { builtin: true } : {}),
    ...(row.version != null ? { version: row.version } : {}),
    ...(row.public ? { public: true } : {}),
    ...(row.availability ? { availability: row.availability as Pipeline['availability'] } : {}),
  }
}

/**
 * A `kind='execution'` row of the unified `agent_runs` table (migration 0019).
 * The pipeline shape (pipelineId/Name, steps, currentStep) lives in the `detail`
 * JSON column; lifecycle/failure are top-level columns shared with bootstrap.
 */
export interface ExecutionRow {
  id: string
  block_id: string | null
  status: string
  /** JSON {pipelineId,pipelineName,steps,currentStep}. */
  detail: string
  error: string | null
  /** JSON-encoded AgentFailure; null unless the run failed. */
  failure: string | null
  // Lease for the cron sweeper; not surfaced on the entity.
  updated_at: number
  workflow_instance_id: string | null
  // Optimistic-concurrency revision, bumped on every write (absent/NULL on a legacy
  // row predating the column → read as 0).
  rev?: number | null
}

/** The execution-specific payload packed into `agent_runs.detail`. */
interface ExecutionDetail {
  pipelineId: string
  pipelineName: string
  steps: PipelineStep[]
  currentStep: number
  /** Internal user id of the run's initiator (individual-usage credential ownership). */
  initiatedBy: string | null
  /** Failures from prior attempts, oldest→newest (see {@link ExecutionInstance.failureHistory}). */
  failureHistory?: AgentFailure[]
  /** Epoch-ms creation time stamped at run start; absent on legacy rows. */
  createdAt?: number
  /** Run-start non-fatal advisories (see {@link ExecutionInstance.notes}). */
  notes?: string[]
  /** Frontend bindings resolved once at run start (see {@link ExecutionInstance.frontendBindings}). */
  frontendBindings?: ResolvedFrontendBinding[]
}

// ---------------------------------------------------------------------------
// LEGACY FAILURE-KIND REPAIR — REMOVE AFTER 2026-07-15
//
// `decision_timeout` was removed from `agentFailureKindSchema` when human decisions
// stopped being timeout-limited (other kinds may follow). A run that failed before then
// can still carry the obsolete kind in its persisted failure JSON. The wire contract now
// types the kind as a closed picklist, and the server ships rows WITHOUT validating them,
// so one stale failure makes the SPA's response validation reject the entire workspace
// snapshot and the board fails to load with "Can't reach the backend".
//
// We drop a failure whose kind is no longer known: the run's `status` + `error` string
// still describe what happened, and the obsolete kind is meaningless now.
//
// After the 2026-07-15 grace cutoff, every project is expected to already be in the new
// format. DELETE this helper and revert the three failure parsers (here + the two bootstrap
// repos) to the plain `typeof o.kind === 'string'` check.
const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set(agentFailureKindSchema.options)

/** Whether a persisted failure kind is still part of the current contract picklist. */
export function isKnownAgentFailureKind(kind: string): boolean {
  return KNOWN_FAILURE_KINDS.has(kind)
}

/**
 * Whether a decoded value is a usable {@link AgentFailure}. Validated against the FULL
 * wire schema, not just `kind`/`message`: the SPA re-validates the whole snapshot against
 * `agentFailureSchema` (both the `failure` field and the `failureHistory` array), so a
 * structurally-incomplete record — a removed legacy kind, OR a known kind missing
 * `occurredAt`/`detail`/`hint`/`lastSubtasks` — would brick the entire workspace snapshot
 * decode if surfaced. Dropping it here keeps the run readable (its `status`/`error` still
 * describe what happened) and, for the history, means a retry can't make a bad record
 * permanent. (`is()` rejects removed kinds too, since the picklist no longer lists them —
 * subsuming the old `isKnownAgentFailureKind` check.)
 */
function isUsableFailure(o: unknown): o is AgentFailure {
  return is(agentFailureSchema, o)
}

/** Parse the JSON-encoded structured failure column, tolerating null/garbage. */
function parseAgentFailure(raw: string | null): AgentFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as AgentFailure
    if (isUsableFailure(o)) return o
  } catch {
    // fall through
  }
  return null
}

/**
 * The prior-attempts failure trail packed into `detail`. Tolerant like
 * {@link parseAgentFailure}: a non-array, or an entry that doesn't fully match the wire
 * schema (removed legacy kind, or a structurally-incomplete record), is dropped rather
 * than bricking the whole snapshot decode.
 */
function parseFailureHistory(list: unknown): AgentFailure[] {
  return Array.isArray(list) ? list.filter(isUsableFailure) : []
}

/**
 * The run-start resolved frontend bindings packed into `detail`. Tolerant like the failure
 * parsers: a non-array, or an entry that doesn't match the wire schema, is dropped rather than
 * bricking the whole snapshot decode (the SPA re-validates the full snapshot).
 */
function parseFrontendBindings(list: unknown): ResolvedFrontendBinding[] {
  return Array.isArray(list) ? list.filter((b) => is(resolvedFrontendBindingSchema, b)) : []
}

export function rowToExecution(row: ExecutionRow): ExecutionInstance {
  let detail: Partial<ExecutionDetail>
  try {
    detail = JSON.parse(row.detail) as Partial<ExecutionDetail>
  } catch {
    detail = {}
  }
  // An execution with no owning block is structurally impossible — surface the corrupt
  // row loudly instead of coercing it to an empty id that callers read as "no block".
  if (!row.block_id) {
    throw new DataIntegrityError('Execution row has no block_id', {
      table: 'agent_runs',
      id: row.id,
    })
  }
  const steps = (detail.steps ?? []).map((s) => ({ ...s, runId: row.id }))
  const currentStep = detail.currentStep ?? 0
  // `currentStep` indexes `steps`; it ranges over [0, steps.length] (the upper bound is the
  // legitimate "ran off the end / complete" cursor). Anything outside that wedges the driver
  // on silent no-ops, so reject it at read.
  if (currentStep < 0 || currentStep > steps.length) {
    throw new DataIntegrityError('Execution currentStep is out of bounds', {
      table: 'agent_runs',
      id: row.id,
      currentStep,
      steps: steps.length,
    })
  }
  return {
    id: row.id,
    blockId: row.block_id,
    pipelineId: detail.pipelineId ?? '',
    pipelineName: detail.pipelineName ?? '',
    // Stamp each step with its run id (a projection of the row id) so a lone step is
    // self-describing for debugging; never read back from the detail JSON.
    steps,
    currentStep,
    status: decodeEnum(executionStatusSchema, row.status, {
      table: 'agent_runs',
      column: 'status',
      id: row.id,
    }),
    failure: parseAgentFailure(row.failure),
    // The prior-attempts error trail rides in `detail` (survives every step upsert and needs
    // no dedicated column); a run that never failed-then-retried simply has none.
    failureHistory: parseFailureHistory(detail.failureHistory),
    // Run-start advisories ride in `detail` too (only present for a frontend UI-test run that
    // had something to flag); tolerate a non-array-of-strings by dropping it.
    ...(Array.isArray(detail.notes) && detail.notes.every((n) => typeof n === 'string')
      ? { notes: detail.notes }
      : {}),
    // The run-start resolved bindings ride in `detail` too (only a frontend UI-test run has
    // them); a frozen snapshot so the SPA projects what the run drove against. Drop malformed.
    ...(() => {
      const frontendBindings = parseFrontendBindings(detail.frontendBindings)
      return frontendBindings.length ? { frontendBindings } : {}
    })(),
    // LEGACY: drop a pre-#94 numeric initiator id to null (see the LEGACY USER-ID REPAIR
    // note; after 2026-07-15 revert to `detail.initiatedBy ?? null`).
    initiatedBy: legacyUserId(detail.initiatedBy),
    // Epoch-ms creation time stamped at start; omitted on legacy rows (undefined).
    ...(detail.createdAt != null ? { createdAt: detail.createdAt } : {}),
    // Optimistic-concurrency token; a legacy row without the column reads as 0.
    rev: row.rev ?? 0,
  }
}

/** Build the `agent_runs.detail` JSON for an execution instance (shared by both repos). */
export function executionToDetail(instance: ExecutionInstance): string {
  return JSON.stringify({
    pipelineId: instance.pipelineId,
    pipelineName: instance.pipelineName,
    // `runId` is a read-time projection (it equals the row id) — drop it from the
    // stored JSON so it isn't persisted twice (JSON.stringify omits undefined keys).
    steps: instance.steps.map((s) => ({ ...s, runId: undefined })),
    currentStep: instance.currentStep,
    initiatedBy: instance.initiatedBy ?? null,
    // Only persist a non-empty trail (JSON.stringify omits the undefined key), so runs that
    // never failed don't carry an empty array on every write.
    failureHistory: instance.failureHistory?.length ? instance.failureHistory : undefined,
    ...(instance.createdAt != null ? { createdAt: instance.createdAt } : {}),
    // Likewise only persist run-start notes when there is something to flag.
    notes: instance.notes?.length ? instance.notes : undefined,
    // The resolved bindings are stamped once at start; only a frontend run carries any.
    frontendBindings: instance.frontendBindings?.length ? instance.frontendBindings : undefined,
  } satisfies ExecutionDetail)
}
