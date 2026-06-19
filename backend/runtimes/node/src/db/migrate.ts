import { fileURLToPath } from 'node:url'
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool } from 'pg'
import type { DrizzleDb } from './client.js'

// Apply the drizzle-kit migration lineage in `../drizzle` on boot. The schema's single
// source of truth is `./schema.ts`; `pnpm db:generate` diffs it and emits the next SQL
// migration there. The drizzle migrator records applied migrations in its own
// `__drizzle_migrations` table, so this is safe (and a no-op) on every boot once the DB
// is current, and additive schema changes ship as new migrations rather than silently
// diverging existing databases (the old hand-written `CREATE TABLE IF NOT EXISTS` could
// only ever create, never alter).
//
// The folder ships with the package (package.json `files`), resolved relative to this
// module so it works the same from `dist/db/migrate.js` and from `src` under vitest
// (both are two levels below the package root).
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

// A fixed key for the advisory lock that serialises concurrent boots (see migrate).
const MIGRATION_LOCK_KEY = 776_712_001

/**
 * Run any pending migrations. Safe to call on every boot, including concurrently from
 * multiple replicas: a session-level advisory lock (held on a dedicated connection for
 * the duration of the migrator run) serialises the whole apply, so two replicas booting
 * at once can't both try to create the same objects and collide. The migrator is
 * idempotent against its `__drizzle_migrations` ledger, so the loser of the lock race
 * simply finds nothing to apply.
 */
export async function migrate(db: DrizzleDb, pool: Pool): Promise<void> {
  const lock = await pool.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await drizzleMigrate(db, { migrationsFolder })
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    } finally {
      lock.release()
    }
  }
}
