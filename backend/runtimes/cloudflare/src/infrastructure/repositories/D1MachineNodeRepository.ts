import type {
  MachineNodeMint,
  MachineNodeMintOutcome,
  MachineNodeRecord,
  MachineNodeRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface MachineNodeRow {
  node_id: string
  user_id: string
  account_ids: string
  created_at: number
  last_minted_at: number
  expires_at: number
  revoked_at: number | null
  revoked_by: string | null
}

function toRecord(row: MachineNodeRow): MachineNodeRecord {
  return {
    nodeId: row.node_id,
    userId: row.user_id,
    accountIds: JSON.parse(row.account_ids) as string[],
    createdAt: row.created_at,
    lastMintedAt: row.last_minted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by,
  }
}

/** D1 machine-node roster + revocation tombstones (SEC-5). Mirror of the Drizzle repo. */
export class D1MachineNodeRepository implements MachineNodeRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async recordMint(mint: MachineNodeMint): Promise<MachineNodeMintOutcome> {
    // The upsert refreshes only the mint-shaped columns: `user_id`, `created_at` and the
    // revocation tombstone never change here. `MAX` keeps `expires_at` the latest exp ever
    // signed, so a shorter re-mint cannot make the roster forget a longer token.
    //
    // The `WHERE` on the conflict branch is what makes ownership atomic rather than
    // check-then-write: a concurrent first mint of the same node id by another user updates
    // nothing instead of stamping its scope onto the winner's row.
    const result = await this.db
      .prepare(
        `INSERT INTO machine_nodes
           (node_id, user_id, account_ids, created_at, last_minted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           account_ids = excluded.account_ids,
           last_minted_at = excluded.last_minted_at,
           expires_at = MAX(machine_nodes.expires_at, excluded.expires_at)
         WHERE machine_nodes.user_id = excluded.user_id
           AND machine_nodes.revoked_at IS NULL`,
      )
      .bind(
        mint.nodeId,
        mint.userId,
        JSON.stringify(mint.accountIds),
        mint.mintedAt,
        mint.mintedAt,
        mint.expiresAt,
      )
      .run()
    // A guarded no-op and a successful refresh are both "no error", so the write count is
    // the only thing that distinguishes them.
    return (result.meta.changes ?? 0) > 0 ? 'recorded' : 'refused'
  }

  async get(nodeId: string): Promise<MachineNodeRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM machine_nodes WHERE node_id = ?')
      .bind(nodeId)
      .first<MachineNodeRow>()
    return row ? toRecord(row) : null
  }

  async listByUser(userId: string): Promise<MachineNodeRecord[]> {
    const result = await this.db
      .prepare('SELECT * FROM machine_nodes WHERE user_id = ? ORDER BY last_minted_at DESC')
      .bind(userId)
      .all<MachineNodeRow>()
    return (result.results ?? []).map(toRecord)
  }

  async revoke(nodeId: string, revokedAt: number, revokedByUserId: string): Promise<boolean> {
    // Idempotent kill switch: only the FIRST revocation writes (the tombstone keeps its
    // original timestamp/actor), but re-revoking an already-revoked node still reports true.
    const result = await this.db
      .prepare(
        'UPDATE machine_nodes SET revoked_at = ?, revoked_by = ? WHERE node_id = ? AND revoked_at IS NULL',
      )
      .bind(revokedAt, revokedByUserId, nodeId)
      .run()
    if ((result.meta.changes ?? 0) > 0) return true
    return (await this.get(nodeId)) !== null
  }

  async isRevoked(nodeId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT revoked_at FROM machine_nodes WHERE node_id = ?')
      .bind(nodeId)
      .first<{ revoked_at: number | null }>()
    return row?.revoked_at != null
  }

  async deleteExpired(before: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM machine_nodes WHERE expires_at < ?')
      .bind(before)
      .run()
    return result.meta.changes ?? 0
  }
}
