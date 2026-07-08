import { DatabaseSync } from 'node:sqlite'

// The mothership-mode LOCAL machine-token cache.
//
// A mothership-mode local node authenticates every `/internal/persistence` call with a
// `machine`-audience token the mothership mints after a whitelisted login (see
// `@cat-factory/server` `mintMachineToken` / `POST /auth/machine-token`). Rather than paste a
// static `LOCAL_MOTHERSHIP_TOKEN`, the node caches the minted token HERE, in a file-based
// `node:sqlite` singleton row, so it survives restarts (product decision 4 in
// docs/initiatives/mothership-mode.md). The RPC client reads the current token per request.
//
// The token is OPAQUE to the node: it is signed with the MOTHERSHIP's session secret (which the
// node does not have), so the node cannot verify it — it only presents it and lets the mothership
// verify. Storing it unencrypted is acceptable: it is a bearer credential with an `exp`, and it
// carries no org data; a local key beside it would add nothing (the same reasoning by which today's
// `LOCAL_MOTHERSHIP_TOKEN` sits in plain env).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_ids TEXT NOT NULL,
  exp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`

/** The cached machine token plus the metadata the SPA / boot path reads for staleness + display. */
interface MachineTokenRecord {
  token: string
  nodeId: string
  userId: string
  accountIds: string[]
  /** Absolute expiry (epoch ms) — the boot path treats a past `exp` as no token. */
  exp: number
  createdAt: number
}

interface MachineTokenRow {
  token: string
  node_id: string
  user_id: string
  account_ids: string
  exp: number
  created_at: number
}

/** Open (creating if absent) the local machine-token SQLite database and ensure its schema. */
function openMachineTokenDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

/** The local machine-token cache: a single-row read/write over the SQLite handle. */
export interface LocalMachineTokenStore {
  /** The cached token, or null if the node has never connected. */
  read(): MachineTokenRecord | null
  /** Replace the cached token (there is always at most one). */
  write(record: MachineTokenRecord): void
  /** Forget the cached token (a disconnect / failed re-login). */
  clear(): void
  close(): void
}

class SqliteMachineTokenStore implements LocalMachineTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  read(): MachineTokenRecord | null {
    const row = this.db
      .prepare(
        'SELECT token, node_id, user_id, account_ids, exp, created_at FROM machine_token WHERE id = 1',
      )
      .get() as MachineTokenRow | undefined
    if (!row) return null
    return {
      token: row.token,
      nodeId: row.node_id,
      userId: row.user_id,
      accountIds: JSON.parse(row.account_ids) as string[],
      exp: row.exp,
      createdAt: row.created_at,
    }
  }

  write(record: MachineTokenRecord): void {
    this.db
      .prepare(
        'INSERT INTO machine_token (id, token, node_id, user_id, account_ids, exp, created_at) ' +
          'VALUES (1, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET token = excluded.token, node_id = excluded.node_id, ' +
          'user_id = excluded.user_id, account_ids = excluded.account_ids, exp = excluded.exp, ' +
          'created_at = excluded.created_at',
      )
      .run(
        record.token,
        record.nodeId,
        record.userId,
        JSON.stringify(record.accountIds),
        record.exp,
        record.createdAt,
      )
  }

  clear(): void {
    this.db.prepare('DELETE FROM machine_token WHERE id = 1').run()
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Open the local machine-token store at `path` (a file under the developer's config dir, or
 * `:memory:` in tests). Holds ONLY the opaque mothership-minted bearer token, never org state.
 */
export function createLocalMachineTokenStore(path: string): LocalMachineTokenStore {
  return new SqliteMachineTokenStore(openMachineTokenDb(path))
}
