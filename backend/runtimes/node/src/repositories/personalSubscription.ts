import type {
  PersonalSubscriptionRecord,
  PersonalSubscriptionRepository,
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { and, asc, eq, gt, gte, isNull, lte, ne } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { personalSubscriptions, subscriptionActivations } from '../db/schema.js'

// Postgres-backed stores for individual-usage subscriptions + per-run activations
// (mirror of D1 migration 0039 / D1PersonalSubscriptionRepository), column-for-column
// so behaviour matches across stores.

type SubRow = typeof personalSubscriptions.$inferSelect

function toRecord(row: SubRow): PersonalSubscriptionRecord {
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

export class DrizzlePersonalSubscriptionRepository implements PersonalSubscriptionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByUserVendor(
    userId: number,
    vendor: SubscriptionVendor,
  ): Promise<PersonalSubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(personalSubscriptions)
      .where(
        and(
          eq(personalSubscriptions.user_id, userId),
          eq(personalSubscriptions.vendor, vendor),
          isNull(personalSubscriptions.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listByUser(userId: number): Promise<PersonalSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(personalSubscriptions)
      .where(
        and(eq(personalSubscriptions.user_id, userId), isNull(personalSubscriptions.deleted_at)),
      )
      .orderBy(asc(personalSubscriptions.created_at))
    return rows.map(toRecord)
  }

  async upsert(record: PersonalSubscriptionRecord): Promise<void> {
    // One live row per user+vendor: tombstone any other live row, then upsert by id.
    await this.db
      .update(personalSubscriptions)
      .set({ deleted_at: record.updatedAt })
      .where(
        and(
          eq(personalSubscriptions.user_id, record.userId),
          eq(personalSubscriptions.vendor, record.vendor),
          isNull(personalSubscriptions.deleted_at),
          ne(personalSubscriptions.id, record.id),
        ),
      )
    await this.db
      .insert(personalSubscriptions)
      .values({
        id: record.id,
        user_id: record.userId,
        vendor: record.vendor,
        label: record.label,
        token_cipher: record.tokenCipher,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        last_used_at: record.lastUsedAt,
        deleted_at: null,
      })
      .onConflictDoUpdate({
        target: personalSubscriptions.id,
        set: {
          label: record.label,
          token_cipher: record.tokenCipher,
          expires_at: record.expiresAt,
          updated_at: record.updatedAt,
          deleted_at: null,
        },
      })
  }

  async markUsed(userId: number, vendor: SubscriptionVendor, at: number): Promise<void> {
    await this.db
      .update(personalSubscriptions)
      .set({ last_used_at: at })
      .where(
        and(
          eq(personalSubscriptions.user_id, userId),
          eq(personalSubscriptions.vendor, vendor),
          isNull(personalSubscriptions.deleted_at),
        ),
      )
  }

  async softDelete(userId: number, vendor: SubscriptionVendor, at: number): Promise<void> {
    await this.db
      .update(personalSubscriptions)
      .set({ deleted_at: at })
      .where(
        and(
          eq(personalSubscriptions.user_id, userId),
          eq(personalSubscriptions.vendor, vendor),
          isNull(personalSubscriptions.deleted_at),
        ),
      )
  }

  async listExpiring(now: number, before: number): Promise<PersonalSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(personalSubscriptions)
      .where(
        and(
          isNull(personalSubscriptions.deleted_at),
          gte(personalSubscriptions.expires_at, now),
          lte(personalSubscriptions.expires_at, before),
        ),
      )
      .orderBy(asc(personalSubscriptions.expires_at))
    return rows.map(toRecord)
  }
}

type ActRow = typeof subscriptionActivations.$inferSelect

function toActivation(row: ActRow): SubscriptionActivationRecord {
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

export class DrizzleSubscriptionActivationRepository
  implements SubscriptionActivationRepository
{
  constructor(private readonly db: DrizzleDb) {}

  async get(
    executionId: string,
    userId: number,
    vendor: SubscriptionVendor,
    now: number,
  ): Promise<SubscriptionActivationRecord | null> {
    const rows = await this.db
      .select()
      .from(subscriptionActivations)
      .where(
        and(
          eq(subscriptionActivations.execution_id, executionId),
          eq(subscriptionActivations.user_id, userId),
          eq(subscriptionActivations.vendor, vendor),
          gt(subscriptionActivations.expires_at, now),
        ),
      )
      .limit(1)
    return rows[0] ? toActivation(rows[0]) : null
  }

  async upsert(record: SubscriptionActivationRecord): Promise<void> {
    await this.db
      .insert(subscriptionActivations)
      .values({
        id: record.id,
        execution_id: record.executionId,
        user_id: record.userId,
        vendor: record.vendor,
        token_cipher: record.tokenCipher,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
      })
      .onConflictDoUpdate({
        // Matches the (execution_id, user_id, vendor) unique index.
        target: [
          subscriptionActivations.execution_id,
          subscriptionActivations.user_id,
          subscriptionActivations.vendor,
        ],
        set: {
          token_cipher: record.tokenCipher,
          created_at: record.createdAt,
          expires_at: record.expiresAt,
        },
      })
  }

  async refresh(
    executionId: string,
    userId: number,
    vendor: SubscriptionVendor,
    expiresAt: number,
  ): Promise<void> {
    await this.db
      .update(subscriptionActivations)
      .set({ expires_at: expiresAt })
      .where(
        and(
          eq(subscriptionActivations.execution_id, executionId),
          eq(subscriptionActivations.user_id, userId),
          eq(subscriptionActivations.vendor, vendor),
        ),
      )
  }

  async deleteByExecution(executionId: string): Promise<void> {
    await this.db
      .delete(subscriptionActivations)
      .where(eq(subscriptionActivations.execution_id, executionId))
  }

  async deleteExpired(now: number): Promise<number> {
    const deleted = await this.db
      .delete(subscriptionActivations)
      .where(lte(subscriptionActivations.expires_at, now))
      .returning({ id: subscriptionActivations.id })
    return deleted.length
  }
}
