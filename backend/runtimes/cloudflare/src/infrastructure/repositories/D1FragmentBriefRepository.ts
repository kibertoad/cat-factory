import type {
  FragmentBriefRecord,
  FragmentBriefRepository,
  FragmentOwnerKind,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface FragmentBriefRow {
  owner_kind: string
  owner_id: string
  fragment_id: string
  body_fingerprint: string
  brief: string
  model: string
  generated_at: number
}

function rowToRecord(row: FragmentBriefRow): FragmentBriefRecord {
  return {
    ownerKind: row.owner_kind as FragmentOwnerKind,
    ownerId: row.owner_id,
    fragmentId: row.fragment_id,
    bodyFingerprint: row.body_fingerprint,
    brief: row.brief,
    model: row.model,
    generatedAt: row.generated_at,
  }
}

/**
 * D1-backed store of model-generated condensed briefs, scoped by the owner of the tier that
 * won the merge for each fragment id (migration 0069). Derived data: a row is replaced
 * wholesale whenever the body it condenses changes, and dropped with its fragment.
 */
export class D1FragmentBriefRepository implements FragmentBriefRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentBriefRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM fragment_briefs WHERE owner_kind = ? AND owner_id = ?')
      .bind(ownerKind, ownerId)
      .all<FragmentBriefRow>()
    return results.map(rowToRecord)
  }

  async upsert(record: FragmentBriefRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fragment_briefs
          (owner_kind, owner_id, fragment_id, body_fingerprint, brief, model, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_kind, owner_id, fragment_id) DO UPDATE SET
           body_fingerprint = excluded.body_fingerprint,
           brief = excluded.brief,
           model = excluded.model,
           generated_at = excluded.generated_at`,
      )
      .bind(
        record.ownerKind,
        record.ownerId,
        record.fragmentId,
        record.bodyFingerprint,
        record.brief,
        record.model,
        record.generatedAt,
      )
      .run()
  }

  async delete(ownerKind: FragmentOwnerKind, ownerId: string, fragmentId: string): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM fragment_briefs WHERE owner_kind = ? AND owner_id = ? AND fragment_id = ?',
      )
      .bind(ownerKind, ownerId, fragmentId)
      .run()
  }
}
