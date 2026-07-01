import { DatabaseSync } from 'node:sqlite'

// Shared open/init for the mothership-mode local `node:sqlite` stores (the credential store and
// the durable work queue). Both keep only local state on the developer's machine and share the
// same durability pragmas, so the open sequence lives here once.

/**
 * Open (creating if absent) a `node:sqlite` database at `path` and ensure `schema`.
 *
 * WAL keeps the single writer from blocking readers, and the busy timeout absorbs a brief lock
 * contention (e.g. an OS sync) instead of throwing SQLITE_BUSY. `node:sqlite`'s `DatabaseSync` is
 * synchronous and single-process, so a select-then-update in the callers is inherently atomic.
 */
export function openSqliteDb(path: string, schema: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(schema)
  return db
}
