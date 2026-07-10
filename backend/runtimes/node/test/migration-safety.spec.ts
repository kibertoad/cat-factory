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
  const adminUrl = adminDatabaseUrl(baseUrl as string)
  const workerUrl = (() => {
    const u = new URL(baseUrl as string)
    u.pathname = `/${dbName}`
    return u.toString()
  })()

  beforeAll(async () => {
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
