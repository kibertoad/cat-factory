import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'

// Shared open/init for the local `node:sqlite` stores (mothership mode's credential store,
// settings store and durable work queue; the deployment source-control credential in EITHER local
// topology). All keep only local state on the developer's machine and share the same durability
// pragmas, so the open sequence lives here once.

/** How a store declares the tables whose CONTENT it is willing to lose to reach the schema. */
export interface SqliteOpenOptions {
  /**
   * Tables holding only state the deployment can re-create, which are therefore REBUILT (dropped
   * and created afresh) when the file's columns diverge from the declaration, instead of throwing.
   *
   * {@link addMissingColumns} is additive by design, so it covers a column that was ADDED and
   * nothing else. A column that was RENAMED reads to it as an add of the new name (`NOT NULL`
   * with no default, which SQLite refuses on a populated table) plus a leftover `NOT NULL` column
   * no INSERT names again. Either way the store stops opening, on someone else's laptop, over
   * state whose whole lifetime is measured in hours.
   *
   * So it is the STORE that says which tables are worth that, per table, in code: a short-lived
   * credential activation the user re-mints with their password, never a table holding the only
   * copy of anything. What is dropped is stated at the declaration site, and everything else
   * still fails loudly.
   */
  rebuildable?: readonly string[]
}

/**
 * Open (creating if absent) a `node:sqlite` database at `path` and ensure `schema`.
 *
 * WAL keeps the single writer from blocking readers, and the busy timeout absorbs a brief lock
 * contention (e.g. an OS sync) instead of throwing SQLITE_BUSY. `node:sqlite`'s `DatabaseSync` is
 * synchronous and single-process, so a select-then-update in the callers is inherently atomic.
 *
 * `schema` is a DECLARATION of the shape the file must have, not a one-time bootstrap: every
 * statement in it is `IF NOT EXISTS`, and two steps finish the job for the cases that phrasing
 * cannot cover on its own: {@link addMissingColumns} for a COLUMN added to a table the file
 * already holds, and {@link SqliteOpenOptions.rebuildable} for a table whose shape MOVED.
 *
 * SQLite is its own parser for both: the wanted shape is read from a throwaway `:memory:`
 * database built from the same `schema` string, so nothing has to restate a column definition (a
 * second declaration is how the two would drift) and no regex has to understand SQL.
 */
export function openSqliteDb(
  path: string,
  schema: string,
  options: SqliteOpenOptions = {},
): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(schema)
  const wanted = new DatabaseSync(':memory:')
  try {
    wanted.exec(schema)
    rebuildDivergedTables(db, wanted, schema, options.rebuildable ?? [], path)
    addMissingColumns(db, wanted, path)
  } catch (error) {
    // A store that refuses to open must not leave the file open either: on Windows the handle
    // holds a lock, so whoever acts on the message (deleting the file, pointing a test's temp
    // directory elsewhere) is refused too, by an error about permissions that names nothing.
    db.close()
    throw error
  } finally {
    wanted.close()
  }
  return db
}

/**
 * Drop and re-create each {@link SqliteOpenOptions.rebuildable} table whose columns are no longer
 * the ones the schema declares.
 *
 * The test is set EQUALITY, not "is anything missing": a rename is an add and a drop at once, and
 * no comparison can tell it from either half. Equality is also why this needs no per-change
 * decision. A rebuildable table's rows are re-creatable, so the rebuild costs the same whichever
 * way its shape moved, and one code path is worth more here than saving rows nobody asked to keep.
 *
 * The re-create is the SCHEMA re-executed, so the table comes back with its indexes and with no
 * second copy of its definition living here.
 */
function rebuildDivergedTables(
  db: DatabaseSync,
  wanted: DatabaseSync,
  schema: string,
  rebuildable: readonly string[],
  path: string,
): void {
  let dropped = false
  for (const table of rebuildable) {
    const declared = columnsOf(wanted, table).map((c) => c.name)
    if (declared.length === 0) {
      // A name the schema does not declare. Throwing rather than skipping, because the silent
      // reading of a typo here is "this table is never rebuilt", which is the failure the option
      // exists to prevent, arriving later and looking like something else.
      throw new Error(
        `local sqlite store ${path}: "${table}" is listed as rebuildable but the schema ` +
          `declares no such table`,
      )
    }
    const have = columnsOf(db, table).map((c) => c.name)
    if (have.length === 0 || sameColumns(have, declared)) continue
    db.exec(`DROP TABLE "${table}"`)
    dropped = true
  }
  if (dropped) db.exec(schema)
}

/** Whether two column lists name the same set (order is SQLite's business, not a divergence). */
function sameColumns(have: string[], declared: string[]): boolean {
  if (have.length !== declared.length) return false
  const names = new Set(have)
  return declared.every((name) => names.has(name))
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
 * ADDITIVE ONLY, deliberately. A column the file has and the schema no longer declares is left
 * alone, and one whose type or nullability changed is left as it is: rewriting a column means
 * rebuilding the table, which is a data decision only the store can make, and does, per table,
 * through {@link SqliteOpenOptions.rebuildable}. A column SQLite cannot add (`NOT NULL` with no
 * default, `UNIQUE`, a primary key) to a table nobody declared rebuildable throws naming the
 * table, the column and the file: the store refusing to open on a shape it cannot reach, rather
 * than serving reads that fail one query at a time.
 */
function addMissingColumns(db: DatabaseSync, wanted: DatabaseSync, path: string): void {
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
