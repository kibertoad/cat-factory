import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { adminDatabaseUrl } from '@cat-factory/conformance'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DbClient, createDbClient } from '../src/db/client.js'
import {
  DbSchemaInconsistentError,
  MigrationFailedError,
  explainMigrationFailure,
  migrate,
} from '../src/db/migrate.js'

// The code→message mapping is pure — unit-test it deterministically with synthetic driver
// errors (node-postgres surfaces the pg error as the `cause` of drizzle's wrapper).
describe('explainMigrationFailure', () => {
  it('maps undefined_table (42P01) to a ledger-ahead message + recovery hint', () => {
    const e = explainMigrationFailure({
      cause: { code: '42P01', message: 'relation "accounts" does not exist' },
    })
    expect(e).toBeInstanceOf(MigrationFailedError)
    expect(e.code).toBe('42P01')
    expect(e.message).toMatch(/ledger is ahead/)
    expect(e.message).toMatch(/db:reset/)
  })

  it('surfaces the offending detail for a foreign_key_violation (23503)', () => {
    const e = explainMigrationFailure({
      cause: {
        code: '23503',
        detail: 'Key (user_id)=(usr_x) is not present in table "users".',
      },
    })
    expect(e.code).toBe('23503')
    expect(e.message).toContain('Key (user_id)=(usr_x)')
  })

  it('maps a duplicate object (42P07) to a ledger-behind message', () => {
    const e = explainMigrationFailure({
      cause: { code: '42P07', message: 'relation "x" already exists' },
    })
    expect(e.message).toMatch(/ledger is behind/)
  })

  it('passes an unmapped error message through', () => {
    const e = explainMigrationFailure({ cause: { code: '99999', message: 'boom' } })
    expect(e.message).toContain('boom')
  })
})

// The drift guard runs against real Postgres. Uses a DEDICATED, isolated database (these tests
// DROP SCHEMA public) so they can never corrupt the shared per-worker db other spec files reuse.
const baseUrl = process.env.DATABASE_URL
const workerId = (process.env.VITEST_WORKER_ID ?? '0').replace(/[^a-z0-9_]/gi, '_')
const dbName = `cat_factory_migsafety_${workerId}`

describe.runIf(baseUrl)('migrate() drift guard', () => {
  let client: DbClient
  // Computed in beforeAll, not at describe-body eval time: a skipped `runIf` still executes the
  // describe callback during collection, where `baseUrl` may be undefined.
  let adminUrl: string
  let workerUrl: string

  beforeAll(async () => {
    adminUrl = adminDatabaseUrl(baseUrl as string)
    const u = new URL(baseUrl as string)
    u.pathname = `/${dbName}`
    workerUrl = u.toString()
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${dbName}"`)
    } finally {
      await admin.end()
    }
    client = createDbClient(workerUrl)
  })

  afterAll(async () => {
    await client?.pool.end()
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })

  it('migrates a fresh database cleanly', async () => {
    await expect(migrate(client.db, client.pool)).resolves.toBeUndefined()
    const { rows } = await client.pool.query(`SELECT to_regclass('public.accounts') AS a`)
    expect(rows[0].a).toBeTruthy()
  })

  it('fails fast when the ledger outlives the schema (the reported footgun)', async () => {
    // Reproduce the reported bug: dropping `public` leaves the migrator ledger (in its own
    // `drizzle` schema) claiming everything is applied. The next migrate() must refuse loudly
    // instead of dying with a bare 42P01 deep inside an ALTER.
    await client.pool.query('DROP SCHEMA public CASCADE')
    await client.pool.query('CREATE SCHEMA public')
    await expect(migrate(client.db, client.pool)).rejects.toBeInstanceOf(DbSchemaInconsistentError)
    await expect(migrate(client.db, client.pool)).rejects.toThrow(/db:reset/)
  })
})

// Validates the shared-database seam: relocate the default tables (DB_SCHEMA) AND the migration
// ledger (DB_MIGRATIONS_SCHEMA) off `public`/`drizzle`, and assert NOTHING lands in the defaults.
const schemaDbName = `cat_factory_migschema_${workerId}`

