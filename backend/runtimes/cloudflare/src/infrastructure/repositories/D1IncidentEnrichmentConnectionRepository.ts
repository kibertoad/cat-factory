import type {
  IncidentEnrichmentConnectionRecord,
  IncidentEnrichmentConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface IncidentEnrichmentConnectionRow {
  workspace_id: string
  credentials: string
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: IncidentEnrichmentConnectionRow): IncidentEnrichmentConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    credentials: row.credentials,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's incident-enrichment connection (migration 0013). Exactly one row per
 * workspace. `credentials` is ONE sealed envelope of `{ pagerDuty?, incidentIo? }` —
 * the caller encrypts before upsert and decrypts at enrichment time; `summary` is a
 * non-secret presence blob. Mirrors D1ObservabilityConnectionRepository.
 */
export class D1IncidentEnrichmentConnectionRepository implements IncidentEnrichmentConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<IncidentEnrichmentConnectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM incident_enrichment_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<IncidentEnrichmentConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: IncidentEnrichmentConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incident_enrichment_connections (workspace_id, credentials, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           credentials = excluded.credentials,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.credentials,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM incident_enrichment_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}
