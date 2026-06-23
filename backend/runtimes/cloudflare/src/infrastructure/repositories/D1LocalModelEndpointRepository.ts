import type { LocalModelEndpointRecord, LocalModelEndpointRepository } from '@cat-factory/kernel'
import type { LocalRunner } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface LocalModelEndpointRow {
  user_id: string
  provider: string
  label: string
  base_url: string
  api_key_cipher: string | null
  models: string
  created_at: number
  updated_at: number
}

function toRecord(row: LocalModelEndpointRow): LocalModelEndpointRecord {
  return {
    userId: row.user_id,
    provider: row.provider as LocalRunner,
    label: row.label,
    baseUrl: row.base_url,
    apiKeyCipher: row.api_key_cipher,
    models: parseModels(row.models),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseModels(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** D1-backed store of a user's locally-run model endpoints (migration 0002). */
export class D1LocalModelEndpointRepository implements LocalModelEndpointRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByUser(userId: string): Promise<LocalModelEndpointRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM local_model_endpoints WHERE user_id = ? ORDER BY created_at ASC`)
      .bind(userId)
      .all<LocalModelEndpointRow>()
    return (results ?? []).map(toRecord)
  }

  async getByUserProvider(
    userId: string,
    provider: LocalRunner,
  ): Promise<LocalModelEndpointRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM local_model_endpoints WHERE user_id = ? AND provider = ?`)
      .bind(userId, provider)
      .first<LocalModelEndpointRow>()
    return row ? toRecord(row) : null
  }

  async upsert(record: LocalModelEndpointRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO local_model_endpoints
           (user_id, provider, label, base_url, api_key_cipher, models, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           label = excluded.label,
           base_url = excluded.base_url,
           api_key_cipher = excluded.api_key_cipher,
           models = excluded.models,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.userId,
        record.provider,
        record.label,
        record.baseUrl,
        record.apiKeyCipher,
        JSON.stringify(record.models),
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async remove(userId: string, provider: LocalRunner): Promise<void> {
    await this.db
      .prepare(`DELETE FROM local_model_endpoints WHERE user_id = ? AND provider = ?`)
      .bind(userId, provider)
      .run()
  }
}