describe.runIf(baseUrl)('migrate() with configured schemas', () => {
  const APP_SCHEMA = 'cf_app'
  const MIG_SCHEMA = 'cf_mig'
  let client: DbClient
  let adminUrl: string

  beforeAll(async () => {
    adminUrl = adminDatabaseUrl(baseUrl as string)
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${schemaDbName}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${schemaDbName}"`)
    } finally {
      await admin.end()
    }
    const workerUrl = (() => {
      const u = new URL(baseUrl as string)
      u.pathname = `/${schemaDbName}`
      return u.toString()
    })()
    // Pool opens with search_path → APP_SCHEMA, so the migrator's unqualified CREATE TABLEs land there.
    client = createDbClient(workerUrl, APP_SCHEMA)
  })

  afterAll(async () => {
    await client?.pool.end()
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${schemaDbName}" WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })

  it('creates app tables in DB_SCHEMA and the ledger in DB_MIGRATIONS_SCHEMA, leaking nothing to public/drizzle', async () => {
    await expect(
      migrate(client.db, client.pool, { schema: APP_SCHEMA, migrationsSchema: MIG_SCHEMA }),
    ).resolves.toBeUndefined()

    const q = async (regclass: string): Promise<unknown> =>
      (await client.pool.query('SELECT to_regclass($1) AS r', [regclass])).rows[0]?.r

    // App tables live in APP_SCHEMA — and NOT in public.
    expect(await q(`${APP_SCHEMA}.accounts`)).toBeTruthy()
    expect(await q('public.accounts')).toBeNull()
    // The ledger lives in MIG_SCHEMA — and NOT in the default `drizzle` schema.
    expect(await q(`${MIG_SCHEMA}.__drizzle_migrations`)).toBeTruthy()
    expect(await q('drizzle.__drizzle_migrations')).toBeNull()
    // The explicitly-namespaced schemas are unaffected by the relocation.
    expect(await q('telemetry.llm_call_metrics')).toBeTruthy()

    // Idempotent re-run is a clean no-op against the configured schemas.
    await expect(
      migrate(client.db, client.pool, { schema: APP_SCHEMA, migrationsSchema: MIG_SCHEMA }),
    ).resolves.toBeUndefined()
  })
})

// db:reset must survive a relocated DB_SCHEMA: `public` is then NOT among the dropped schemas, so
// the trailing `CREATE SCHEMA public` has to be IF-NOT-EXISTS or the whole atomic reset rolls back
// (regression guard for the 42P06 footgun). Runs the real script as a subprocess.
const resetDbName = `cat_factory_reset_${workerId}`
const execFileAsync = promisify(execFile)
const resetScript = fileURLToPath(new URL('../scripts/db-reset.mjs', import.meta.url))

describe.runIf(baseUrl)('db:reset with a relocated DB_SCHEMA', () => {
  const APP_SCHEMA = 'cf_reset_app'
  let adminUrl: string
  let resetUrl: string

  beforeAll(async () => {
    adminUrl = adminDatabaseUrl(baseUrl as string)
    const u = new URL(baseUrl as string)
    u.pathname = `/${resetDbName}`
    resetUrl = u.toString()
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${resetDbName}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${resetDbName}"`)
    } finally {
      await admin.end()
    }
    // Seed a co-tenant-style layout: the app relocated to APP_SCHEMA, `public` present (as another
    // service might own it). db:reset must drop APP_SCHEMA but leave `public` intact.
    const { pool } = createDbClient(resetUrl)
    try {
      await pool.query(`CREATE SCHEMA "${APP_SCHEMA}"`)
      await pool.query(`CREATE TABLE "${APP_SCHEMA}".marker (id int)`)
    } finally {
      await pool.end()
    }
  })

  afterAll(async () => {
    const { pool: admin } = createDbClient(adminUrl)
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${resetDbName}" WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })

  it('exits 0 and drops the relocated schema while leaving public intact', async () => {
    await expect(
      execFileAsync(process.execPath, [resetScript], {
        env: { ...process.env, DATABASE_URL: resetUrl, DB_SCHEMA: APP_SCHEMA },
      }),
    ).resolves.toBeDefined()

    const { pool } = createDbClient(resetUrl)
    try {
      const q = async (name: string): Promise<unknown> =>
        (await pool.query('SELECT to_regnamespace($1) AS r', [name])).rows[0]?.r
      expect(await q(APP_SCHEMA)).toBeNull() // relocated app schema dropped
      expect(await q('public')).toBeTruthy() // public survived (was never ours to drop)
    } finally {
      await pool.end()
    }
  })
})
