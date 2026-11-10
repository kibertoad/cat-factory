import {
  parseProjectDefinition,
  type OutcomeStorageOwnerKind,
  type OutcomeStoragePolicy,
  type ProjectPin,
} from '@cat-factory/contracts'
import type {
  OutcomeStoragePolicyRepository,
  ProjectDefinitionRepository,
  ProjectOutcomeRow,
  ProjectRecordRepository,
  StoredProjectDefinition,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface DefinitionRow {
  account_id: string
  kind: string
  key: string
  version: number
  body: string
  content_hash: string
  created_at: number
}

function rowToDefinition(row: DefinitionRow): StoredProjectDefinition {
  const parsed = parseProjectDefinition(JSON.parse(row.body))
  if (!parsed.ok) {
    throw new Error(`stored ${row.kind} definition ${row.key} v${row.version} is unreadable`)
  }
  return {
    accountId: row.account_id,
    definition: parsed.value,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** Account-published project definitions, immutable per version (migration 0115). */
export class D1ProjectDefinitionRepository implements ProjectDefinitionRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async get(accountId: string, kind: string, key: string, version: number) {
    const row = await this.deps.db
      .prepare(
        `SELECT * FROM project_definitions
         WHERE account_id = ? AND kind = ? AND key = ? AND version = ?`,
      )
      .bind(accountId, kind, key, version)
      .first<DefinitionRow>()
    return row ? rowToDefinition(row) : null
  }

  async listByAccount(accountId: string, kind: string) {
    const { results } = await this.deps.db
      .prepare(
        `SELECT * FROM project_definitions WHERE account_id = ? AND kind = ?
         ORDER BY key, version`,
      )
      .bind(accountId, kind)
      .all<DefinitionRow>()
    return (results ?? []).map(rowToDefinition)
  }

  async insert(stored: StoredProjectDefinition): Promise<boolean> {
    const { definition } = stored
    const result = await this.deps.db
      .prepare(
        `INSERT INTO project_definitions
           (account_id, kind, key, version, body, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, kind, key, version) DO NOTHING`,
      )
      .bind(
        stored.accountId,
        definition.kind,
        definition.key,
        definition.version,
        JSON.stringify(definition),
        stored.contentHash,
        stored.createdAt,
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}

interface PinRow {
  project_id: string
  definition_key: string
  definition_version: number
  definition_hash: string
  inputs: string
}

interface OutcomeRow {
  id: string
  project_id: string
  stream: string
  seq: number
  intent: string
  schema_version: number
  task_id: string | null
  definition_key: string | null
  definition_version: number | null
  artifact_refs: string
  created_at: number
  body_inline: string | null
  body_artifact_id: string | null
  body_bytes: number
}

function rowToOutcome(row: OutcomeRow): ProjectOutcomeRow {
  const body =
    row.body_inline !== null
      ? { kind: 'inline' as const, json: row.body_inline }
      : row.body_artifact_id !== null
        ? { kind: 'offloaded' as const, artifactId: row.body_artifact_id }
        : null
  if (!body) throw new Error(`project outcome '${row.id}' has no body`)
  return {
    id: row.id,
    projectId: row.project_id,
    stream: row.stream,
    seq: row.seq,
    intent: row.intent,
    schemaVersion: row.schema_version,
    taskId: row.task_id,
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    artifactRefs: JSON.parse(row.artifact_refs) as string[],
    createdAt: row.created_at,
    body,
    bodyBytes: row.body_bytes,
  }
}

/** A project's pin, outcome sequence and outcome revisions (migration 0115). */
export class D1ProjectRecordRepository implements ProjectRecordRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async getPin(projectId: string): Promise<ProjectPin | null> {
    const row = await this.deps.db
      .prepare(`SELECT * FROM project_pins WHERE project_id = ?`)
      .bind(projectId)
      .first<PinRow>()
    if (!row) return null
    return {
      projectId: row.project_id,
      definitionKey: row.definition_key,
      definitionVersion: row.definition_version,
      definitionHash: row.definition_hash,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    }
  }

  async insertPin(pin: ProjectPin): Promise<void> {
    await this.deps.db
      .prepare(
        `INSERT INTO project_pins
           (project_id, definition_key, definition_version, definition_hash, inputs)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        pin.projectId,
        pin.definitionKey,
        pin.definitionVersion,
        pin.definitionHash,
        JSON.stringify(pin.inputs),
      )
      .run()
  }

  async reserveSeq(projectId: string): Promise<number> {
    const row = await this.deps.db
      .prepare(
        `INSERT INTO project_outcome_seqs (project_id, next_seq) VALUES (?, 2)
         ON CONFLICT (project_id) DO UPDATE SET next_seq = next_seq + 1
         RETURNING next_seq - 1 AS seq`,
      )
      .bind(projectId)
      .first<{ seq: number }>()
    if (!row) throw new Error(`could not reserve an outcome sequence for project '${projectId}'`)
    return row.seq
  }

  async insertOutcome(row: ProjectOutcomeRow): Promise<boolean> {
    const result = await this.deps.db
      .prepare(
        `INSERT INTO project_outcomes
           (id, project_id, stream, seq, intent, schema_version, task_id, definition_key,
            definition_version, artifact_refs, created_at, body_inline, body_artifact_id,
            body_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        row.id,
        row.projectId,
        row.stream,
        row.seq,
        row.intent,
        row.schemaVersion,
        row.taskId,
        row.definitionKey,
        row.definitionVersion,
        JSON.stringify(row.artifactRefs),
        row.createdAt,
        row.body.kind === 'inline' ? row.body.json : null,
        row.body.kind === 'offloaded' ? row.body.artifactId : null,
        row.bodyBytes,
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async getOutcome(projectId: string, id: string) {
    const row = await this.deps.db
      .prepare(`SELECT * FROM project_outcomes WHERE project_id = ? AND id = ?`)
      .bind(projectId, id)
      .first<OutcomeRow>()
    return row ? rowToOutcome(row) : null
  }

  async listOutcomes(projectId: string, stream?: string) {
    const statement =
      stream === undefined
        ? this.deps.db
            .prepare(`SELECT * FROM project_outcomes WHERE project_id = ? ORDER BY seq`)
            .bind(projectId)
        : this.deps.db
            .prepare(
              `SELECT * FROM project_outcomes WHERE project_id = ? AND stream = ? ORDER BY seq`,
            )
            .bind(projectId, stream)
    const { results } = await statement.all<OutcomeRow>()
    return (results ?? []).map(rowToOutcome)
  }

  async deleteByProjects(projectIds: string[]): Promise<void> {
    for (const chunk of chunkForIn(projectIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.deps.db.batch([
        this.deps.db
          .prepare(`DELETE FROM project_outcomes WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
        this.deps.db
          .prepare(`DELETE FROM project_outcome_seqs WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
        this.deps.db
          .prepare(`DELETE FROM project_pins WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
        this.deps.db
          .prepare(
            `DELETE FROM outcome_storage_policies
             WHERE owner_kind = 'project' AND owner_id IN (${placeholders})`,
          )
          .bind(...chunk),
      ])
    }
  }
}

/** The outcome-storage policy tiers (migration 0115). */
export class D1OutcomeStoragePolicyRepository implements OutcomeStoragePolicyRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async get(ownerKind: OutcomeStorageOwnerKind, ownerId: string) {
    const row = await this.deps.db
      .prepare(`SELECT policy FROM outcome_storage_policies WHERE owner_kind = ? AND owner_id = ?`)
      .bind(ownerKind, ownerId)
      .first<{ policy: string }>()
    return row ? (JSON.parse(row.policy) as OutcomeStoragePolicy) : null
  }

  async set(
    ownerKind: OutcomeStorageOwnerKind,
    ownerId: string,
    policy: OutcomeStoragePolicy | null,
  ): Promise<void> {
    if (!policy) {
      await this.deps.db
        .prepare(`DELETE FROM outcome_storage_policies WHERE owner_kind = ? AND owner_id = ?`)
        .bind(ownerKind, ownerId)
        .run()
      return
    }
    await this.deps.db
      .prepare(
        `INSERT INTO outcome_storage_policies (owner_kind, owner_id, policy) VALUES (?, ?, ?)
         ON CONFLICT (owner_kind, owner_id) DO UPDATE SET policy = excluded.policy`,
      )
      .bind(ownerKind, ownerId, JSON.stringify(policy))
      .run()
  }
}
