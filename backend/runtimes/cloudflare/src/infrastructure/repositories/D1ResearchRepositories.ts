import {
  decodeFindingsStoragePolicy,
  decodeResearchMode,
  parseResearchDefinition,
  type FindingsStorageOwnerKind,
  type FindingsStoragePolicy,
  type ResearchProject,
} from '@cat-factory/contracts'
import type {
  FindingsRevisionRepository,
  FindingsRevisionRow,
  FindingsStoragePolicyRepository,
  ResearchDefinitionRepository,
  ResearchProjectRepository,
  StoredResearchDefinition,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface DefinitionRow {
  account_id: string
  key: string
  version: number
  body: string
  content_hash: string
  created_at: number
}

function rowToDefinition(row: DefinitionRow): StoredResearchDefinition {
  const parsed = parseResearchDefinition(JSON.parse(row.body))
  if (!parsed.ok) {
    throw new Error(`stored research definition ${row.key} v${row.version} is unreadable`)
  }
  return {
    accountId: row.account_id,
    definition: parsed.definition,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  }
}

/** Account-published research definitions, immutable per version (migration 0115). */
export class D1ResearchDefinitionRepository implements ResearchDefinitionRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async get(accountId: string, key: string, version: number) {
    const row = await this.deps.db
      .prepare(
        `SELECT * FROM research_definitions WHERE account_id = ? AND key = ? AND version = ?`,
      )
      .bind(accountId, key, version)
      .first<DefinitionRow>()
    return row ? rowToDefinition(row) : null
  }

  async listByAccount(accountId: string) {
    const { results } = await this.deps.db
      .prepare(`SELECT * FROM research_definitions WHERE account_id = ? ORDER BY key, version`)
      .bind(accountId)
      .all<DefinitionRow>()
    return (results ?? []).map(rowToDefinition)
  }

  async insert(stored: StoredResearchDefinition): Promise<boolean> {
    const result = await this.deps.db
      .prepare(
        `INSERT INTO research_definitions (account_id, key, version, body, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, key, version) DO NOTHING`,
      )
      .bind(
        stored.accountId,
        stored.definition.key,
        stored.definition.version,
        JSON.stringify(stored.definition),
        stored.contentHash,
        stored.createdAt,
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}

interface ResearchProjectRow {
  project_id: string
  definition_key: string
  definition_version: number
  definition_hash: string
  inputs: string
}

/** What each research project pins, and its findings sequence (migration 0115). */
export class D1ResearchProjectRepository implements ResearchProjectRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async get(projectId: string): Promise<ResearchProject | null> {
    const row = await this.deps.db
      .prepare(`SELECT * FROM research_projects WHERE project_id = ?`)
      .bind(projectId)
      .first<ResearchProjectRow>()
    if (!row) return null
    return {
      projectId: row.project_id,
      definitionKey: row.definition_key,
      definitionVersion: row.definition_version,
      definitionHash: row.definition_hash,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    }
  }

  async insert(project: ResearchProject): Promise<void> {
    await this.deps.db
      .prepare(
        `INSERT INTO research_projects
           (project_id, definition_key, definition_version, definition_hash, inputs)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        project.projectId,
        project.definitionKey,
        project.definitionVersion,
        project.definitionHash,
        JSON.stringify(project.inputs),
      )
      .run()
  }

  async reserveSeq(projectId: string): Promise<number> {
    const row = await this.deps.db
      .prepare(
        `UPDATE research_projects SET next_seq = next_seq + 1 WHERE project_id = ?
         RETURNING next_seq - 1 AS seq`,
      )
      .bind(projectId)
      .first<{ seq: number }>()
    if (!row) throw new Error(`research project '${projectId}' not found`)
    return row.seq
  }

  async deleteMany(projectIds: string[]): Promise<void> {
    for (const chunk of chunkForIn(projectIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.deps.db.batch([
        this.deps.db
          .prepare(`DELETE FROM findings_revisions WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
        this.deps.db
          .prepare(
            `DELETE FROM findings_storage_policies
             WHERE owner_kind = 'project' AND owner_id IN (${placeholders})`,
          )
          .bind(...chunk),
        this.deps.db
          .prepare(`DELETE FROM research_projects WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
      ])
    }
  }
}

interface RevisionRow {
  id: string
  project_id: string
  task_id: string
  seq: number
  mode: string
  definition_key: string
  definition_version: number
  created_at: number
  body_inline: string | null
  body_artifact_id: string | null
  body_bytes: number
}

function rowToRevision(row: RevisionRow): FindingsRevisionRow {
  const body =
    row.body_inline !== null
      ? { kind: 'inline' as const, json: row.body_inline }
      : row.body_artifact_id !== null
        ? { kind: 'offloaded' as const, artifactId: row.body_artifact_id }
        : null
  if (!body) throw new Error(`findings revision '${row.id}' has no body`)
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    seq: row.seq,
    mode: decodeResearchMode(row.mode),
    definitionKey: row.definition_key,
    definitionVersion: row.definition_version,
    createdAt: row.created_at,
    body,
    bodyBytes: row.body_bytes,
  }
}

/** Findings revisions, written once each (migration 0115). */
export class D1FindingsRevisionRepository implements FindingsRevisionRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async insert(row: FindingsRevisionRow): Promise<boolean> {
    const result = await this.deps.db
      .prepare(
        `INSERT INTO findings_revisions
           (id, project_id, task_id, seq, mode, definition_key, definition_version, created_at,
            body_inline, body_artifact_id, body_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        row.id,
        row.projectId,
        row.taskId,
        row.seq,
        row.mode,
        row.definitionKey,
        row.definitionVersion,
        row.createdAt,
        row.body.kind === 'inline' ? row.body.json : null,
        row.body.kind === 'offloaded' ? row.body.artifactId : null,
        row.bodyBytes,
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async get(projectId: string, id: string) {
    const row = await this.deps.db
      .prepare(`SELECT * FROM findings_revisions WHERE project_id = ? AND id = ?`)
      .bind(projectId, id)
      .first<RevisionRow>()
    return row ? rowToRevision(row) : null
  }

  async listByProject(projectId: string) {
    const { results } = await this.deps.db
      .prepare(`SELECT * FROM findings_revisions WHERE project_id = ? ORDER BY seq`)
      .bind(projectId)
      .all<RevisionRow>()
    return (results ?? []).map(rowToRevision)
  }
}

/** The findings-storage policy tiers (migration 0115). */
export class D1FindingsStoragePolicyRepository implements FindingsStoragePolicyRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async get(ownerKind: FindingsStorageOwnerKind, ownerId: string) {
    const row = await this.deps.db
      .prepare(`SELECT policy FROM findings_storage_policies WHERE owner_kind = ? AND owner_id = ?`)
      .bind(ownerKind, ownerId)
      .first<{ policy: string }>()
    return row ? decodeFindingsStoragePolicy(row.policy) : null
  }

  async set(
    ownerKind: FindingsStorageOwnerKind,
    ownerId: string,
    policy: FindingsStoragePolicy | null,
  ): Promise<void> {
    if (!policy) {
      await this.deps.db
        .prepare(`DELETE FROM findings_storage_policies WHERE owner_kind = ? AND owner_id = ?`)
        .bind(ownerKind, ownerId)
        .run()
      return
    }
    await this.deps.db
      .prepare(
        `INSERT INTO findings_storage_policies (owner_kind, owner_id, policy) VALUES (?, ?, ?)
         ON CONFLICT (owner_kind, owner_id) DO UPDATE SET policy = excluded.policy`,
      )
      .bind(ownerKind, ownerId, JSON.stringify(policy))
      .run()
  }
}
