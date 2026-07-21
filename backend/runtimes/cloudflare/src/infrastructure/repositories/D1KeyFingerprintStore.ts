import type { KeyFingerprintStore } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/** The fixed singleton-row id for the deployment's key fingerprint (ADR 0026 D6.1). */
const KEY_FINGERPRINT_ID = 'key'

interface KeyFingerprintRow {
  id: string
  fingerprint: string
  created_at: number
}

/**
 * D1-backed store for the deployment's master-key fingerprint (ADR 0026 D6.1; migration
 * `key_fingerprint`). A single row keyed by a fixed id; seeded once on first boot and never
 * overwritten thereafter, so the boot check can detect ENCRYPTION_KEY drift.
 */
export class D1KeyFingerprintStore implements KeyFingerprintStore {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT * FROM key_fingerprint WHERE id = ?')
      .bind(KEY_FINGERPRINT_ID)
      .first<KeyFingerprintRow>()
    return row?.fingerprint ?? null
  }

  async set(fingerprint: string): Promise<void> {
    // Seed-once: `DO NOTHING` on conflict so an existing (possibly-mismatching) value is
    // never clobbered — the stored fingerprint must stay pinned to what secrets were sealed
    // under for the boot check to work.
    await this.db
      .prepare(
        `INSERT INTO key_fingerprint (id, fingerprint, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(KEY_FINGERPRINT_ID, fingerprint, Date.now())
      .run()
  }
}
