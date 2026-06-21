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
    // A single atomic statement (no read-modify-write) so two jobs finishing on the
    // same token can't lose each other's counters. The window-active test
    // (`window_started_at` set AND younger than `windowMs`) is evaluated against the
    // row's pre-update values in every branch, so a stale window resets to `at` and
    // its counters start from this run; an active one accumulates.
    const active = '(window_started_at IS NOT NULL AND ? - window_started_at < ?)'
    await this.db
      .prepare(
        `UPDATE provider_subscription_tokens
          SET window_started_at = CASE WHEN ${active} THEN window_started_at ELSE ? END,
              input_tokens      = CASE WHEN ${active} THEN input_tokens  ELSE 0 END + ?,
              output_tokens     = CASE WHEN ${active} THEN output_tokens ELSE 0 END + ?,
              request_count     = CASE WHEN ${active} THEN request_count ELSE 0 END + 1
          WHERE id = ?`,
      )
      .bind(
        at,
        windowMs,
        at,
        at,
        windowMs,
        usage.inputTokens,
        at,
        windowMs,
        usage.outputTokens,
        at,
        windowMs,
        id,
      )
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
