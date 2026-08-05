import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Shared open/init for the local `node:sqlite` stores (mothership mode's credential store,
// settings store and durable work queue; the deployment source-control credential in EITHER local
// topology). All keep only local state on the developer's machine and share the same durability
// pragmas, so the open sequence lives here once.

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

/**
 * Where a local `node:sqlite` store lives: an explicit env override, else `fileName` under
 * `~/.cat-factory` (created on demand). One helper for every local store so a developer finds
 * them all in one directory, and so a test can point a store at `:memory:` through the override.
 */
export function localDbPath(explicit: string | undefined, fileName: string): string {
  const override = explicit?.trim()
  if (override) return override
  const dir = join(homedir(), '.cat-factory')
  mkdirSync(dir, { recursive: true })
  return join(dir, fileName)
}
