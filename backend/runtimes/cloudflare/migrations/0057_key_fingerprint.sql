-- ADR 0026 D6.1 — persist the non-secret fingerprint of the deployment's master
-- ENCRYPTION_KEY so boot can detect key drift (the key changing since secrets were sealed)
-- before any request touches a stale secret. A per-DEPLOYMENT SINGLETON row keyed by a
-- fixed id ('key'); seeded once on first boot and never overwritten. The fingerprint is a
-- one-way HKDF of the key (leaks nothing usable), so it is stored in the clear.
--
-- `key_fingerprint.fingerprint` — base64url(HKDF-SHA256(masterKey, "cat-factory:key-fingerprint")[:8]).
--
-- Mirrored on the Node facade by the Drizzle `key_fingerprint` table (runtime symmetry).

CREATE TABLE IF NOT EXISTS key_fingerprint (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
