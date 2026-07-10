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

// The drizzle-kit 1.0 migrator records applied migrations in this table (its own `drizzle`
// schema, NOT `public`). Crucially, a `DROP SCHEMA public CASCADE` leaves this ledger
// intact, so the ledger can outlive the very tables it claims to have created — see
// `assertSchemaConsistent`.
const LEDGER = 'drizzle.__drizzle_migrations'

// Tables that MUST exist once the baseline migration is recorded as applied. If the ledger
// is non-empty but these are gone, the database is in the split state described above and
// cannot be migrated forward (the next `ALTER TABLE`/FK migration would fail with a bare
// `42P01`). We probe a couple of stable, early-created anchors rather than the full set.
const ANCHOR_TABLES = ['public.accounts', 'public.workspaces'] as const

const RESET_HINT =
  'Recover with `pnpm --filter @cat-factory/node-server db:reset` ' +
  '(experimental installs only — this DROPS ALL DATA), then restart.'

/**
 * The database's recorded migration history disagrees with its actual schema: the migrator
 * ledger says migrations were applied, but the tables they create are missing. This is the
 * classic drizzle-kit 1.0 footgun — the ledger lives in the `drizzle` schema, so dropping
 * `public` (a hand `DROP SCHEMA public CASCADE`, a stray test run) leaves the ledger behind
 * claiming everything is current. `migrate()` then tries to apply the next migration onto
 * tables that no longer exist and dies with an opaque `42P01`. We detect it up front and
 * fail with an actionable message instead.
 */
export class DbSchemaInconsistentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbSchemaInconsistentError'
  }
}

/** A migration failed to apply. Wraps the raw driver error with a human cause + recovery hint. */
export class MigrationFailedError extends Error {
  readonly code: string | undefined
  constructor(message: string, options: { cause: unknown; code: string | undefined }) {
    super(message, { cause: options.cause })
    this.name = 'MigrationFailedError'
    this.code = options.code
  }
}

interface PgError {
  code?: string
  detail?: string
  where?: string
  message?: string
}

function asPgError(err: unknown): PgError {
  // node-postgres surfaces the driver error as the `cause` of drizzle's wrapper; fall back
  // to the error itself so we read the pg code/detail whichever layer carries it.
  const cause = (err as { cause?: unknown })?.cause
  const candidate = (cause && typeof cause === 'object' ? cause : err) as PgError
  return candidate ?? {}
}

/**
 * Guard against the ledger↔schema split BEFORE handing off to the migrator. Skips silently
 * on a fresh database (no ledger table, or an empty ledger) — there is nothing to apply
 * onto yet, so a missing `public.accounts` is expected and the migrator will create it.
 */
async function assertSchemaConsistent(pool: Pool): Promise<void> {
  const ledgerExists = await pool.query(`SELECT to_regclass('${LEDGER}') AS reg`)
  if (!ledgerExists.rows[0]?.reg) return // fresh DB: migrator will bootstrap the ledger + tables

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${LEDGER}`)
  const applied = rows[0]?.n ?? 0
  if (applied === 0) return // ledger present but empty — still a clean slate

  const anchors = await pool.query(
    `SELECT ${ANCHOR_TABLES.map((t, i) => `to_regclass('${t}') AS a${i}`).join(', ')}`,
  )
  const missing = ANCHOR_TABLES.filter((_, i) => !anchors.rows[0]?.[`a${i}`])
  if (missing.length === 0) return

  throw new DbSchemaInconsistentError(
    `Database is inconsistent: the migration ledger (${LEDGER}) records ${applied} applied ` +
      `migration(s) but expected table(s) ${missing.join(', ')} are missing. This usually means ` +
      `the ledger's own \`drizzle\` schema survived a \`DROP SCHEMA public CASCADE\` (or a stray ` +
      `test run), leaving the recorded history ahead of the actual schema. The database cannot be ` +
      `migrated forward in this state. ${RESET_HINT}`,
  )
}

/**
 * Turn a raw migration failure into a `MigrationFailedError` with a mapped, actionable cause.
 * Exported for unit testing the code→message mapping without a live database.
 */
export function explainMigrationFailure(err: unknown): MigrationFailedError {
  const pg = asPgError(err)
  const where = pg.where ? ` (at: ${pg.where})` : ''
  let cause: string
  switch (pg.code) {
    case '42P01': // undefined_table
      cause =
        `a migration referenced a table that does not exist (${pg.message ?? 'undefined table'}). ` +
        `The migration ledger is ahead of the actual schema — a partial or manual reset. ${RESET_HINT}`
      break
    case '23503': // foreign_key_violation
      cause =
        `existing rows violate a constraint a migration adds: ${pg.detail ?? pg.message ?? 'foreign key violation'}. ` +
        `For experimental installs, ${RESET_HINT} Otherwise, remove the offending row(s) named above and retry.`
      break
    case '42P07': // duplicate_table
    case '42710': // duplicate_object
      cause =
        `a migration tried to create an object that already exists (${pg.message ?? 'duplicate object'}). ` +
        `The migration ledger is behind the actual schema. ${RESET_HINT}`
      break
    default:
      cause = pg.message ?? String(err)
  }
  return new MigrationFailedError(
    `Database migration failed${pg.code ? ` [${pg.code}]` : ''}${where}: ${cause}`,
    { cause: err, code: pg.code },
  )
}

/**
 * Run any pending migrations. Safe to call on every boot, including concurrently from
 * multiple replicas: a session-level advisory lock (held on a dedicated connection for
 * the duration of the migrator run) serialises the whole apply, so two replicas booting
 * at once can't both try to create the same objects and collide. The migrator is
 * idempotent against its `__drizzle_migrations` ledger, so the loser of the lock race
 * simply finds nothing to apply.
 *
 * Before applying, we probe for the ledger↔schema split (see {@link assertSchemaConsistent})
 * and, on any apply failure, rethrow a {@link MigrationFailedError} whose message names the
 * likely cause and the recovery path — so a wedged DB reports what to do instead of a bare
 * Postgres error deep inside an `ALTER TABLE`.
 */
export async function migrate(db: DrizzleDb, pool: Pool): Promise<void> {
  const lock = await pool.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await assertSchemaConsistent(pool)
    try {
      await drizzleMigrate(db, { migrationsFolder })
    } catch (err) {
      throw explainMigrationFailure(err)
    }
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    } finally {
      lock.release()
    }
  }
}
