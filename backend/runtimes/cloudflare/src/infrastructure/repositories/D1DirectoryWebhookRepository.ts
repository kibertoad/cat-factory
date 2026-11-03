import type { DirectoryWebhookRecord, DirectoryWebhookRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// Directory webhook endpoints over D1 (migration 0109). Mirror of the Node facade's
// `DrizzleDirectoryWebhookRepository`; `defineDirectoryWebhookSuite` holds the two to one
// behaviour, the cap race and the delivery lease included.

interface Row {
  account_id: string
  id: string
  url: string
  enabled: number
  secret_sealed: string | null
  delivered_seq: number
  updated_at: number
}

function toRecord(row: Row): DirectoryWebhookRecord {
  return {
    accountId: row.account_id,
    id: row.id,
    url: row.url,
    enabled: row.enabled === 1,
    secretSealed: row.secret_sealed,
    deliveredSeq: row.delivered_seq,
    updatedAt: row.updated_at,
  }
}

export class D1DirectoryWebhookRepository implements DirectoryWebhookRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async list(accountId: string): Promise<DirectoryWebhookRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM directory_webhooks WHERE account_id = ? ORDER BY id ASC')
      .bind(accountId)
      .all<Row>()
    return results.map(toRecord)
  }

  async get(accountId: string, id: string): Promise<DirectoryWebhookRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM directory_webhooks WHERE account_id = ? AND id = ?')
      .bind(accountId, id)
      .first<Row>()
    return row ? toRecord(row) : null
  }

  async put(record: DirectoryWebhookRecord, limit: number): Promise<'stored' | 'limit_reached'> {
    // One conditional statement, so the count and the insert cannot be split by a concurrent
    // registration: an existing endpoint is always admitted (the count includes it), a new one only
    // under the cap. SQLite serializes writers, which is what makes this single statement enough.
    const result = await this.db
      .prepare(
        `INSERT INTO directory_webhooks
           (account_id, id, url, enabled, secret_sealed, delivered_seq, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM directory_webhooks WHERE account_id = ? AND id = ?)
            OR (SELECT COUNT(*) FROM directory_webhooks WHERE account_id = ?) < ?
         ON CONFLICT (account_id, id) DO UPDATE SET
           url = excluded.url,
           enabled = excluded.enabled,
           secret_sealed = excluded.secret_sealed,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.accountId,
        record.id,
        record.url,
        record.enabled ? 1 : 0,
        record.secretSealed,
        record.deliveredSeq,
        record.updatedAt,
        record.accountId,
        record.id,
        record.accountId,
        limit,
      )
      .run()
    return (result.meta.changes ?? 0) > 0 ? 'stored' : 'limit_reached'
  }

  async delete(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM directory_webhooks WHERE account_id = ? AND id = ?')
      .bind(accountId, id)
      .run()
  }

  async listEnabled(): Promise<DirectoryWebhookRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM directory_webhooks WHERE enabled = 1 ORDER BY account_id, id')
      .all<Row>()
    return results.map(toRecord)
  }

  async claim(
    accountId: string,
    id: string,
    token: string,
    now: number,
    leaseUntil: number,
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        `UPDATE directory_webhooks SET lease_token = ?, lease_until = ?
          WHERE account_id = ? AND id = ? AND enabled = 1
            AND (lease_until IS NULL OR lease_until <= ?)
          RETURNING delivered_seq`,
      )
      .bind(token, leaseUntil, accountId, id, now)
      .first<{ delivered_seq: number }>()
    return row ? row.delivered_seq : null
  }

  async complete(accountId: string, id: string, token: string, toSeq: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE directory_webhooks SET delivered_seq = ?, lease_token = NULL, lease_until = NULL
          WHERE account_id = ? AND id = ? AND lease_token = ?`,
      )
      .bind(toSeq, accountId, id, token)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async release(accountId: string, id: string, token: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE directory_webhooks SET lease_token = NULL, lease_until = NULL
          WHERE account_id = ? AND id = ? AND lease_token = ?`,
      )
      .bind(accountId, id, token)
      .run()
  }
}
