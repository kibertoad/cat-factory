import type {
  PersonalSubscriptionRecord,
  PersonalSubscriptionRepository,
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface PersonalSubscriptionRow {
  id: string
  user_id: string
  vendor: string
  label: string
  token_cipher: string
  expires_at: number | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  deleted_at: number | null
}

function toRecord(row: PersonalSubscriptionRow): PersonalSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    vendor: row.vendor as SubscriptionVendor,
    label: row.label,
    tokenCipher: row.token_cipher,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of a user's individual-usage subscriptions (migration 0039). */
export class D1PersonalSubscriptionRepository implements PersonalSubscriptionRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByUserVendor(
    userId: string,
    vendor: SubscriptionVendor,
  ): Promise<PersonalSubscriptionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM personal_subscriptions
          WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL`,
      )
      .bind(userId, vendor)
      .first<PersonalSubscriptionRow>()
    return row ? toRecord(row) : null
  }

  async listByUser(userId: string): Promise<PersonalSubscriptionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM personal_subscriptions
          WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .bind(userId)
      .all<PersonalSubscriptionRow>()
    return (results ?? []).map(toRecord)
  }

  async upsert(record: PersonalSubscriptionRecord): Promise<void> {
    // Keyed by (user_id, vendor): replace any live row so a user has exactly one
    // credential per vendor. Soft-delete the prior live row, then insert the new one.
    await this.db
      .prepare(
        `UPDATE personal_subscriptions SET deleted_at = ?
          WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL AND id != ?`,
      )
      .bind(record.updatedAt, record.userId, record.vendor, record.id)
      .run()
    await this.db
      .prepare(
        `INSERT INTO personal_subscriptions
           (id, user_id, vendor, label, token_cipher, expires_at, created_at, updated_at,
            last_used_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET
           label = excluded.label,
           token_cipher = excluded.token_cipher,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at,
           deleted_at = NULL`,
      )
      .bind(
        record.id,
        record.userId,
        record.vendor,
        record.label,
        record.tokenCipher,
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
      )
      .run()
  }

  async markUsed(userId: string, vendor: SubscriptionVendor, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE personal_subscriptions SET last_used_at = ?
          WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL`,
      )
      .bind(at, userId, vendor)
      .run()
  }

  async softDelete(userId: string, vendor: SubscriptionVendor, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE personal_subscriptions SET deleted_at = ?
          WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL`,
      )
      .bind(at, userId, vendor)
      .run()
  }

  async listExpiring(now: number, before: number): Promise<PersonalSubscriptionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM personal_subscriptions
          WHERE deleted_at IS NULL AND expires_at IS NOT NULL
            AND expires_at >= ? AND expires_at <= ?
          ORDER BY expires_at ASC`,
      )
      .bind(now, before)
      .all<PersonalSubscriptionRow>()
    return (results ?? []).map(toRecord)
  }
}

interface SubscriptionActivationRow {
  id: string
  execution_id: string
  user_id: string
  vendor: string
  token_cipher: string
  created_at: number
  expires_at: number
}

function toActivation(row: SubscriptionActivationRow): SubscriptionActivationRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    userId: row.user_id,
    vendor: row.vendor as SubscriptionVendor,
    tokenCipher: row.token_cipher,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

/** D1-backed store of per-run personal-credential activations (migration 0039). */
export class D1SubscriptionActivationRepository implements SubscriptionActivationRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    now: number,
  ): Promise<SubscriptionActivationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM subscription_activations
          WHERE execution_id = ? AND user_id = ? AND vendor = ? AND expires_at > ?`,
      )
      .bind(executionId, userId, vendor, now)
      .first<SubscriptionActivationRow>()
    return row ? toActivation(row) : null
  }

  async upsert(record: SubscriptionActivationRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO subscription_activations
           (id, execution_id, user_id, vendor, token_cipher, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (execution_id, user_id, vendor) DO UPDATE SET
           token_cipher = excluded.token_cipher,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .bind(
        record.id,
        record.executionId,
        record.userId,
        record.vendor,
        record.tokenCipher,
        record.createdAt,
        record.expiresAt,
      )
      .run()
  }

  async refresh(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    expiresAt: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE subscription_activations SET expires_at = ?
          WHERE execution_id = ? AND user_id = ? AND vendor = ?`,
      )
      .bind(expiresAt, executionId, userId, vendor)
      .run()
  }

  async deleteByExecution(executionId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM subscription_activations WHERE execution_id = ?')
      .bind(executionId)
      .run()
  }

  async deleteExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM subscription_activations WHERE expires_at <= ?')
      .bind(now)
      .run()
    return result.meta.changes ?? 0
  }
}
