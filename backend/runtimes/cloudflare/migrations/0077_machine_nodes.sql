-- The machine-node roster + revocation tombstones (SEC-5 / security-hardening item 8).
-- One row per nodeId a mothership has minted a machine token for: recording the mint is
-- what makes "revoke MY node" checkable (without a roster a revoke endpoint either trusts
-- a caller-supplied nodeId or cannot exist). `revoked_at` is a tombstone consulted by the
-- shared machine gate on every /internal/* call; it is never cleared, and a revoked
-- node_id can never be re-minted. Rows past `expires_at` (the latest signed exp, which no
-- token for the node can outlive) are pruned by the retention sweep.
-- Mirrors the Node Drizzle `machineNodes` table (db/tables/identity.ts); keep in step.
CREATE TABLE machine_nodes (
  node_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_minted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE INDEX idx_machine_nodes_user ON machine_nodes (user_id);
CREATE INDEX idx_machine_nodes_expiry ON machine_nodes (expires_at);
