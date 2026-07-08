import type { DatabaseSync } from 'node:sqlite'
import type { LocalSettingsRecord, LocalSettingsRepository } from '@cat-factory/kernel'
import { openSqliteDb } from './db.js'

// The mothership-mode LOCAL settings store.
//
// The local-mode operational settings (warm-pool sizing + per-repo checkout reuse for the local
// container runner) are a per-DEPLOYMENT singleton — one developer's machine, so exactly one row.
// In the standard siloed-Postgres local mode they live in the `local_settings` Postgres table
// (`DrizzleLocalSettingsRepository`); in mothership mode there is no local Postgres, but they are
// NOT org state either — they configure the local Docker runner, which is the local facade's own
// differentiator — so they belong on the laptop, NOT the mothership. This module is their
// no-Postgres home: a file-based `node:sqlite` singleton mirroring the Drizzle repo's behaviour
// (one row, addressed by a fixed key; a missing row means "all defaults"). Non-secret config, so
// unlike the credential store it seals nothing.
//
// Kept in its own store (not the credential store) so that store's "ONLY credentials" invariant
// holds — this is operational config, not a credential. `DatabaseSync` is synchronous, so the
// port's async methods execute synchronously here.

/** The fixed key for the local-mode settings singleton row (one developer's machine). */
const LOCAL_SETTINGS_ID = 'local'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_settings (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

interface LocalSettingsRow {
  config: string
  created_at: number
  updated_at: number
}

/** Open (creating if absent) the local-settings SQLite database and ensure its schema. */
function openLocalSettingsDb(path: string): DatabaseSync {
  return openSqliteDb(path, SCHEMA)
}

/**
 * The local-mode operational settings singleton over `node:sqlite` — the local-sqlite mirror of
 * `DrizzleLocalSettingsRepository` (one row, fixed id, createdAt-preserving upsert).
 */
class SqliteLocalSettingsRepository implements LocalSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  async get(): Promise<LocalSettingsRecord | null> {
    const row = this.db
      .prepare('SELECT config, created_at, updated_at FROM local_settings WHERE id = ?')
      .get(LOCAL_SETTINGS_ID) as unknown as LocalSettingsRow | undefined
    if (!row) return null
    return { config: row.config, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  async upsert(record: LocalSettingsRecord): Promise<void> {
    // Preserve the original `created_at` on conflict (only `config`/`updated_at` change), exactly
    // like the Drizzle repo.
    this.db
      .prepare(
        `INSERT INTO local_settings (id, config, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(LOCAL_SETTINGS_ID, record.config, record.createdAt, record.updatedAt)
  }
}

/** The local-sqlite settings repository plus a handle to close the underlying db. */
export interface LocalSettingsStore {
  localSettingsRepository: LocalSettingsRepository
  close(): void
}

/**
 * Open the local-settings store at `path` (a file under the developer's config dir, or
 * `:memory:` in tests). Holds ONLY the non-secret local-mode operational config, never org state.
 */
export function createLocalSettingsStore(path: string): LocalSettingsStore {
  const db = openLocalSettingsDb(path)
  return {
    localSettingsRepository: new SqliteLocalSettingsRepository(db),
    close: () => db.close(),
  }
}
