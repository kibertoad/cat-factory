// The machine-node roster: one row per `nodeId` a mothership has minted a machine token
// for, with a revocation tombstone (SEC-5 / security-hardening item 8). The roster exists
// because revocation needs OWNERSHIP: without a server-side record of who a node was
// minted for, a revoke endpoint either trusts a caller-supplied nodeId (any user could
// kill any other tenant's satellite) or cannot exist. Recording the mint is what makes
// "revoke MY node" checkable.

/** One minted machine node, with its revocation state. */
export interface MachineNodeRecord {
  /** The node id signed into every machine token minted for this node (`node_*`). */
  nodeId: string
  /** The user the node was minted for; the only identity allowed to revoke it. */
  userId: string
  /** The account scope of the most recent mint. */
  accountIds: string[]
  /** Epoch ms of the first mint. */
  createdAt: number
  /** Epoch ms of the most recent mint. */
  lastMintedAt: number
  /**
   * The latest `exp` across this node's mints. Past it no token for the node can verify
   * (the signature check enforces `exp` on its own), so the row is prunable.
   */
  expiresAt: number
  /** Epoch ms the node was revoked, or null while live. A tombstone, never cleared. */
  revokedAt: number | null
  /** Who revoked it (audit); null while live. */
  revokedByUserId: string | null
}

/** A mint event to fold into the roster. */
export interface MachineNodeMint {
  nodeId: string
  userId: string
  accountIds: string[]
  mintedAt: number
  /** The signed token's `exp`. */
  expiresAt: number
}

/**
 * Persistence for the machine-node roster. The revocation read (`isRevoked`) sits on
 * every `/internal/*` machine call, so implementations keep it a single indexed point
 * read. Callers guard ownership and revocation BEFORE `recordMint` (the upsert itself
 * never changes `userId`, `createdAt` or the revocation columns).
 */
export interface MachineNodeRepository {
  /** Fold a mint into the roster: insert, or refresh `lastMintedAt`/`expiresAt`/`accountIds`. */
  recordMint(mint: MachineNodeMint): Promise<void>
  /** The roster row for a node, or null when unknown. */
  get(nodeId: string): Promise<MachineNodeRecord | null>
  /** Every node minted for a user, newest mint first. */
  listByUser(userId: string): Promise<MachineNodeRecord[]>
  /**
   * Tombstone a node. Returns false when the node is unknown; revoking an
   * already-revoked node is a no-op that returns true (idempotent kill switch).
   */
  revoke(nodeId: string, revokedAt: number, revokedByUserId: string): Promise<boolean>
  /** The per-request gate read: true only for an explicitly revoked node. */
  isRevoked(nodeId: string): Promise<boolean>
  /** Retention: purge rows whose `expiresAt` is before `before`; returns the count removed. */
  deleteExpired(before: number): Promise<number>
}
