import { DOCS, ENV_VARS_ANCHORS, configProblem, logger } from '@cat-factory/server'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

/** The default Postgres schema the app's (unqualified) tables live in. */
export const DEFAULT_DB_SCHEMA = 'public'
/** The default schema for the drizzle migration ledger (`__drizzle_migrations`). */
export const DEFAULT_MIGRATIONS_SCHEMA = 'drizzle'

// Postgres identifier guard for the configurable schemas. Schema names are interpolated into
// SQL that is NOT parameterizable (the libpq `options=-c search_path=…` connection string and
// `CREATE SCHEMA`/`to_regclass` DDL), so we restrict them to a plain identifier to keep them
// injection-safe. Lowercase only, deliberately: we quote the name in `CREATE SCHEMA "x"` (case
// preserving) but the libpq `search_path` option is unquoted (Postgres folds it to lowercase),
// so a mixed-case name would create one schema and point the connection at a differently-cased
// one. Restricting to lowercase keeps the two in step. (Mirrored in scripts/db-reset.mjs.)
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * Validate + normalise a configured schema name, falling back to `fallback` when unset.
 * `label` names the env var in the error so a bad value is actionable.
 */
export function resolveDbSchema(
  schema: string | undefined,
  fallback: string = DEFAULT_DB_SCHEMA,
  label = 'DB_SCHEMA',
): string {
  const value = schema?.trim()
  if (!value) return fallback
  if (!SCHEMA_IDENTIFIER.test(value)) {
    // A ConfigValidationError (not a bare Error) so this reaches the misconfigured fallback screen
    // at boot — `resolveDbSchema` runs inside the boot try/catch (createDbClient + migrate) — rather
    // than hard-crashing the process with an opaque message the operator can't act on.
    throw configProblem({
      key: label,
      summary: `${label} is interpolated into non-parameterizable SQL (the connection search_path and schema DDL), so it must be a plain lowercase Postgres identifier — the value "${value}" is not.`,
      remedy: `Set ${label} to a plain lowercase identifier matching [a-z_][a-z0-9_]* (lowercase letters, digits, underscores; not starting with a digit), or unset it to use the default "${fallback}".`,
      docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.coreServiceNetworking),
    })
  }
  return value
}

// Create a Drizzle client over a node-postgres pool. We use only the core query
// builder (db.select().from(table)), not the relational query API, so no `schema`
// option is passed (that's only needed for db.query.* in drizzle 1.0).
//
// When `schema` is a non-default value, every connection in the pool is opened with its
// `search_path` set to it, so the unqualified table refs the app + migrations use resolve
// there instead of `public` — the seam for deployments where the `public` schema is
// unavailable. The explicitly-namespaced schemas (`telemetry`/`sandbox`/`provisioning`) are
// always qualified, so they are unaffected.
function makeDbClient(connectionString: string, schema?: string) {
  const resolved = resolveDbSchema(schema)
  const pool = new Pool({
    connectionString,
    // Only override search_path off the default: a stock `public` deployment keeps the exact
    // prior behaviour (no connection options set). We keep `public` on the path as a fallback so
    // shared objects (extensions, types installed there) still resolve; a non-existent `public`
    // in search_path is silently ignored by Postgres, so this is safe even where `public` was the
    // reason to relocate. `resolved` is first, so the migrator's unqualified CREATEs land there.
    ...(resolved === DEFAULT_DB_SCHEMA ? {} : { options: `-c search_path=${resolved},public` }),
  })
  // node-postgres emits 'error' on an IDLE client when the backend drops the
  // connection (Postgres restart, failover, idle timeout). An unhandled 'error' on
  // the pool's EventEmitter would throw and crash the whole process — defeating the
  // graceful shutdown in start(). Log and swallow it; the pool transparently opens a
  // fresh connection on the next query.
  pool.on('error', (err) => {
    logger.error({ err: err.message }, 'postgres idle client error')
  })
  const db = drizzle({ client: pool })
  return { db, pool }
}

/** A connected Drizzle/Postgres client plus the underlying pool (for shutdown). */
export type DbClient = ReturnType<typeof makeDbClient>
export type DrizzleDb = DbClient['db']

export const createDbClient = makeDbClient
