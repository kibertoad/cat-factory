import type { DirectoryWebhookRecord, DirectoryWebhookRepository } from '@cat-factory/kernel'
import { and, asc, count, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { directoryWebhooks } from '../db/schema.js'

// Directory webhook endpoints over Postgres. Mirror of the Cloudflare facade's
// `D1DirectoryWebhookRepository`; `defineDirectoryWebhookSuite` holds the two to one behaviour.

/** Advisory-lock class for the per-account endpoint cap; the second key is the account. */
const DIRECTORY_WEBHOOK_CAP_LOCK_CLASS = 0x6477_6863

type Row = typeof directoryWebhooks.$inferSelect

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

export class DrizzleDirectoryWebhookRepository implements DirectoryWebhookRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(accountId: string): Promise<DirectoryWebhookRecord[]> {
    const rows = await this.db
      .select()
      .from(directoryWebhooks)
      .where(eq(directoryWebhooks.account_id, accountId))
      .orderBy(asc(directoryWebhooks.id))
    return rows.map(toRecord)
  }

  async get(accountId: string, id: string): Promise<DirectoryWebhookRecord | null> {
    const [row] = await this.db
      .select()
      .from(directoryWebhooks)
      .where(and(eq(directoryWebhooks.account_id, accountId), eq(directoryWebhooks.id, id)))
    return row ? toRecord(row) : null
  }

  async put(record: DirectoryWebhookRecord, limit: number): Promise<'stored' | 'limit_reached'> {
    // At READ COMMITTED there is no row yet to lock, so two registrations counting nine would both
    // insert. Writes for one account are serialized on a transaction-scoped advisory lock instead,
    // the same shape the notification webhook cap uses.
    return await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${DIRECTORY_WEBHOOK_CAP_LOCK_CLASS}, hashtext(${record.accountId}))`,
      )
      const [existing] = await tx
        .select({ id: directoryWebhooks.id })
        .from(directoryWebhooks)
        .where(
          and(
            eq(directoryWebhooks.account_id, record.accountId),
            eq(directoryWebhooks.id, record.id),
          ),
        )
      if (!existing) {
        const [counted] = await tx
          .select({ total: count() })
          .from(directoryWebhooks)
          .where(eq(directoryWebhooks.account_id, record.accountId))
        if ((counted?.total ?? 0) >= limit) return 'limit_reached'
      }
      const editable = {
        url: record.url,
        enabled: record.enabled ? 1 : 0,
        secret_sealed: record.secretSealed,
        updated_at: record.updatedAt,
      }
      await tx
        .insert(directoryWebhooks)
        .values({
          account_id: record.accountId,
          id: record.id,
          delivered_seq: record.deliveredSeq,
          ...editable,
        })
        .onConflictDoUpdate({
          target: [directoryWebhooks.account_id, directoryWebhooks.id],
          set: editable,
        })
      return 'stored'
    })
  }

  async delete(accountId: string, id: string): Promise<void> {
    await this.db
      .delete(directoryWebhooks)
      .where(and(eq(directoryWebhooks.account_id, accountId), eq(directoryWebhooks.id, id)))
  }

  async listEnabled(): Promise<DirectoryWebhookRecord[]> {
    const rows = await this.db
      .select()
      .from(directoryWebhooks)
      .where(eq(directoryWebhooks.enabled, 1))
      .orderBy(asc(directoryWebhooks.account_id), asc(directoryWebhooks.id))
    return rows.map(toRecord)
  }

  async claim(
    accountId: string,
    id: string,
    token: string,
    now: number,
    leaseUntil: number,
  ): Promise<number | null> {
    const [row] = await this.db
      .update(directoryWebhooks)
      .set({ lease_token: token, lease_until: leaseUntil })
      .where(
        and(
          eq(directoryWebhooks.account_id, accountId),
          eq(directoryWebhooks.id, id),
          eq(directoryWebhooks.enabled, 1),
          or(isNull(directoryWebhooks.lease_until), lte(directoryWebhooks.lease_until, now)),
        ),
      )
      .returning({ deliveredSeq: directoryWebhooks.delivered_seq })
    return row ? row.deliveredSeq : null
  }

  async complete(accountId: string, id: string, token: string, toSeq: number): Promise<boolean> {
    const moved = await this.db
      .update(directoryWebhooks)
      .set({ delivered_seq: toSeq, lease_token: null, lease_until: null })
      .where(this.heldBy(accountId, id, token))
      .returning({ id: directoryWebhooks.id })
    return moved.length > 0
  }

  async release(accountId: string, id: string, token: string): Promise<void> {
    await this.db
      .update(directoryWebhooks)
      .set({ lease_token: null, lease_until: null })
      .where(this.heldBy(accountId, id, token))
  }

  private heldBy(accountId: string, id: string, token: string) {
    return and(
      eq(directoryWebhooks.account_id, accountId),
      eq(directoryWebhooks.id, id),
      eq(directoryWebhooks.lease_token, token),
    )
  }
}
