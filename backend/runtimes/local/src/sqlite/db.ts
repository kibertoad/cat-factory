import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'

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

/**
 * The constraint a declared row shape must satisfy: every column it names has to be a value
 * `node:sqlite` can actually hand back (`SQLOutputValue`), or `undefined` for a column a
 * conditional SELECT list may omit entirely. Written as a mapped type over `keyof TRow` rather
 * than `Record<string, …>` so an `interface` row shape satisfies it: an interface has no
 * implicit index signature, which is exactly why the callers used to reach for `as unknown as`.
 *
 * It rejects the shapes SQLite can never produce: a `boolean` (stored as `0`/`1`), a nested
 * object or array (a JSON column arrives as `string`), a domain union the driver knows nothing
 * about. Those have to be mapped or decoded from the raw column after the read.
 *
 * Spelled as a homomorphic mapped type rather than `Record<keyof TRow, …>` so it carries each
 * property's `?` modifier through; under `exactOptionalPropertyTypes` a `Record` would turn
 * every column required and reject the conditionally-selected ones.
 */
export type SqliteRow<TRow> = { [K in keyof TRow]: SQLOutputValue | undefined }

/**
 * Run `sql` and map every result row onto the declared `TRow`.
 *
 * `StatementSync.all()` is typed `Record<string, SQLOutputValue>[]`, so every caller
 * previously restated its row shape through a double cast. The narrowing happens HERE, once:
 * the generic bound checks the shape is representable, and the single unchecked step left is
 * the one no type system can make for us: that the SELECT's column names and types match what
 * `TRow` declares. Keeping it in one place is what lets every call site read as a plain typed
 * query.
 */
export function queryAll<TRow extends SqliteRow<TRow>>(
  db: DatabaseSync,
  sql: string,
  ...binds: SQLInputValue[]
): TRow[] {
  return db.prepare(sql).all(...binds) as unknown as TRow[]
}

/**
 * Run `sql` and map the first result row onto `TRow`, or `undefined` when it matched nothing.
 * The `get()` half of {@link queryAll}, with the same contract.
 */
export function queryOne<TRow extends SqliteRow<TRow>>(
  db: DatabaseSync,
  sql: string,
  ...binds: SQLInputValue[]
): TRow | undefined {
  return db.prepare(sql).get(...binds) as unknown as TRow | undefined
}
