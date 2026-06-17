import type { IdGenerator, RateLimitRepository, RateLimitSnapshot } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * D1-backed ledger of observed GitHub rate-limit headers (migration 0004),
 * imitating the token_usage spend ledger. One row per observation; lets us track
 * headroom over time and back off proactively.
 */
export class D1RateLimitRepository implements RateLimitRepository {
  private readonly db: D1Database
  private readonly idGenerator: IdGenerator

  constructor({ db, idGenerator }: { db: D1Database; idGenerator: IdGenerator }) {
    this.db = db
    this.idGenerator = idGenerator
  }

  async record(snapshot: RateLimitSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO github_rate_limits
           (id, installation_id, resource, limit_total, remaining, reset_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.idGenerator.next('grl'),
        snapshot.installationId,
        snapshot.resource,
        snapshot.limit,
        snapshot.remaining,
        snapshot.resetAt,
        snapshot.observedAt,
      )
      .run()
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_gh_ratelimit_observed; this telemetry retains the least.
    const { meta } = await this.db
      .prepare('DELETE FROM github_rate_limits WHERE observed_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}
