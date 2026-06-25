import type {
  DocumentSourceKind,
  FragmentAppliesTo,
  FragmentOwnerKind,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface PromptFragmentRow {
  fragment_id: string
  owner_kind: string
  owner_id: string
  version: string
  title: string
  category: string | null
  summary: string
  body: string
  applies_to: string | null
  tags: string | null
  source_id: string | null
  source_path: string | null
  source_sha: string | null
  doc_source: string | null
  doc_external_id: string | null
  resolved_at: number | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function rowToRecord(row: PromptFragmentRow): PromptFragmentRecord {
  return {
    fragmentId: row.fragment_id,
    ownerKind: row.owner_kind as FragmentOwnerKind,
    ownerId: row.owner_id,
    version: row.version,
    title: row.title,
    category: row.category,
    summary: row.summary,
    body: row.body,
    appliesTo: parseJson<FragmentAppliesTo>(row.applies_to),
    tags: parseJson<string[]>(row.tags),
    sourceId: row.source_id,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    docSource: (row.doc_source as DocumentSourceKind | null) ?? null,
    docExternalId: row.doc_external_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of managed prompt-fragment rows, both tiers (migration 0020). */
export class D1PromptFragmentRepository implements PromptFragmentRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    includeDeleted = false,
  ): Promise<PromptFragmentRecord[]> {
    const where = includeDeleted
      ? 'owner_kind = ? AND owner_id = ?'
      : 'owner_kind = ? AND owner_id = ? AND deleted_at IS NULL'
    const { results } = await this.db
      .prepare(`SELECT * FROM prompt_fragments WHERE ${where}`)
      .bind(ownerKind, ownerId)
      .all<PromptFragmentRow>()
    return results.map(rowToRecord)
  }

  async get(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
  ): Promise<PromptFragmentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM prompt_fragments WHERE owner_kind = ? AND owner_id = ? AND fragment_id = ?',
      )
      .bind(ownerKind, ownerId, fragmentId)
      .first<PromptFragmentRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: PromptFragmentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO prompt_fragments
          (fragment_id, owner_kind, owner_id, version, title, category, summary, body,
           applies_to, tags, source_id, source_path, source_sha,
           doc_source, doc_external_id, resolved_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_kind, owner_id, fragment_id) DO UPDATE SET
           version = excluded.version,
           title = excluded.title,
           category = excluded.category,
           summary = excluded.summary,
           body = excluded.body,
           applies_to = excluded.applies_to,
           tags = excluded.tags,
           source_id = excluded.source_id,
           source_path = excluded.source_path,
           source_sha = excluded.source_sha,
           doc_source = excluded.doc_source,
           doc_external_id = excluded.doc_external_id,
           resolved_at = excluded.resolved_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.fragmentId,
        record.ownerKind,
        record.ownerId,
        record.version,
        record.title,
        record.category,
        record.summary,
        record.body,
        record.appliesTo ? JSON.stringify(record.appliesTo) : null,
        record.tags ? JSON.stringify(record.tags) : null,
        record.sourceId,
        record.sourcePath,
        record.sourceSha,
        record.docSource,
        record.docExternalId,
        record.resolvedAt,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      )
      .run()
  }

  async softDelete(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
    at: number,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE prompt_fragments SET deleted_at = ?, updated_at = ? WHERE owner_kind = ? AND owner_id = ? AND fragment_id = ?',
      )
      .bind(at, at, ownerKind, ownerId, fragmentId)
      .run()
  }

  async listBySource(sourceId: string): Promise<PromptFragmentRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM prompt_fragments WHERE source_id = ? AND deleted_at IS NULL')
      .bind(sourceId)
      .all<PromptFragmentRow>()
    return results.map(rowToRecord)
  }
}
