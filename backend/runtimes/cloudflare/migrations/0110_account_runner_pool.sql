-- The ACCOUNT tier of the runner pool, and the board-side marker that stops a board inheriting it.
--
-- `account_runner_pools` has the shape of `runner_pool_connections`, keyed by account. The primary
-- key on `account_id` is what makes a deployment's seed a conflict-targeted insert-if-absent: two
-- concurrent seeders cannot both insert. No tombstone: nothing unregisters it through the API.
--
-- `inherit_account_runner_pool` on `workspace_settings` is the explicit "none" marker. 1 (the
-- default) lets a board with no live pool of its own fall back to its account's pool; 0 stops it.
CREATE TABLE account_runner_pools (
  account_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  config_json TEXT NOT NULL,
  secrets_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE workspace_settings ADD COLUMN inherit_account_runner_pool INTEGER NOT NULL DEFAULT 1;
