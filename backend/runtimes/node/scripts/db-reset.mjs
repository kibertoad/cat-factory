// Reset the app database to a clean slate, then let the next boot re-migrate from scratch.
//
//   Usage (run from backend/runtimes/node, or via `pnpm --filter @cat-factory/node-server db:reset`):
//     DATABASE_URL=postgres://… node scripts/db-reset.mjs
//
// WHY THIS EXISTS
// ---------------
// This is the sanctioned recovery for a WEDGED experimental database — most commonly the
// drizzle-kit 1.0 ledger↔schema split: the migrator ledger lives in its own `drizzle`
// schema, so a hand `DROP SCHEMA public CASCADE` (or a stray test run) wipes the tables
// while the ledger keeps claiming every migration is applied. Boot then fails because
// `migrate()` tries to apply the next migration onto tables that no longer exist.
//
// The fix people REACH for (drop `public`) is exactly what causes the split. This script
// does it correctly instead: it drops ALL app-owned schemas TOGETHER — including the
// `drizzle` ledger and pg-boss's `pgboss` schema — so the ledger can never outlive the
// data. The next `pnpm start` re-runs the full lineage from an empty database, and pg-boss
// re-provisions its own schema on `boss.start()`.
//
// This is DESTRUCTIVE and intended for pre-1.0 / experimental installs where losing the
// data is acceptable (backwards compatibility is explicitly a non-goal). It never runs on
// boot; an operator invokes it deliberately.

import { Pool } from 'pg'

// The app-owned schemas: the default table schema (DB_SCHEMA, default `public`), the named
// schemas from src/db/schema.ts (`pgSchema(...)`), the migrator ledger (DB_MIGRATIONS_SCHEMA,
// default `drizzle`), and pg-boss's queue schema (DB_PGBOSS_SCHEMA, default `pgboss`). Dropping
// the ledger alongside the data is the whole point — it guarantees they can't desync. The
// configurable ones must match the server's env so a shared-database deployment resets exactly
// the schemas it owns (and nothing a co-tenant service owns).
// Lowercase-only, mirroring `resolveDbSchema` in src/db/client.ts (see the note there on why
// mixed case is rejected). Keep the two guards in step.
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
function schemaEnv(name, fallback) {
  const value = (process.env[name] || fallback).trim() || fallback
  if (!SCHEMA_IDENTIFIER.test(value)) {
    console.error(`Invalid ${name} "${value}": must be a plain lowercase Postgres identifier.`)
    process.exit(1)
  }
  return value
}
const APP_SCHEMAS = [
  schemaEnv('DB_SCHEMA', 'public'),
  'telemetry',
  'sandbox',
  'provisioning',
  schemaEnv('DB_MIGRATIONS_SCHEMA', 'drizzle'),
  schemaEnv('DB_PGBOSS_SCHEMA', 'pgboss'),
]

function databaseNameOf(connectionString) {
  try {
    // The pathname is `/<dbname>`; decode in case it is URL-escaped.
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, '')) || '(unknown)'
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required (the database to reset).')
    process.exit(1)
  }

  const dbName = databaseNameOf(url)
  console.warn('')
  console.warn('  [destructive] cat-factory db:reset')
  console.warn(`  target database: ${dbName}`)
  console.warn(`  dropping schemas: ${APP_SCHEMAS.join(', ')}`)
  console.warn('  ALL DATA in these schemas will be permanently deleted.')
  console.warn('')

  const pool = new Pool({ connectionString: url })
  try {
    // One statement so it is atomic: either the whole reset lands or none of it does.
    // Always leave a usable `public` behind for the next boot. `IF NOT EXISTS` matters when
    // DB_SCHEMA relocated the app tables off `public`: `public` is then NOT in APP_SCHEMAS (so it
    // was never dropped) and a bare `CREATE SCHEMA "public"` would fail with 42P06, rolling back
    // the whole reset. The relocated DB_SCHEMA itself is re-created by migrate() on next boot.
    const drops = APP_SCHEMAS.map((s) => `DROP SCHEMA IF EXISTS "${s}" CASCADE;`).join('\n')
    await pool.query(`${drops}\nCREATE SCHEMA IF NOT EXISTS "public";`)
    console.warn(`  done. Restart the server (pnpm start) to re-migrate ${dbName} from scratch.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('db:reset failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
