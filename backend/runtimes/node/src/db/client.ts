import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

// Create a Drizzle client over a node-postgres pool. We use only the core query
// builder (db.select().from(table)), not the relational query API, so no `schema`
// option is passed (that's only needed for db.query.* in drizzle 1.0).
function makeDbClient(connectionString: string) {
  const pool = new Pool({ connectionString })
  const db = drizzle({ client: pool })
  return { db, pool }
}

/** A connected Drizzle/Postgres client plus the underlying pool (for shutdown). */
export type DbClient = ReturnType<typeof makeDbClient>
export type DrizzleDb = DbClient['db']

export const createDbClient = makeDbClient
