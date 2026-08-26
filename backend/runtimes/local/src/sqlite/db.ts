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
 *
 * `schema` is a DECLARATION of the shape the file must have, not a one-time bootstrap: every
 * statement in it is `IF NOT EXISTS`, and {@link addMissingColumns} finishes the job for the one
 * case that phrasing cannot cover on its own — a COLUMN added to a table the file already holds.
 */
export function openSqliteDb(path: string, schema: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(schema)
  addMissingColumns(db, schema, path)
  return db
}

/** One column as SQLite itself describes it (`PRAGMA table_info`). */
interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

/**
 * Bring an EXISTING file up to `schema` by adding the columns it is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so a column added to
 * a shipped schema reaches a fresh database and no other. Every read then names a column the file
 * has never heard of, and `no such column: x` is what a developer sees — from a store whose whole
 * job is to be opened, wordlessly, on someone else's laptop. This has now happened three times over
 * on `llm_call_metrics` alone (`phase`, `turn_index`, `spend_only`), and "delete the file" is not a
 * schema story; it is the absence of one.
 *
 * This is NOT a backwards-compatibility shim (internals here are free to break): it preserves no
 * obsolete shape and reads no old value. It only makes the declaration TOTAL, so `schema` means
 * what it reads as.
 *
 * SQLite is its own parser here: the wanted shape is read from a throwaway `:memory:` database
 * built from the same `schema` string, so nothing has to restate a column definition (a second
 * declaration is how the two would drift) and no regex has to understand SQL.
 *
 * ADDITIVE ONLY, deliberately. A column the file has and the schema no longer declares is left
 * alone, and one whose type or nullability changed is left as it is: rewriting a column means
 * rebuilding the table, which is a data decision this local telemetry/credential state does not
 * earn. A column SQLite cannot add (`NOT NULL` with no default, `UNIQUE`, a primary key) throws
 * naming the table, the column and the file — the store refusing to open on a shape it cannot
 * reach, rather than serving reads that fail one query at a time.
 */
function addMissingColumns(db: DatabaseSync, schema: string, path: string): void {
  const wanted = new DatabaseSync(':memory:')
  try {
    wanted.exec(schema)
    for (const table of tableNames(wanted)) {
      const have = new Set(columnsOf(db, table).map((c) => c.name))
      for (const column of columnsOf(wanted, table)) {
        if (have.has(column.name)) continue
        const notNull = column.notnull ? ' NOT NULL' : ''
        const dflt = column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`
        try {
          db.exec(
            `ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${column.type}${notNull}${dflt}`,
          )
        } catch (cause) {
          throw new Error(
            `local sqlite store ${path}: cannot add column "${column.name}" to the existing ` +
              `table "${table}"`,
            { cause },
          )
        }
      }
    }
  } finally {
    wanted.close()
  }
}

/** The schema's own tables, excluding the ones SQLite keeps for itself. */
function tableNames(db: DatabaseSync): string[] {
  return queryAll<{ name: string }>(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).map((r) => r.name)
}

/**
 * One table's columns, or NONE when the table is absent — which is not an error here: `schema`
 * has already created every table it declares, so a table missing from the file is one SQLite
 * itself declined to describe, and the column loop has nothing to reconcile.
 */
function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  return queryAll<ColumnInfo>(db, `PRAGMA table_info("${table}")`)
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
