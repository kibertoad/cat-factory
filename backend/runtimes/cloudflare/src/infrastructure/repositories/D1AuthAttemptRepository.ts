import type { AuthAttemptRecord, AuthAttemptRepository, IdGenerator } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/** D1 auth-attempt ledger for the password-endpoint throttle (SEC-4). Mirror of the Drizzle repo. */
export class D1AuthAttemptRepository implements AuthAttemptRepository {
  private readonly db: D1Database
  private readonly idGenerator: IdGenerator

  constructor({ db, idGenerator }: { db: D1Database; idGenerator: IdGenerator }) {
    this.db = db
    this.idGenerator = idGenerator
  }

  async record(attempt: AuthAttemptRecord): Promise<void> {
    await this.db
      .prepare('INSERT INTO auth_attempts (id, key, ip, at) VALUES (?, ?, ?, ?)')
      .bind(this.idGenerator.next('atmpt'), attempt.key, attempt.ip, attempt.at)
      .run()
  }

  async countByKeySince(key: string, sinceMs: number): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at >= ?')
      .bind(key, sinceMs)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async countByIpSince(ip: string, sinceMs: number): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND at >= ?')
      .bind(ip, sinceMs)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM auth_attempts WHERE at < ?')
      .bind(epochMs)
      .run()
    return result.meta.changes ?? 0
  }
}
