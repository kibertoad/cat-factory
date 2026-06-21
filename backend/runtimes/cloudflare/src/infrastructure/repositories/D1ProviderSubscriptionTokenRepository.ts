import type {
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ProviderSubscriptionTokenRow {
  id: string
  workspace_id: string
  vendor: string
  label: string
  token_cipher: string
  created_at: number
  last_used_at: number | null
  window_started_at: number | null
  input_tokens: number
  output_tokens: number
  request_count: number
  deleted_at: number | null
}

function rowToRecord(row: ProviderSubscriptionTokenRow): ProviderSubscriptionTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    vendor: row.vendor as SubscriptionVendor,
    label: row.label,
    tokenCipher: row.token_cipher,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    windowStartedAt: row.window_started_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestCount: row.request_count,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of a workspace's subscription token pool (migration 0035). */
export class D1ProviderSubscriptionTokenRepository implements ProviderSubscriptionTokenRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByVendor(
    workspaceId: string,
    vendor: SubscriptionVendor,
  ): Promise<ProviderSubscriptionTokenRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM provider_subscription_tokens
          WHERE workspace_id = ? AND vendor = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      )
      .bind(workspaceId, vendor)
      .all<ProviderSubscriptionTokenRow>()
    return (results ?? []).map(rowToRecord)
  }

  async getById(workspaceId: string, id: string): Promise<ProviderSubscriptionTokenRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM provider_subscription_tokens WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(id, workspaceId)
      .first<ProviderSubscriptionTokenRow>()
    return row ? rowToRecord(row) : null
  }

  async add(record: ProviderSubscriptionTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_subscription_tokens
          (id, workspace_id, vendor, label, token_cipher, created_at, last_used_at,
           window_started_at, input_tokens, output_tokens, request_count, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.vendor,
        record.label,
        record.tokenCipher,
        record.createdAt,
        record.lastUsedAt,
        record.windowStartedAt,
        record.inputTokens,
        record.outputTokens,
        record.requestCount,
      )
      .run()
  }

  async markLeased(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE provider_subscription_tokens SET last_used_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }

  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    const row = await this.db
      .prepare('SELECT * FROM provider_subscription_tokens WHERE id = ?')
      .bind(id)
      .first<ProviderSubscriptionTokenRow>()
    if (!row) return
    const windowActive = row.window_started_at != null && at - row.window_started_at < windowMs
    const windowStartedAt = windowActive ? row.window_started_at : at
    const inputTokens = (windowActive ? row.input_tokens : 0) + usage.inputTokens
    const outputTokens = (windowActive ? row.output_tokens : 0) + usage.outputTokens
    const requestCount = (windowActive ? row.request_count : 0) + 1
    await this.db
      .prepare(
        `UPDATE provider_subscription_tokens
          SET window_started_at = ?, input_tokens = ?, output_tokens = ?, request_count = ?
          WHERE id = ?`,
      )
      .bind(windowStartedAt, inputTokens, outputTokens, requestCount, id)
      .run()
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE provider_subscription_tokens SET deleted_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(at, id, workspaceId)
      .run()
  }
}
