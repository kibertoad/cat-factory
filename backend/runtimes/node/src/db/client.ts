import { logger } from '@cat-factory/server'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

// Create a Drizzle client over a node-postgres pool. We use only the core query
// builder (db.select().from(table)), not the relational query API, so no `schema`
// option is passed (that's only needed for db.query.* in drizzle 1.0).
//
// `max` caps the pool size (node-postgres defaults to 10). The whole app — HTTP controllers,
// the durable execution worker (`driveExecution`), and the periodic initiative-loop sweep — shares
// this ONE pool, so under concurrency (many in-flight runs) a small pool serializes their DB work:
// a starved sweep can miss its window and a spawn lands late. Expose it so a busy deployment (and
// the e2e backend, which serves the whole suite from one process) can raise the ceiling.
function makeDbClient(connectionString: string, options?: { max?: number }) {
  const pool = new Pool({
    connectionString,
    ...(options?.max && options.max > 0 ? { max: options.max } : {}),
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
